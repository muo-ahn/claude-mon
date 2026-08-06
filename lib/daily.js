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

function dailyFilePath(claudemonDir) {
  return path.join(claudemonDir, 'daily.json');
}

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
// evaluates - recursing through `all` (any depth) and the `and` 2-item
// alias - so validatePackTree can check them against KNOWN_CONDITION_TYPES
// without duplicating conditionMet's own traversal.
function conditionTypesIn(when) {
  if (when === null || when === undefined) return [];
  if (Array.isArray(when.all)) return when.all.flatMap(conditionTypesIn);
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
//
// failureRatio comes from global.json, which is a *lifetime* counter, so the
// dark trait moves slowly rather than day to day. Making it daily needs a
// per-day failure counter in hook.js - deliberately left for later rather
// than faked here.
function daySignals(claudemonDir, sessionTokens) {
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
  return {
    failureRatio,
    sessionCount: totals.length,
    topShare: sum > 0 ? Math.max(...totals) / sum : 0
  };
}

function activeTraits(signals) {
  const traits = [];
  if (signals.failureRatio >= 0.05) traits.push('dark');
  if (signals.sessionCount >= 5) traits.push('swarm');
  if (signals.topShare >= 0.6) traits.push('focus');
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

// Picks today's mon pack: a rotation keyed off dateKST so it's the same
// all day (idempotent) but changes as the date rolls over. Falls back to
// "guilmon" when no valid pack is found on disk.
//
// `avoidMon` is the pack the user last actually saw (see prevMon in
// computeDailyTokens). A well-mixed hash still lands on the same pack two
// days running about 1/N of the time, and from the outside a coincidental
// repeat is indistinguishable from the rotation being broken -- so when
// the draw collides we step to the next pack instead. Stepping (rather
// than re-hashing) keeps the pick deterministic and cheap, and stays
// idempotent because avoidMon is itself persisted rather than recomputed.
function selectMon(dateKST, packsDir, sharedDir, avoidMon) {
  const packs = listRotationPacks(packsDir, sharedDir);
  if (packs.length === 0) return 'guilmon';
  let index = hashString(dateKST) % packs.length;
  // With a single candidate there is nothing to step to; repeating it is
  // the only option.
  if (packs.length > 1 && packs[index] === avoidMon) {
    index = (index + 1) % packs.length;
  }
  return packs[index];
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
    return { dateKST: null, files: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { dateKST: parsed.dateKST || null, files: parsed.files || {} };
  } catch (e) {
    // Corrupt cache - start fresh rather than crash the 30s poll loop.
    return { dateKST: null, files: {} };
  }
}

function saveCache(claudemonDir, cache) {
  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(cacheFilePath(claudemonDir), JSON.stringify(cache, null, 2));
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

// Reads only the newly-appended bytes of `file` (from `fromOffset` onward),
// sums output_tokens of assistant entries whose top-level timestamp falls
// in [dayStartMs, dayEndMs), and returns how far the offset advanced.
//
// Assistant lines can appear duplicated (same message.id repeated across
// several transcript lines) - dedupe by message.id, keeping the max
// output_tokens seen for that id so a partial/streamed snapshot never
// suppresses the final value.
function scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs) {
  const stat = fs.statSync(file);
  if (stat.size <= fromOffset) {
    return { increment: 0, newOffset: fromOffset };
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
    return { increment: 0, newOffset: fromOffset };
  }
  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1; // + the newline itself
  const lines = complete.split('\n');

  const maxByMessageId = new Map();
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue; // malformed line - skip defensively
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
  for (const v of maxByMessageId.values()) increment += v;

  return { increment, newOffset: fromOffset + consumedBytes };
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
    // never re-parsed.
    for (const key of Object.keys(cache.files)) {
      cache.files[key].contribution = 0;
    }
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

    // A file untouched since before today's KST start can't contain any
    // of today's entries. Skip the read entirely; just remember the
    // offset so we never rescan it (until it's modified again).
    if (stat.mtimeMs < dayStartMs) {
      const offset = existing ? Math.max(existing.offset, 0) : stat.size;
      cache.files[file] = {
        offset: Math.min(offset, stat.size),
        contribution: existing ? existing.contribution || 0 : 0,
        mtimeMs: stat.mtimeMs
      };
      continue;
    }

    const fromOffset = existing ? existing.offset : 0;
    try {
      const { increment, newOffset } = scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs);
      cache.files[file] = {
        offset: newOffset,
        contribution: (existing ? existing.contribution || 0 : 0) + increment,
        mtimeMs: stat.mtimeMs
      };
    } catch (e) {
      // Unreadable this run (permissions, race) - keep prior cache entry.
      cache.files[file] = existing || { offset: 0, contribution: 0, mtimeMs: stat.mtimeMs };
    }
  }

  // Prune files that no longer exist on disk.
  for (const key of Object.keys(cache.files)) {
    if (!seenFiles.has(key)) delete cache.files[key];
  }

  // The cache is keyed by file path, so a session recorded under two
  // project directories sits in it twice with the same messages counted
  // in both entries. Fold by transcript identity keeping the largest
  // copy: a duplicate is a prefix of - at worst equal to - the fullest
  // copy, since both are appended from the same stream of turns.
  const byTranscript = new Map();
  for (const [file, entry] of Object.entries(cache.files)) {
    const contribution = entry.contribution || 0;
    if (!contribution) continue;
    const identity = transcriptKey(projectsDir, file);
    if (!identity) continue;
    const previous = byTranscript.get(identity.key);
    if (!previous || contribution > previous.contribution) {
      byTranscript.set(identity.key, { contribution, sessionId: identity.sessionId });
    }
  }

  // Total and per-session breakdown both come off that same fold, so
  // they can't disagree. Only sessions that actually consumed tokens
  // today appear, so the map stays small - and a subagent's transcript
  // rolls up into the session that spawned it rather than showing up as
  // a session of its own.
  let outputTokens = 0;
  const sessionTokens = {};
  for (const { contribution, sessionId } of byTranscript.values()) {
    outputTokens += contribution;
    sessionTokens[sessionId] = (sessionTokens[sessionId] || 0) + contribution;
  }

  saveCache(claudemonDir, cache);

  const stageState = { stageId: TREE.stages[0].id, dailyOutputTokens: outputTokens };
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

  // Today's branch through the pack's evolution tree. Pinned for the day the
  // same way `mon` is: once daily.json holds today's route it is reused, so a
  // mid-day rewrite can't re-roll the form under the user. Packs without a
  // tree get route: null and keep rendering from stageNames.
  const tree = readTree(packsDir, mon);
  const signals = daySignals(claudemonDir, sessionTokens);
  // traits is no longer what gates a branch (see selectRoute) - kept only as
  // a debug hint in daily.json for reading back "why this form today".
  const traits = activeTraits(signals);
  let route = null;
  if (tree) {
    const ctx = {
      dailyOutputTokens: outputTokens,
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
  dateKSTString,
  startOfDayKSTUtcMs,
  listJsonlFiles,
  transcriptKey,
  scanFileIncrement,
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
