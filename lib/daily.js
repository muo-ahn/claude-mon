const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyEvolution, TREE } = require('./evolve');

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

// The lowest stage a route is allowed to end on.
//
// R2 used to demand that every route reach the pack's own ceiling, which made
// the rotation depend on having a 합체/모드체인지 form: only 19 of the game's
// ~420 forms are one, so nine tenths of the roster could never be drawn no
// matter how many dots were ripped. That bar bought very little -- a line that
// tops out at 궁극체 just doesn't evolve again past 2M, which is one stage
// missing on the rare heaviest days.
//
// 완전기 is a different story: a mon stuck there is visibly two stages behind
// for the whole day, so the floor stays at 궁극체 rather than disappearing.
function minCeilingId() {
  return 'ultimate';
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

// The ceiling a pack claims for itself, as a stage id.
//
// Two different things used to look identical from here: a line still being
// built (the sprite sheet for its top form hasn't been ripped yet) and a
// line that is finished and simply shorter. 사쿠야몬 and 세인트가르고몬 have
// no 합체/모드체인지 form in canon, so no amount of work will give those
// packs a `superultimate` - while 베르제브몬 블래스트 모드 does exist and
// impmon is merely waiting on its dots.
//
// `"topStage": "<stageId>"` in pack.json is how a pack says how far its line
// actually goes. It caps the walk so a short line never reaches for a stage
// it doesn't have; it is no longer what decides rotation eligibility (that is
// minCeilingId now), so declaring it costs a pack nothing.
function packTopStage(packsDir, pack) {
  const global = topStageId();
  let declared;
  try {
    const raw = fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8');
    declared = JSON.parse(raw).topStage;
  } catch (e) {
    return global; // missing or malformed pack.json - hold it to the full tree
  }
  if (typeof declared !== 'string') return global;
  const known = TREE.stages.some((s) => s.id === declared);
  return known ? declared : global;
}

// The daily rotation pool: valid packs whose line reaches at least the
// minimum ceiling (see minCeilingId). Tying this to the pack's own declared
// ceiling instead meant a pack was benched for lacking a 합체/모드체인지
// form, which is a property of the source game's roster rather than of how
// complete the pack is. A pack that stops at 궁극체 is in the rotation and
// simply stops evolving past 2M.
//
// Still excluded: a line that doesn't even name 궁극체. Such a mon would sit
// two or more stages below the ceiling all day, which reads as broken rather
// than as a short line.
function listRotationPacks(packsDir, sharedDir) {
  return listValidPacks(packsDir, sharedDir).filter((pack) =>
    packDeclaresStage(packsDir, pack, minCeilingId())
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

// Drops every node the day can't actually finish on, so that what comes
// back is a tree where any walk down `next` reaches `top`.
//
// Two passes, because "usable" cuts both ways:
//
//   backward - a node survives only if its own dots exist AND (it is the
//     top stage, or at least one surviving successor follows it). This is
//     what replaces the old spine return: a branch that dead-ends (DWDS
//     has no Mega for 지오그레이몬, and the armour forms carry on to
//     nothing) leaves the draw entirely instead of being handed to a form
//     it never evolves into.
//   forward - a node also has to be arrival-able from the egg through the
//     edges that survived. Removing an edge can orphan a node that is
//     otherwise fine, and an orphan would still count toward a stage's
//     spine and its `choices` tally while never being drawn.
//
// Returns null when the pruning empties any stage: the pack has a tree on
// paper but no route it can walk today, and the caller falls back to
// stageNames (R7). That is the normal state of a half-filled line, not an
// error - dots are gitignored, so a node's name lands in pack.json well
// before its sprite lands on disk.
//
// `hasDot(sprite)` is injected rather than read here so the walk stays a
// pure function over the tree - the tests build trees by hand.
function pruneTree(tree, hasDot, top) {
  const all = TREE.stages.map((s) => s.id);
  const topIdx = all.indexOf(top);
  // Everything above the pack's own ceiling is not part of its line, so it
  // is cut away before the walk rather than reasoned about inside it.
  const stages = topIdx >= 0 ? all.slice(0, topIdx + 1) : all;
  const byId = new Map();
  for (const stage of stages) for (const n of tree[stage] || []) byId.set(n.id, n);

  // A node is a legitimate route end once it is at or past the minimum
  // ceiling; below that it has to carry on to survive. `ceiling` still caps
  // how far the walk can go, so a pack that declares a short line never
  // reaches for a stage it doesn't have.
  const minIdx = Math.min(all.indexOf(minCeilingId()), stages.length - 1);
  const alive = new Set();
  for (let i = stages.length - 1; i >= 0; i--) {
    const stage = stages[i];
    for (const node of tree[stage] || []) {
      if (!hasDot(node.sprite)) continue;
      const carriesOn = (node.next || []).some((id) => alive.has(id));
      if (i >= minIdx || carriesOn) alive.add(node.id);
    }
  }

  const reached = new Set();
  const queue = [];
  for (const node of tree[stages[0]] || []) {
    if (alive.has(node.id)) queue.push(node.id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const nextId of byId.get(id).next || []) {
      if (alive.has(nextId) && !reached.has(nextId)) queue.push(nextId);
    }
  }

  const pruned = {};
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const kept = (tree[stage] || [])
      .filter((n) => reached.has(n.id))
      .map((n) => ({ ...n, next: (n.next || []).filter((id) => reached.has(id)) }));
    // Up to the minimum ceiling every stage must be populated - a gap there
    // means the line can't be walked at all. Past it, an empty stage just
    // means no branch goes that far, which is now allowed: the stage is left
    // out and the route ends earlier.
    if (kept.length === 0) {
      if (i <= minIdx) return null;
      continue;
    }
    pruned[stage] = kept;
  }
  return pruned;
}

// Reads a pack's branching evolution tree (pack.json "tree"): stage id ->
// array of nodes, each { id, name, sprite, next: [nodeId], traits? }. The
// FIRST node of every stage is that stage's spine - the form the pack shows
// when nothing steers it elsewhere.
//
// What comes back is already pruned to routes that reach the pack's
// ceiling and whose every form has dots on disk (see pruneTree), so
// selectRoute never has to invent a transition to rescue a walk.
function readTree(packsDir, pack, sharedDir) {
  let tree;
  try {
    const raw = fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8');
    tree = JSON.parse(raw).tree;
  } catch (e) {
    return null; // no pack.json (or malformed) - caller falls back to stageNames
  }
  if (!tree || typeof tree !== 'object') return null;
  const top = packTopStage(packsDir, pack);
  for (const stage of TREE.stages) {
    if (!Array.isArray(tree[stage.id]) || tree[stage.id].length === 0) return null;
    if (stage.id === top) break;
  }
  // Same lookup order the menubar uses: the pack's own dots, then the
  // species-agnostic shared ones (which is where the egg lives).
  const shared = sharedDir || defaultSharedDir();
  const hasDot = (sprite) =>
    Boolean(sprite) &&
    (fs.existsSync(path.join(packsDir, pack, `${sprite}-0.png`)) ||
      fs.existsSync(path.join(shared, `${sprite}-0.png`)));
  return pruneTree(tree, hasDot, top);
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

// Walks the pack's tree from the egg down to the top stage and returns one
// node per stage: { id, name, sprite } keyed by stage id.
//
// Two rules keep this from turning into a lottery that can strand the day:
//
//   1. Trait gate. Nodes tagged with a trait the day actually earned are
//      preferred; if none of a stage's candidates match, every candidate
//      stays in the draw. So a day full of tool failures leans dark, but a
//      quiet day still sees the whole roster.
//   2. Adjacency only. Candidates come from the current node's `next` and
//      nowhere else. The tree arrives pre-pruned (see pruneTree), so every
//      surviving branch already reaches the ceiling and the walk never
//      needs rescuing - which is what the old "spine return" did, by
//      inventing edges the graph doesn't have. 라이즈그레이몬 → 워그레이몬
//      was the giveaway: two unrelated lines stitched together because the
//      first one ran out of nodes.
//
// The draw is hashString(dateKST + pack + stage), so it is stable all day and
// unrelated between neighbouring days (see hashString). `avoidRoute` is
// yesterday's route: if today's draw reproduces it exactly, the last stage
// that had a real choice steps to its next candidate.
function selectRoute(dateKST, pack, tree, traits, avoidRoute) {
  const stages = TREE.stages.map((s) => s.id).filter((id) => tree[id]);
  const byId = new Map();
  for (const stage of stages) for (const n of tree[stage]) byId.set(n.id, n);

  const pick = (stage, candidates, bump) => {
    const preferred = candidates.filter(
      (n) => Array.isArray(n.traits) && n.traits.some((t) => traits.includes(t))
    );
    const pool = preferred.length > 0 ? preferred : candidates;
    const index = (hashString(`${dateKST}|${pack}|${stage}`) + bump) % pool.length;
    return { node: pool[index], choices: pool.length };
  };

  const walk = (bumpStage) => {
    const route = {};
    const branching = [];
    let current = null;
    for (const stage of stages) {
      let candidates;
      if (!current) {
        candidates = tree[stage];
      } else {
        candidates = (current.next || []).map((id) => byId.get(id)).filter(Boolean);
        if (candidates.length === 0) {
          // Running out of successors at or past the minimum ceiling is how a
          // short line ends - 카오스듀크몬 has no 초궁극체, so its route stops
          // there and the mon simply doesn't evolve again past 2M. Below the
          // minimum ceiling pruneTree should have removed the branch, so a
          // stop there is a bug: bail rather than fabricate an edge.
          const reachedIdx = stages.indexOf(stage) - 1;
          return reachedIdx >= stages.indexOf(minCeilingId()) ? { route, branching } : null;
        }
      }
      const { node, choices } = pick(stage, candidates, bumpStage === stage ? 1 : 0);
      if (choices > 1) branching.push(stage);
      route[stage] = { id: node.id, name: node.name, sprite: node.sprite };
      current = node;
    }
    return { route, branching };
  };

  const first = walk(null);
  if (!first) return null;
  if (!avoidRoute || !sameRoute(first.route, avoidRoute) || first.branching.length === 0) {
    return first.route;
  }
  // Same route as yesterday: nudge the last stage that had alternatives.
  const nudged = walk(first.branching[first.branching.length - 1]);
  return nudged ? nudged.route : first.route;
}

function sameRoute(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] && b[k] && a[k].id === b[k].id);
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
  const tree = readTree(packsDir, mon, sharedDir);
  const signals = daySignals(claudemonDir, sessionTokens);
  const traits = activeTraits(signals);
  let route = null;
  let prevRoute = null;
  if (tree) {
    if (previous && previous.dateKST === dateKST && previous.mon === mon && previous.route) {
      route = previous.route;
      prevRoute = previous.prevRoute || null;
    } else {
      prevRoute = (previous && previous.mon === mon && previous.route) || null;
      route = selectRoute(dateKST, mon, tree, traits, prevRoute);
    }
  }

  const result = {
    dateKST,
    outputTokens,
    stageId: stageState.stageId,
    mon,
    prevMon,
    route,
    prevRoute,
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
  packTopStage,
  topStageId,
  minCeilingId,
  pruneTree,
  hashString,
  selectMon,
  readTree,
  daySignals,
  activeTraits,
  selectRoute
};
