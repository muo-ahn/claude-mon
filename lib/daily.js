const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyEvolution, TREE, conditionMet, KNOWN_CONDITION_TYPES } = require('./evolve');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultClaudemonDir() {
  return process.env.CLAUDEMON_DIR || path.join(os.homedir(), '.claude', 'claudemon');
}

function defaultProjectsDir() {
  return process.env.CLAUDEMON_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

function defaultPacksDir() {
  return path.join(__dirname, '..', 'sprites', 'packs');
}

function defaultSharedDir() {
  return path.join(__dirname, '..', 'sprites', 'shared');
}

function cacheFilePath(claudemonDir) {
  return path.join(claudemonDir, 'token-scan-cache.json');
}

// Bumped whenever a field is added to the cache that old cache data can't
// supply (e.g. userTurns in files[] entries, or the top-level `seen` map
// below). A version mismatch forces one full rescan rather than silently
// treating "field absent" as "field is zero/empty forever" for bytes that
// are gone from the scan window.
//
// 2 -> 3: added top-level `seen` (message.id -> max output_tokens observed
// today, across every file). Without it, an old cache's offsets already
// sit past the bytes that would have seeded `seen`, so those message ids
// would silently never dedupe against a duplicate copy encountered later.
const CACHE_VERSION = 3;

function dailyFilePath(claudemonDir) {
  return path.join(claudemonDir, 'daily.json');
}

function monHistoryFilePath(claudemonDir) {
  return path.join(claudemonDir, 'mon-history.json');
}

// Ring-buffer cap on mon-history.json's entries. This file is observational
// only (see recordMonHistory below) - it exists so a bias fix like the
// deck rotation above can be checked against real usage after the fact,
// not to drive any selection logic. 60 entries is about two months of
// daily picks, which is plenty for that purpose without letting the file
// grow forever.
const MON_HISTORY_MAX = 60;

// A directory under packsDir is a rotation candidate only if the menubar
// app could actually put it on screen:
//
//   - idle-0.png must exist. claudemon-menubar.swift refuses to switch to
//     a pack without one, so selecting such a "pack" silently leaves
//     yesterday's mon up instead of rotating.
//   - a Digi-Egg must be reachable: the pack's own digitama-0.png, or the
//     species-agnostic sprites/shared/digitama-0.png, mirroring the
//     menubar's sharedStages priority.
//
// Dot-directories are excluded outright -- sprites/packs/ is a plain
// directory and unrelated tooling drops state there (.omc/state did).
// Admitting a non-pack costs more than one wasted slot: it shifts the
// index of every name sorting after it, which is exactly the failure
// selectMon's hash finalizer also guards against.
//
// Sorted so the hash-based index in selectMon is stable regardless of
// directory listing order.
function listValidPacks(packsDir, sharedDir) {
  if (!fs.existsSync(packsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(packsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const hasSharedDigitama = fs.existsSync(path.join(sharedDir || defaultSharedDir(), 'digitama-0.png'));
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(packsDir, entry.name);
    if (!fs.existsSync(path.join(dir, 'idle-0.png'))) continue;
    if (!hasSharedDigitama && !fs.existsSync(path.join(dir, 'digitama-0.png'))) continue;
    packs.push(entry.name);
  }
  return packs.sort();
}

// The tree's last stage - what a mon has to be able to become to be worth
// putting into the rotation at all. Read off the tree rather than spelled
// out here, so adding a stage moves the bar with it.
function topStageId() {
  return TREE.stages[TREE.stages.length - 1].id;
}

// True when `<pack>/pack.json` names `stageId` in its evolution line.
// Absent pack.json, absent stageNames, or a blank name all read as "this
// line doesn't reach that stage".
function packDeclaresStage(packsDir, pack, stageId) {
  try {
    const raw = fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8');
    const names = JSON.parse(raw).stageNames;
    return Boolean(names && typeof names[stageId] === 'string' && names[stageId].trim());
  } catch (e) {
    return false; // missing or malformed pack.json - not a candidate
  }
}

// The daily rotation pool: valid packs whose evolution line actually
// reaches the top stage. A pack that tops out early would spend the
// heaviest days of the month stuck one stage below the ceiling, so it is
// held out of the rotation rather than shown with a stage it can't
// evolve into. Nothing else changes for it - it stays a valid pack, so an
// explicit selection or the guilmon fallback still renders it.
function listRotationPacks(packsDir, sharedDir) {
  const top = topStageId();
  return listValidPacks(packsDir, sharedDir).filter((pack) =>
    packDeclaresStage(packsDir, pack, top)
  );
}

// Deterministic string hash (no Math.random - the daily mon pick must be
// idempotent for repeated runs on the same KST date).
//
// The rolling h*31+c accumulation alone is not enough for date keys. Two
// dates one day apart differ by +1 in a single character, so their hashes
// differ by exactly +1 and `hash % packs.length` degenerates into walking
// the alphabetical pack list one step per day. That made the rotation
// brittle in a non-obvious way: introducing a candidate that sorts ahead
// of the rest shifts every index down by one, exactly cancelling the
// daily +1 and pinning the same mon across consecutive days (a stray
// sprites/packs/.omc did this, freezing two days on gabumon).
//
// The murmur3 fmix32 finalizer avalanches neighbouring inputs apart, so
// consecutive dates land on unrelated indices and the pick no longer
// depends on where a new pack happens to sort.
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

// Normalizes one node's outgoing edges to `evolutions: [{ to, when }]`. The
// legacy `next: [nodeId]` shape carries no condition, so every entry becomes
// an unconditional edge; `evolutions`, if the node already declares it, wins
// outright. This is the single place that gap gets closed - selectRoute only
// ever sees the normalized shape.
function normalizeNode(node) {
  if (Array.isArray(node.evolutions)) return node;
  const next = Array.isArray(node.next) ? node.next : [];
  return { ...node, evolutions: next.map((to) => ({ to, when: null })) };
}

// Reads a pack's branching evolution tree (pack.json "tree"): stage id ->
// array of nodes, each { id, name, sprite, evolutions: [{to, when}] } after
// normalization (raw files may still use the legacy `next: [nodeId]` shape).
// The FIRST node of every stage is that stage's spine - the form the pack
// shows when nothing steers it elsewhere.
function readTree(packsDir, pack) {
  try {
    const raw = fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8');
    const tree = JSON.parse(raw).tree;
    if (!tree || typeof tree !== 'object') return null;
    for (const stage of TREE.stages) {
      if (!Array.isArray(tree[stage.id]) || tree[stage.id].length === 0) return null;
    }
    const normalized = {};
    for (const stageId of Object.keys(tree)) {
      normalized[stageId] = tree[stageId].map(normalizeNode);
    }
    return normalized;
  } catch (e) {
    return null; // no tree (or malformed) - caller falls back to stageNames
  }
}

// Flattens one edge's `when` into the leaf condition `type`s it actually
// evaluates - recursing through `all`/`any` (any depth) and the `and`
// 2-item alias - so validatePackTree can check them against
// KNOWN_CONDITION_TYPES without duplicating conditionMet's own traversal.
function conditionTypesIn(when) {
  if (when === null || when === undefined) return [];
  if (Array.isArray(when.all)) return when.all.flatMap(conditionTypesIn);
  if (Array.isArray(when.any)) return when.any.flatMap(conditionTypesIn);
  const types = [when.type];
  if (when.and) types.push(...conditionTypesIn(when.and));
  return types;
}

// Checks a normalized tree (readTree's return shape) against the data
// contract selectRoute/candidatesFor lean on but never enforce at runtime
// (decision E - the runtime stays lenient; strictness lives here instead,
// for tests and scripts/build-evolution-map.js to call). Returns a list of
// violations, empty when the tree is valid. Never throws, so it is safe to
// run over every shipped pack without tripping the same silent-failure
// hazard it exists to catch.
//
//   missing-unconditional-edge - a non-top node whose last (or only) edge
//     isn't `when: null`/undefined, so nothing guarantees it ever reaches
//     the top stage (decision C).
//   unknown-target             - an edge's `to` isn't any declared node id.
//   stage-skip                 - an edge's `to` exists, but not in the very
//     next declared stage. byId spans every stage the same way
//     candidatesFor's does, so a skip like this would otherwise resolve
//     silently into the wrong stage's slot (plan §9 pitfall 2) instead of
//     failing loudly.
//   unknown-condition-type     - an edge's `when` (or a leaf nested under
//     `all`/`and`) names a `type` checkCondition doesn't implement, which
//     would otherwise fail closed forever (plan §9 pitfall 4).
function validatePackTree(tree) {
  const violations = [];
  const stages = TREE.stages.map((s) => s.id).filter((id) => Array.isArray(tree[id]) && tree[id].length > 0);
  const topStage = stages[stages.length - 1];
  const byId = new Map();
  for (const stage of stages) for (const n of tree[stage]) byId.set(n.id, n);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (stage === topStage) continue; // rule 5: top-stage nodes pass with no edges
    const nextStage = stages[i + 1];
    for (const node of tree[stage]) {
      const edges = Array.isArray(node.evolutions) ? node.evolutions : [];
      const last = edges[edges.length - 1];
      if (!last || (last.when !== null && last.when !== undefined)) {
        violations.push({ rule: 'missing-unconditional-edge', stage, node: node.id });
      }
      for (const edge of edges) {
        if (!byId.has(edge.to)) {
          violations.push({ rule: 'unknown-target', stage, node: node.id, to: edge.to });
        } else if (!tree[nextStage].some((n) => n.id === edge.to)) {
          violations.push({ rule: 'stage-skip', stage, node: node.id, to: edge.to });
        }
        for (const condType of conditionTypesIn(edge.when)) {
          if (!KNOWN_CONDITION_TYPES.includes(condType)) {
            violations.push({ rule: 'unknown-condition-type', stage, node: node.id, condType });
          }
        }
      }
    }
  }
  return violations;
}

// "성장 배경" signals for the day, read off what claudemon already records.
// Digimon canon has the same species branch differently depending on how it
// was raised; these are the closest things this app knows about how the day
// was spent.
//
//   dark  - a day with tool calls failing (globally cumulative, see below)
//   swarm - many sessions running side by side
//   focus - one session carrying most of the day's output
//   userTurns / outputPerTurn - a "설계 날" (design day) shows up as many
//     real user prompts (isRealUserTurn) but comparatively little assistant
//     output per turn - lots of discussion, not much generation.
//
// failureRatio comes from global.json, which is a *lifetime* counter, so the
// dark trait moves slowly rather than day to day. Making it daily needs a
// per-day failure counter in hook.js - deliberately left for later rather
// than faked here.
function daySignals(claudemonDir, sessionTokens, dailyUserTurns, dailyOutputTokens) {
  const totals = Object.values(sessionTokens || {});
  const sum = totals.reduce((a, b) => a + b, 0);
  let failureRatio = 0;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(claudemonDir, 'global.json'), 'utf8'));
    const ok = g.toolSuccessCount || 0;
    const bad = g.toolFailureCount || 0;
    if (ok + bad > 0) failureRatio = bad / (ok + bad);
  } catch (e) {
    /* no global state yet - leave at 0 */
  }
  const userTurns = dailyUserTurns || 0;
  return {
    failureRatio,
    sessionCount: totals.length,
    topShare: sum > 0 ? Math.max(...totals) / sum : 0,
    userTurns,
    outputPerTurn: (dailyOutputTokens || 0) / Math.max(1, userTurns)
  };
}

function activeTraits(signals) {
  const traits = [];
  if (signals.failureRatio >= 0.05) traits.push('dark');
  if (signals.sessionCount >= 5) traits.push('swarm');
  if (signals.topShare >= 0.6) traits.push('focus');
  if ((signals.userTurns || 0) >= 80 && (signals.outputPerTurn || 0) <= 6000) traits.push('sage');
  return traits;
}

// Resolves `node`'s outgoing evolutions into the pool `pick` draws from.
// Edges are checked in declaration order (priority); the first one whose
// `when` is met sets the day's winning condition, and every edge sharing
// that exact condition joins the pool, so a pack can list two destinations
// under one gate and let the day's hash break the tie. Zero edges met is a
// data violation - the last declared edge should always be `when: null` -
// but conditionMet never throws on its own, so this can only happen if a
// pack omits that guaranteed edge; the fallback is the full edge list
// rather than stalling the day (see selectRoute's doc comment, and the
// `validatePackTree` check this data contract earns in a later commit).
function candidatesFor(node, ctx, byId, fallback) {
  const edges = Array.isArray(node.evolutions) ? node.evolutions : [];
  if (edges.length === 0) return [fallback];
  const met = edges.filter((e) => conditionMet(e.when, ctx));
  const pool = met.length > 0 ? met : edges;
  const winner = JSON.stringify(pool[0].when);
  const tied = pool.filter((e) => JSON.stringify(e.when) === winner);
  const nodes = tied.map((e) => byId.get(e.to)).filter(Boolean);
  return nodes.length > 0 ? nodes : [fallback]; // dangling `to` - don't stall the day
}

// Draws one node from `candidates` for `stage`. The draw is
// hashString(dateKST + pack + stage), so it is stable all day and unrelated
// between neighbouring days (see hashString).
function pick(dateKST, pack, stage, candidates) {
  const index = hashString(`${dateKST}|${pack}|${stage}`) % candidates.length;
  return candidates[index];
}

// Walks `stages` top to bottom, applying `locked` (see selectRoute's doc
// comment for what it does). Returns one node per stage.
function walk(dateKST, pack, tree, ctx, byId, stages, locked, lockedThroughIdx) {
  const route = {};
  let current = null;
  // Once a locked stage fails to line up with the current tree, every
  // stage from there on falls back to a normal draw - the locked chain is
  // broken, so there is nothing left to pin against.
  let lockedActive = Boolean(locked);
  for (const stage of stages) {
    if (lockedActive && TREE.stages.findIndex((s) => s.id === stage) <= lockedThroughIdx) {
      const lockedEntry = locked.route && locked.route[stage];
      const node = lockedEntry && byId.get(lockedEntry.id);
      if (node) {
        route[stage] = { id: node.id, name: node.name, sprite: node.sprite };
        current = node;
        continue;
      }
      lockedActive = false; // degrade: tree moved under the locked route
    }
    const candidates = current ? candidatesFor(current, ctx, byId, tree[stage][0]) : tree[stage];
    const node = pick(dateKST, pack, stage, candidates);
    route[stage] = { id: node.id, name: node.name, sprite: node.sprite };
    current = node;
  }
  return route;
}

// Walks the pack's tree from the egg down to the top stage and returns one
// node per stage: { id, name, sprite } keyed by stage id.
//
// Branching is a condition gate, not luck: each node's `evolutions` list is
// checked in order and the first edge whose `when` is met wins (ties broken
// by the day's hash - see candidatesFor). `ctx` carries today's signals
// (dailyOutputTokens, sessionCount, topSharePct, failureRatioPct, global -
// see lib/evolve.js checkCondition for what each type reads). Reaching the
// top stage is a data contract, not code: every non-top node's last edge
// must be `when: null` (validated separately), so there is no "spine
// return" here to fall back on a dead end.
//
// `locked` implements lazy binding: `{ route, throughStage }` pins every
// stage up to and including `throughStage` (the stage the mon has actually
// reached today) to whatever `route` already had there, and only redraws
// the stages above it against today's ctx. That is what lets a signal
// earned mid-day (e.g. sessionCount, which can't hit 5 in the first seconds
// of the day) still steer a branch the mon hasn't reached yet, while the
// form on screen right now never flickers. If the locked route doesn't line
// up with the current tree (the tree changed since it was pinned - see the
// 라이즈그레이몬/샤인그레이몬 case), that stage and everything after it
// degrades to a normal draw instead of throwing.
function selectRoute(dateKST, pack, tree, ctx, locked) {
  // A pack's tree may stop short of the global stage list: a lineage whose top
  // form has no usable sprite declares only the stages it can actually render
  // and sits out the rotation (see README "로테이션 후보 요건" -- 가오몬 tops out
  // at 궁극체). Such a pack is still selectable explicitly, and walking a stage
  // its tree doesn't declare used to throw on `tree[stage]` being undefined,
  // taking daily-tokens.js -- and with it all token tracking -- down with it.
  // So the walk covers only the stages actually present.
  const stages = TREE.stages
    .map((s) => s.id)
    .filter((id) => Array.isArray(tree[id]) && tree[id].length > 0);
  const byId = new Map();
  for (const stage of stages) for (const n of tree[stage]) byId.set(n.id, n);

  // Global index of `locked.throughStage`, so "is this stage locked" is a
  // position check against TREE.stages rather than against `stages` (the
  // pack-local, possibly-truncated list) - a pack that stops short of the
  // top stage still locks correctly relative to the full ladder.
  const lockedThroughIdx = locked ? TREE.stages.findIndex((s) => s.id === locked.throughStage) : -1;

  return walk(dateKST, pack, tree, ctx, byId, stages, locked, lockedThroughIdx);
}

// Epoch the shuffled-deck rotation counts cycles from (see selectMon
// below). Fixed rather than derived from "whenever this code first ran"
// so dayIndex/cycle/pos are reproducible from dateKST alone, on any
// machine, forever.
const MON_DECK_EPOCH_KST = '2026-01-01';

// Deterministic 32-bit PRNG (mulberry32) - only ever used to shuffle the
// deck in selectMon, never Math.random. Math.random would break the
// "same KST date always picks the same mon" invariant this file already
// relies on (see hashString's doc comment above and selectRoute's use of
// it): a second run on the same day would reshuffle differently and the
// on-screen mon would flicker mid-day.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded Fisher-Yates. Returns a new array; `pool` (the name-sorted
// rotation pool from listRotationPacks) is left untouched so the same
// pool can be reshuffled with a different seed for another cycle.
function shuffleDeck(pool, seed) {
  const deck = pool.slice();
  const rand = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Picks today's mon pack: a shuffled-deck rotation keyed off dateKST so
// it's the same all day (idempotent) but changes as the date rolls over.
// Falls back to "guilmon" when no valid pack is found on disk.
//
// Why a deck instead of the old `hash % N` draw: straight modulo residues
// aren't uniform draw-to-draw, so a pack's long-run appearance frequency
// could drift up to 2x from the mean (measured over 90 real days across
// 9 packs: keramon appeared 18 times, veemon 6, expected value 10 each).
// A shuffled deck sidesteps that structurally - every pack occupies
// exactly one slot per N-day deck, so a full cycle sees each pack exactly
// once and there is no long-run drift left to measure.
//
// - `dayIndex` counts days since MON_DECK_EPOCH_KST and can go negative
//   for dates before it.
// - `cycle`/`pos` are a floor-division split of dayIndex by N (pack
//   count), so pos always lands in [0, N) even when dayIndex is negative
//   (JS's `%` would instead return a negative remainder for a negative
//   dayIndex, which is why this uses floor division by hand rather than
//   `%` directly).
// - Each cycle's deck is listRotationPacks's name-sorted pool shuffled
//   with a seed derived from `${cycle}|${N}`. Folding N into the seed
//   means adding or removing a pack reshuffles every future cycle's deck
//   from scratch, rather than a pack quietly inheriting the slot it would
//   have had in a differently-sized pool it was never actually shuffled
//   against.
//
// Guaranteed: each pack appears exactly once within a given N-day cycle,
// and (via the avoidMon guard below) never on two consecutive days.
// Not guaranteed: a minimum gap between any two appearances of the same
// pack. Cycle k's last slot and cycle k+1's first slot come from
// independent shuffles, so the same pack can land in both, producing a
// 2-3 day gap across a cycle boundary instead of a full cycle's worth.
//
// `avoidMon` is the pack the user last actually saw (see prevMon in
// computeDailyTokens). It can collide with today's natural deck slot at
// a cycle boundary (above) or because the user manually overwrote
// daily.json's mon mid-cycle to something the deck didn't schedule for
// today - either way, stepping to the next deck slot instead of
// re-shuffling keeps the pick deterministic and cheap, and stays
// idempotent because avoidMon is itself persisted rather than recomputed.
function selectMon(dateKST, packsDir, sharedDir, avoidMon) {
  const packs = listRotationPacks(packsDir, sharedDir);
  const N = packs.length;
  if (N === 0) return 'guilmon';
  // Nothing to step to with a single candidate, and no deck worth
  // building for one slot; repeating it is the only option.
  if (N === 1) return packs[0];

  const dayIndex = Math.round(
    (startOfDayKSTUtcMs(dateKST) - startOfDayKSTUtcMs(MON_DECK_EPOCH_KST)) / DAY_MS
  );
  const cycle = Math.floor(dayIndex / N);
  const pos = dayIndex - cycle * N;

  const deck = shuffleDeck(packs, hashString(`${cycle}|${N}`));

  let index = pos;
  if (deck[index] === avoidMon) {
    index = (index + 1) % N;
  }
  return deck[index];
}

// Reads daily.json and returns its parsed contents, whatever date it
// carries, or null if absent/corrupt. The record left behind by the
// previous run serves two purposes: if its dateKST is today's it pins the
// already-chosen mon for the rest of the day (so a pack appearing on disk
// mid-day can't swap the sprite out underfoot), and if it is older its
// `mon` is the last pack the user actually saw -- what the repeat guard
// in selectMon steers away from.
function readDaily(claudemonDir) {
  const file = dailyFilePath(claudemonDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const MON_HISTORY_VERSION = 1;

// Reads mon-history.json's { version, entries } (entries oldest -> newest).
// Missing file, unparsable JSON, and a version mismatch all degrade the
// same way loadCache does for token-scan-cache.json: silently return an
// empty history rather than throw, since this file only ever feeds an
// after-the-fact look at rotation bias, never a selection decision.
function readMonHistory(claudemonDir) {
  const file = monHistoryFilePath(claudemonDir);
  if (!fs.existsSync(file)) return { version: MON_HISTORY_VERSION, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== MON_HISTORY_VERSION || !Array.isArray(parsed.entries)) {
      return { version: MON_HISTORY_VERSION, entries: [] };
    }
    return { version: MON_HISTORY_VERSION, entries: parsed.entries };
  } catch (e) {
    return { version: MON_HISTORY_VERSION, entries: [] };
  }
}

// Appends today's pick to mon-history.json, an observational log of what
// selectMon actually returned each day (never consulted by selectMon's
// own avoidMon guard - that still reads prevMon off daily.json exactly as
// before). computeDailyTokens calls this on every ~30s poll, so the
// common case - same date, same mon as the last entry - has to be a
// no-op with zero file I/O rather than a rewrite every poll.
//
//   - same date, same mon as the last entry: return immediately, no I/O.
//   - same date, different mon (a manual daily.json override mid-day):
//     update that last entry in place rather than appending, so one day
//     never produces two rows.
//   - different date: append a new entry and trim the ring buffer down
//     to MON_HISTORY_MAX from the front (oldest entries drop first).
function recordMonHistory(claudemonDir, dateKST, mon) {
  const history = readMonHistory(claudemonDir);
  const last = history.entries[history.entries.length - 1];

  if (last && last.date === dateKST && last.mon === mon) return;

  if (last && last.date === dateKST) {
    last.mon = mon;
  } else {
    history.entries.push({ date: dateKST, mon });
    if (history.entries.length > MON_HISTORY_MAX) {
      history.entries = history.entries.slice(history.entries.length - MON_HISTORY_MAX);
    }
  }

  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(monHistoryFilePath(claudemonDir), JSON.stringify(history, null, 2));
}

// KST has no DST, so a fixed +9h offset is always correct.
function dateKSTString(date) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

// UTC instant of 00:00:00 KST for the given YYYY-MM-DD date string.
function startOfDayKSTUtcMs(dateKST) {
  return new Date(`${dateKST}T00:00:00+09:00`).getTime();
}

function loadCache(claudemonDir) {
  const file = cacheFilePath(claudemonDir);
  if (!fs.existsSync(file)) {
    return { dateKST: null, files: {}, seen: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION) {
      // Old cache shape - it's missing a field this version relies on
      // (files[].userTurns, or the top-level seen map), and there is no
      // way to backfill that from an offset alone. Dropping the whole
      // cache (same as "file missing") forces one full rescan from byte 0
      // of every transcript, after which the new version is saved and
      // every later run is incremental again.
      return { dateKST: null, files: {}, seen: {} };
    }
    return { dateKST: parsed.dateKST || null, files: parsed.files || {}, seen: parsed.seen || {} };
  } catch (e) {
    // Corrupt cache - start fresh rather than crash the 30s poll loop.
    return { dateKST: null, files: {}, seen: {} };
  }
}

function saveCache(claudemonDir, cache) {
  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(
    cacheFilePath(claudemonDir),
    JSON.stringify({ ...cache, version: CACHE_VERSION }, null, 2)
  );
}

// Every .jsonl at any depth inside a project directory. A project holds
// `<session>.jsonl` for the main conversation plus
// `<session>/subagents/agent-<id>.jsonl` for each subagent it spawned;
// a subagent's turns appear only in its own nested file, so a one-level
// listing silently drops every token any subagent produced.
function listJsonlFiles(projectsDir) {
  const results = [];
  if (!fs.existsSync(projectsDir)) return results;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    collectJsonlFiles(path.join(projectsDir, entry.name), results);
  }
  return results;
}

// Recursive half of listJsonlFiles. isDirectory() is false for symlinks,
// so a link pointing back up the tree can't send this into a loop.
function collectJsonlFiles(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable subtree - skip it, not the whole scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
}

// Identifies a transcript independently of which project directory it
// was filed under, because one session can be recorded under two of them
// at once: the same repo reached through its real path and through a
// worktree or symlink path produces two `-Users-...` directories, and
// Claude Code writes the session into both. The copies repeat each
// other's messages verbatim, so counting per file counts them twice.
//
// Everything below the project directory is stable across those
// spellings, so it is what names one transcript. Returns null for a path
// that isn't inside a project directory (nothing to group it by).
function transcriptKey(projectsDir, file) {
  const rel = path.relative(projectsDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const withinProject = parts.slice(1);
  return {
    key: withinProject.join('/'),
    // `<session>.jsonl` for a main transcript, `<session>` for the
    // directory holding its subagent transcripts - either way the first
    // segment names the session whose work these tokens are.
    sessionId: withinProject[0].replace(/\.jsonl$/, '')
  };
}

// True for a transcript line that is a genuine human prompt, as opposed
// to a tool result (also filed as `type: "user"` in Claude Code's JSONL
// format), a meta/system-injected entry, or an empty/slash-command shell.
// This is the "대화 밀도" signal a 설계 날 (design day) is detected from:
// lots of these with comparatively little assistant output.
function isRealUserTurn(entry) {
  if (!entry || entry.type !== 'user') return false;
  const message = entry.message;
  if (!message || message.role !== 'user') return false;
  if (entry.toolUseResult) return false;
  if (entry.isMeta) return false;
  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('<local-command')) return false;
    if (trimmed.startsWith('Caveat')) return false;
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => block && block.type === 'text');
  }
  return false;
}

// A subagent's transcript holds the prompt its parent injected to spawn
// it, filed as an ordinary `type: "user"` entry indistinguishable from a
// real human turn by shape alone (see isRealUserTurn) - only the file's
// own path (`<session>/subagents/agent-<id>.jsonl`, see listJsonlFiles)
// says it isn't one.
function isSubagentTranscript(file) {
  return file.split(path.sep).includes('subagents');
}

// Reads only the newly-appended bytes of `file` (from `fromOffset` onward),
// sums output_tokens of assistant entries whose top-level timestamp falls
// in [dayStartMs, dayEndMs), and returns how far the offset advanced. When
// `countUserTurns` is true (the file isn't a subagent transcript - see
// isSubagentTranscript), also counts real user turns (isRealUserTurn) in
// the same window, for the userTurns signal.
//
// Assistant lines can appear duplicated (same message.id repeated across
// several transcript lines within this same increment) - dedupe locally
// first, keeping the max output_tokens seen for that id so a
// partial/streamed snapshot never suppresses the final value.
//
// That local max is then reconciled against `seen` - the *global*,
// cross-file, cross-call map of message.id -> highest output_tokens
// counted for it today (persisted on the cache; see computeDailyTokens).
// Only the amount above what `seen` already recorded is added to this
// call's increment, and `seen` is bumped to match. This is what makes the
// scan immune to two ways the same tokens used to get double-counted:
//
//   - a continued/forked subagent transcript that copies its parent's
//     lines verbatim into a new file - the copy's message ids are already
//     in `seen` at the same value, so its increment is 0 for every shared
//     line, no matter which file the scan visits first.
//   - a message.id whose lines straddle two separate incremental scans
//     (a partial value flushed and counted, then the final value arrives
//     in a later increment) - `seen` remembers the partial, so only the
//     genuine increase over it is added the second time, instead of
//     counting the final value on top of the partial.
function scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs, countUserTurns, seen) {
  const stat = fs.statSync(file);
  if (stat.size <= fromOffset) {
    return { increment: 0, newOffset: fromOffset, userTurnIncrement: 0 };
  }

  const length = stat.size - fromOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, fromOffset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line landed yet - don't advance the offset past a
    // partially-written line.
    return { increment: 0, newOffset: fromOffset, userTurnIncrement: 0 };
  }
  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1; // + the newline itself
  const lines = complete.split('\n');

  const maxByMessageId = new Map();
  let userTurnIncrement = 0;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue; // malformed line - skip defensively
    }

    if (countUserTurns && isRealUserTurn(entry)) {
      const userTs = entry.timestamp;
      const userTsMs = userTs ? Date.parse(userTs) : NaN;
      if (!Number.isNaN(userTsMs) && userTsMs >= dayStartMs && userTsMs < dayEndMs) {
        userTurnIncrement += 1;
      }
    }

    const message = entry && entry.message;
    if (!message || message.role !== 'assistant') continue;
    const outputTokens = message.usage && message.usage.output_tokens;
    if (typeof outputTokens !== 'number') continue;
    const ts = entry.timestamp;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs < dayStartMs || tsMs >= dayEndMs) continue;

    const key = message.id || entry.uuid;
    const prev = maxByMessageId.get(key) || 0;
    if (outputTokens > prev) maxByMessageId.set(key, outputTokens);
  }

  let increment = 0;
  for (const [key, localMax] of maxByMessageId.entries()) {
    const alreadySeen = seen[key] || 0;
    if (localMax > alreadySeen) {
      increment += localMax - alreadySeen;
      seen[key] = localMax;
    }
  }

  return { increment, newOffset: fromOffset + consumedBytes, userTurnIncrement };
}

// Scans every transcript under `projectsDir`, incrementally (via the
// on-disk cache under `claudemonDir`), and returns today's (KST) total
// output token count plus the evolution stage it maps to.
function computeDailyTokens(now = new Date(), options = {}) {
  const claudemonDir = options.claudemonDir || defaultClaudemonDir();
  const projectsDir = options.projectsDir || defaultProjectsDir();
  const packsDir = options.packsDir || defaultPacksDir();
  const sharedDir = options.sharedDir || defaultSharedDir();

  const dateKST = dateKSTString(now);
  const dayStartMs = startOfDayKSTUtcMs(dateKST);
  const dayEndMs = dayStartMs + DAY_MS;

  const cache = loadCache(claudemonDir);
  if (cache.dateKST !== dateKST) {
    // Rolled over to a new KST day (or first run ever): the daily total
    // resets to 0, but file offsets are kept so already-read bytes are
    // never re-parsed. `seen` resets too - it only exists to dedupe
    // *today's* message ids, and yesterday's ids must not suppress
    // tomorrow's tokens if an id were ever (implausibly) reused.
    for (const key of Object.keys(cache.files)) {
      cache.files[key].contribution = 0;
      cache.files[key].userTurns = 0;
    }
    cache.seen = {};
    cache.dateKST = dateKST;
  }

  const files = listJsonlFiles(projectsDir);
  const seenFiles = new Set();

  for (const file of files) {
    seenFiles.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      continue; // race with deletion - ignore this run
    }
    const existing = cache.files[file];
    const countUserTurns = !isSubagentTranscript(file);

    // A file untouched since before today's KST start can't contain any
    // of today's entries. Skip the read entirely; just remember the
    // offset so we never rescan it (until it's modified again).
    if (stat.mtimeMs < dayStartMs) {
      const offset = existing ? Math.max(existing.offset, 0) : stat.size;
      cache.files[file] = {
        offset: Math.min(offset, stat.size),
        contribution: existing ? existing.contribution || 0 : 0,
        userTurns: existing ? existing.userTurns || 0 : 0,
        mtimeMs: stat.mtimeMs
      };
      continue;
    }

    const fromOffset = existing ? existing.offset : 0;
    try {
      const { increment, newOffset, userTurnIncrement } =
        scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs, countUserTurns, cache.seen);
      cache.files[file] = {
        offset: newOffset,
        contribution: (existing ? existing.contribution || 0 : 0) + increment,
        userTurns: (existing ? existing.userTurns || 0 : 0) + userTurnIncrement,
        mtimeMs: stat.mtimeMs
      };
    } catch (e) {
      // Unreadable this run (permissions, race) - keep prior cache entry.
      cache.files[file] = existing || { offset: 0, contribution: 0, userTurns: 0, mtimeMs: stat.mtimeMs };
    }
  }

  // Prune files that no longer exist on disk.
  for (const key of Object.keys(cache.files)) {
    if (!seenFiles.has(key)) delete cache.files[key];
  }

  // contribution is now safe to sum straight across every file: cache.seen
  // (threaded through scanFileIncrement above) already guarantees each
  // message.id was only ever added to *one* file's contribution, no matter
  // how many copies of it exist on disk (subagent-copy or dual-project-dir
  // duplicates alike - see scanFileIncrement's doc comment). Summing per
  // transcriptKey.sessionId rolls a subagent's transcript into the session
  // that spawned it, same as before.
  let outputTokens = 0;
  const sessionTokens = {};
  for (const [file, entry] of Object.entries(cache.files)) {
    const contribution = entry.contribution || 0;
    if (!contribution) continue;
    const identity = transcriptKey(projectsDir, file);
    if (!identity) continue;
    outputTokens += contribution;
    sessionTokens[identity.sessionId] = (sessionTokens[identity.sessionId] || 0) + contribution;
  }

  // userTurns has no per-entry id to dedupe by (isRealUserTurn lines carry
  // no message.id), so a session recorded under two project directories
  // still counts each real prompt twice unless folded here - keep the old
  // max-fold, keyed by transcript identity, for this field alone.
  const userTurnsByTranscript = new Map();
  for (const [file, entry] of Object.entries(cache.files)) {
    const userTurns = entry.userTurns || 0;
    if (!userTurns) continue;
    const identity = transcriptKey(projectsDir, file);
    if (!identity) continue;
    const previous = userTurnsByTranscript.get(identity.key) || 0;
    if (userTurns > previous) userTurnsByTranscript.set(identity.key, userTurns);
  }
  let dailyUserTurns = 0;
  for (const v of userTurnsByTranscript.values()) dailyUserTurns += v;

  saveCache(claudemonDir, cache);

  // Signals computed before stage progression: the sage-day stage gates
  // (evolution-tree.json's `any` conditions) need outputPerTurn/
  // dailyUserTurns exactly like dailyOutputTokens does, so applyEvolution's
  // ctx has to carry them too.
  const signals = daySignals(claudemonDir, sessionTokens, dailyUserTurns, outputTokens);
  // traits is no longer what gates a branch (see selectRoute) - kept only as
  // a debug hint in daily.json for reading back "why this form today".
  const traits = activeTraits(signals);

  const stageState = {
    stageId: TREE.stages[0].id,
    dailyOutputTokens: outputTokens,
    dailyUserTurns,
    outputPerTurn: signals.outputPerTurn
  };
  applyEvolution(stageState, {});

  // Today's pick, and the pack shown on whichever day ran last. Both are
  // persisted: prevMon has to survive the ~30s rewrites that happen all
  // day long, otherwise tomorrow's guard would compare against nothing.
  const previous = readDaily(claudemonDir);
  let mon;
  let prevMon;
  if (previous && previous.dateKST === dateKST && previous.mon) {
    mon = previous.mon;
    prevMon = previous.prevMon || null;
  } else {
    prevMon = (previous && previous.mon) || null;
    mon = selectMon(dateKST, packsDir, sharedDir, prevMon);
  }

  // Observational only - a history write failure must never break
  // daily.json's own write or the 30s poll loop it runs inside.
  try {
    recordMonHistory(claudemonDir, dateKST, mon);
  } catch (e) {
    // ignore - see comment above
  }

  // Today's branch through the pack's evolution tree. Pinned for the day the
  // same way `mon` is: once daily.json holds today's route it is reused, so a
  // mid-day rewrite can't re-roll the form under the user. Packs without a
  // tree get route: null and keep rendering from stageNames.
  const tree = readTree(packsDir, mon);
  let route = null;
  if (tree) {
    const ctx = {
      dailyOutputTokens: outputTokens,
      dailyUserTurns,
      outputPerTurn: signals.outputPerTurn,
      sessionCount: signals.sessionCount,
      topSharePct: signals.topShare * 100,
      failureRatioPct: signals.failureRatio * 100,
      global: {}
    };
    // Lazy binding: a route pinned earlier today is re-walked every run
    // rather than reused verbatim. selectRoute pins the stages already
    // reached (through stageState.stageId) to what daily.json already
    // had and only re-draws the stages still ahead against today's ctx -
    // see selectRoute's `locked` param. That is what lets a signal like
    // sessionCount, which can't hit its threshold in the first seconds of
    // the day, still steer a branch the mon hasn't reached yet without the
    // on-screen form ever flickering.
    const pinned = previous && previous.dateKST === dateKST && previous.mon === mon && previous.route
      ? previous.route
      : null;
    route = selectRoute(dateKST, mon, tree, ctx,
                        pinned ? { route: pinned, throughStage: stageState.stageId } : null);
  }

  const result = {
    dateKST,
    outputTokens,
    stageId: stageState.stageId,
    mon,
    prevMon,
    route,
    traits,
    sessionTokens,
    dailyUserTurns,
    outputPerTurn: signals.outputPerTurn,
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(dailyFilePath(claudemonDir), JSON.stringify(result, null, 2));

  return result;
}

module.exports = {
  computeDailyTokens,
  defaultClaudemonDir,
  defaultProjectsDir,
  defaultPacksDir,
  defaultSharedDir,
  cacheFilePath,
  dailyFilePath,
  monHistoryFilePath,
  readMonHistory,
  recordMonHistory,
  MON_HISTORY_MAX,
  dateKSTString,
  startOfDayKSTUtcMs,
  listJsonlFiles,
  transcriptKey,
  scanFileIncrement,
  isRealUserTurn,
  isSubagentTranscript,
  listValidPacks,
  listRotationPacks,
  packDeclaresStage,
  topStageId,
  hashString,
  selectMon,
  readTree,
  daySignals,
  activeTraits,
  selectRoute,
  validatePackTree,
  normalizeNode
};
