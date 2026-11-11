const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyEvolution, TREE, conditionMet, KNOWN_CONDITION_TYPES } = require('./evolve');
const { sanitizeSessionId } = require('./state');
const { scanCodex } = require('./codex');

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

function defaultNodesDir() {
  return path.join(__dirname, '..', 'sprites', 'nodes');
}

function defaultDenylistPath() {
  return path.join(__dirname, '..', 'sprites', 'nodes-denylist.json');
}

// Reads the node denylist: the nodes whose dot art was judged unfit (see
// sprites/nodes-denylist.json). Returns a Set of graph node ids. Format:
//
//   { "version": 1, "nodes": { "<node id>": "<reason>" } }
//
// Dots are never deleted; a listed node is only kept out of the daily draw
// (linksWithDots) and out of the rotation deck (listValidPacks). To edit,
// add or remove an entry under "nodes" and keep a non-empty reason string.
// Audit candidates: node scripts/audit-node-dots.js --suspects (stdout only,
// never written here).
//
// Never throws. A missing or broken file, a wrong version, a non-object
// "nodes", or an entry whose reason is empty or not a string is ignored, so
// the draw keeps running with the valid entries (or none at all).
function readNodeDenylist(filePath = defaultDenylistPath()) {
  const ids = new Set();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return ids;
  }
  if (!parsed || parsed.version !== 1) return ids;
  const nodes = parsed.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return ids;
  for (const [id, reason] of Object.entries(nodes)) {
    if (typeof reason === 'string' && reason.trim().length > 0) ids.add(id);
  }
  return ids;
}

function graphFilePath() {
  return path.join(__dirname, '..', 'evolution-graph.json');
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

function tokenHistoryFilePath(claudemonDir) {
  return path.join(claudemonDir, 'token-history.json');
}

// Ring-buffer cap on mon-history.json's entries. This file is observational
// only (see recordMonHistory below) - it exists so a bias fix like the
// deck rotation above can be checked against real usage after the fact,
// not to drive any selection logic. 60 entries is about two months of
// daily picks, which is plenty for that purpose without letting the file
// grow forever.
const MON_HISTORY_MAX = 60;

// token-history.json keeps one row per KST day of Claude + Codex output
// tokens. The superultimate bar reads its newest TOP_TIER_WINDOW rows, so 30
// rows leaves slack for days the app was not running.
const TOKEN_HISTORY_MAX = 30;

// The superultimate bar (evolution-tree.json, `relative: true`) is the
// nearest-rank TOP_TIER_PERCENTILE of the newest TOP_TIER_WINDOW recorded
// days, today excluded, and never below TOP_TIER_FLOOR. Fewer recorded days
// than the window means the bar is just TOP_TIER_FLOOR.
const TOP_TIER_WINDOW = 14;
const TOP_TIER_PERCENTILE = 0.9;
const TOP_TIER_FLOOR = 2000000;

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
// Nodes on the denylist (see readNodeDenylist) are skipped too: a pack
// directory is named after its rookie node id, so a denied id drops out of
// the deck here and stays out of listRotationPacks, which goes through this.
//
// Sorted so the hash-based index in selectMon is stable regardless of
// directory listing order.
function listValidPacks(packsDir, sharedDir, denylist = readNodeDenylist()) {
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
    if (denylist.has(entry.name)) continue;
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

// Reads the global evolution graph and constructs reverse index for
// efficient child lookup. Returns { nodes, byId, childrenOf } on success
// or null on failure (missing/malformed file). Never throws - runtime
// stays lenient (decision E).
//
// childrenOf is a Map<parentId, [{ node, when }]> built at load time,
// representing the inverse adjacency list: which children point to this
// parent, and under what condition. This is where evolution candidate
// pools come from in the new model (§B-1.1) - the old tree model had
// each node declare its own fan-out, but now fan-out is derived.
//
// CRITICAL: childrenOf ordering. Each parent's child list follows:
//   1. Node array order in the JSON (stable across loads)
//   2. Conditional edges (when !== null) BEFORE unconditional edges
//
// This must match scripts/migrate-packs-to-graph.js derivedChildOrder
// exactly. Without rule 2, unconditional edges always win because they
// meet the gate in every context, so pool[0].when is permanently the
// unconditional group and conditional branches are unreachable.
function readGraph(graphPath) {
  try {
    const raw = fs.readFileSync(graphPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.nodes)) return null;

    const nodes = parsed.nodes;
    const byId = new Map();
    for (const node of nodes) byId.set(node.id, node);

    // Build reverse index: parent id -> children that evolve from it.
    // Collect first, then apply stable sort by both rules.
    const childrenMap = new Map();
    for (const node of nodes) {
      if (!Array.isArray(node.evolvesFrom)) continue;
      for (const edge of node.evolvesFrom) {
        const parentId = edge.from;
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId).push({ node, when: edge.when });
      }
    }

    // Apply ordering rules: maintain declaration order, but conditional
    // edges precede unconditional within that ordering (see above).
    const childrenOf = new Map();
    for (const [parentId, list] of childrenMap.entries()) {
      // Nodes appear in list in the order they appeared in the JSON
      // (iteration over nodes above), which is already stable. Now
      // partition: conditional first, unconditional second, without
      // disturbing relative order within each partition.
      const conditional = list.filter(e => e.when !== null && e.when !== undefined);
      const unconditional = list.filter(e => e.when === null || e.when === undefined);
      childrenOf.set(parentId, [...conditional, ...unconditional]);
    }

    return { nodes, byId, childrenOf };
  } catch (e) {
    return null;
  }
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

// The daily rotation pool: a valid pack is a rotation candidate if either
//
//   (a) the global graph contains a child-stage node whose id matches the
//       pack directory name (rookie node), OR
//   (b) it has no rookie node (legacy stageNames-only pack) but declares
//       the global top stage by name.
//
// D7 judgment preserved: listValidPacks alone is too permissive (only
// checks sprites), so (a) or (b) is required to keep malformed pack.json
// out while admitting both graph-based and legacy lines.
function listRotationPacks(packsDir, sharedDir, denylist) {
  const graph = readGraph(graphFilePath());
  const top = topStageId();
  return listValidPacks(packsDir, sharedDir, denylist).filter((pack) => {
    if (graph && graph.byId.has(pack)) return true;
    return packDeclaresStage(packsDir, pack, top);
  });
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

// Flattens one edge's `when` into the leaf condition `type`s it actually
// evaluates - recursing through `all`/`any` (any depth) and the `and`
// 2-item alias - so validation can check them against KNOWN_CONDITION_TYPES
// without duplicating conditionMet's own traversal.
function conditionTypesIn(when) {
  if (when === null || when === undefined) return [];
  if (Array.isArray(when.all)) return when.all.flatMap(conditionTypesIn);
  if (Array.isArray(when.any)) return when.any.flatMap(conditionTypesIn);
  const types = [when.type];
  if (when.and) types.push(...conditionTypesIn(when.and));
  return types;
}

// DFS cycle detection helper for validateGraph. Visits nodes through
// childrenOf, detecting back edges (visiting.has). Receives violations array
// as out-param to accumulate cycle rules.
function detectGraphCycle(nodeId, childrenOf, visiting, visited, violations, path) {
  if (visiting.has(nodeId)) {
    violations.push({ rule: 'cycle', path: [...path, nodeId] });
    return;
  }
  if (visited.has(nodeId)) return;

  visiting.add(nodeId);
  const children = childrenOf.get(nodeId) || [];
  for (const { node } of children) {
    detectGraphCycle(node.id, childrenOf, visiting, visited, violations, [...path, nodeId]);
  }
  visiting.delete(nodeId);
  visited.add(nodeId);
}

// Validates the global graph against the data contract the runtime relies
// on but never enforces (decision E). Returns a list of violations, empty
// when valid. Never throws.
//
// Rules (flipped from pack-tree model - ownership reversed in §B-1):
//
//   malformed-graph - graph structure is null or missing required fields
//   unknown-parent - evolvesFrom[].from isn't a real node
//   parent-stage-mismatch - parent isn't the IMMEDIATELY PRIOR stage
//   unknown-condition-type - evolvesFrom[].when names an unimplemented type
//   unreachable-node - evolvesFrom: [] but not the root stage (digitama)
//   cycle - DFS from childrenOf detects a loop
//
// Deliberately NOT rules here (these were pack-tree concerns now obsoleted):
//   missing-unconditional-edge - fallback guarantees reach (§B-1.1)
//   terminal-with-edges / missing-terminal - flag deleted (§B-1)
function validateGraph(graph) {
  if (!graph || !graph.nodes || !graph.byId || !graph.childrenOf) {
    return [{ rule: 'malformed-graph', detail: 'graph structure missing' }];
  }

  const violations = [];
  const { nodes, byId, childrenOf } = graph;
  const stageOrder = TREE.stages.map(s => s.id);
  const stageIndex = new Map(stageOrder.map((id, i) => [id, i]));

  // Root exemption: only nodes in the first stage (digitama) are allowed
  // to have evolvesFrom: []. All other nodes must be reachable from root.
  // Exemption basis is stage position, not node id string match.
  // Phase B reality: rookie nodes all have baby parents (in-degree 0 count: 1).
  const rootStageId = TREE.stages[0].id;

  for (const node of nodes) {
    const evolvesFrom = Array.isArray(node.evolvesFrom) ? node.evolvesFrom : [];

    // unreachable-node: evolvesFrom empty but not in root stage
    if (evolvesFrom.length === 0 && node.stage !== rootStageId) {
      violations.push({ rule: 'unreachable-node', node: node.id });
    }

    for (const edge of evolvesFrom) {
      const parentNode = byId.get(edge.from);

      // unknown-parent
      if (!parentNode) {
        violations.push({ rule: 'unknown-parent', node: node.id, from: edge.from });
        continue;
      }

      // parent-stage-mismatch: parent must be IMMEDIATELY prior stage
      const childIdx = stageIndex.get(node.stage);
      const parentIdx = stageIndex.get(parentNode.stage);
      if (childIdx === undefined || parentIdx === undefined || parentIdx !== childIdx - 1) {
        violations.push({
          rule: 'parent-stage-mismatch',
          node: node.id,
          nodeStage: node.stage,
          from: edge.from,
          parentStage: parentNode.stage
        });
      }

      // unknown-condition-type
      for (const condType of conditionTypesIn(edge.when)) {
        if (!KNOWN_CONDITION_TYPES.includes(condType)) {
          violations.push({ rule: 'unknown-condition-type', node: node.id, condType });
        }
      }
    }
  }

  // cycle detection: DFS through childrenOf
  const visiting = new Set();
  const visited = new Set();
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      detectGraphCycle(node.id, childrenOf, visiting, visited, violations, []);
    }
  }

  return violations;
}

// "성장 배경" signals for the day, read off what claudemon already records.
// Digimon canon has the same species branch differently depending on how it
// was raised; these are the closest things this app knows about how the day
// was spent.
//
//   dark  - a day with tool calls failing (see failureRatio below)
//   swarm - many sessions running side by side
//   focus - one session carrying most of the day's output
//   userTurns / outputPerTurn - a "설계 날" (design day) shows up as many
//     real user prompts (isRealUserTurn) but comparatively little assistant
//     output per turn - lots of discussion, not much generation.
//
// failureRatio sums the state files of the sessions that produced output
// today, not global.json. global.json is a *lifetime* counter and could not
// move the dark trait day to day; worse, its denominator is poisoned. On
// 2026-08-24 it read 46,987 successes / 0 failures - and that 0 was not a
// perfect record but a wiring hole: PostToolUse fires only on success, and
// the tool-failure handler was never wired to PostToolUseFailure, so every
// failure had been dropped on the floor (see README 훅 설정). Even after
// fixing the wiring, a lifetime ratio would need ~2,473 failures to cross
// the 5% threshold that the black evolution lines gate on.
//
// Per-session sums need no new plumbing: hook.js already keeps the same two
// counters per session, and sessionTokens' keys are exactly today's
// sessions. Residual imprecision: a session running across midnight carries
// yesterday's tail with it, because session files don't know about day
// boundaries. Sessions typically last hours, so this stays far closer to
// "today" than a lifetime counter ever could.
// Sums tool counters across the sessions that produced output today
// (sessionTokens' keys). Sessions whose state file is missing, unreadable,
// or whose id doesn't sanitize are skipped rather than counted as zero-risk
// - a session we can't read is a session we know nothing about.
function sessionToolCounts(claudemonDir, sessionTokens) {
  let ok = 0;
  let bad = 0;
  for (const sessionId of Object.keys(sessionTokens || {})) {
    const safe = sanitizeSessionId(sessionId);
    if (!safe) continue;
    try {
      const raw = fs.readFileSync(path.join(claudemonDir, 'sessions', `${safe}.json`), 'utf8');
      const s = JSON.parse(raw);
      ok += s.toolSuccessCount || 0;
      bad += s.toolFailureCount || 0;
    } catch (e) {
      /* no state for this session - leave it out of both sides of the ratio */
    }
  }
  return { ok, bad };
}

function daySignals(claudemonDir, sessionTokens, dailyUserTurns, dailyOutputTokens) {
  const totals = Object.values(sessionTokens || {});
  const sum = totals.reduce((a, b) => a + b, 0);
  const counts = sessionToolCounts(claudemonDir, sessionTokens);
  const attempted = counts.ok + counts.bad;
  const failureRatio = attempted > 0 ? counts.bad / attempted : 0;
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

// A-5 (docs/gate-weighting-plan.md): a condition edge no longer *decides*
// which children are even eligible for the day's draw - it *biases* the
// draw toward them. Before this, a single satisfied condition (e.g.
// sessionCount>=5) made the tied-filter below drop every unconditional
// sibling outright, collapsing a 28-way fan-out (agumon) to 1 live child
// on nearly every day (plan §1-2). CONDITION_EDGE_WEIGHT keeps most of
// that lineage-diversity recovery (measured: agumon 8 -> 543 reachable
// lineages over 365 simulated days) while still leaving the gate
// meaningful - see the plan's §4 W-comparison table for why 8 was chosen
// over 16 (same lineage count, only the terminal rate differs, by 0.5pp).
//
// CONDITION_EDGE_WEIGHT === Infinity would reproduce the pre-A-5 result
// exactly (a satisfied condition wins outright again), so raising this
// constant is the documented, continuous way to walk the change back
// without touching the rollback flag below.
const CONDITION_EDGE_WEIGHT = 8;
const UNCONDITIONAL_EDGE_WEIGHT = 1;

// Rollback switch (see notify.js's CLAUDEMON_NOTIFY for the same
// on-unless-'0' convention this repo already uses for kill switches).
// '0' restores the exact pre-A-5 selection: legacyTiedPool below, not
// weightedCandidates. Raising CONDITION_EDGE_WEIGHT gets you most of the
// way back continuously; this flag is the discrete "known-good" fallback
// if that isn't enough.
function gateWeightingEnabled() {
  return process.env.CLAUDEMON_GATE_WEIGHTING !== '0';
}

// Turns one node's edge list ({ node, when }[] - either childrenOf's
// forward edges or an evolvesFrom parent list for the backward prefix
// walk) into the day's draw pool: { node, weight }[]. Shared by
// candidatesFor and selectRoute's prefix walk so both sides of the walk
// treat a condition the same way (plan §4, §Q3 - previously each kept its
// own copy of the tied-filter).
//
//   - condition satisfied, or no condition at all (unconditional edges are
//     always "satisfied" - conditionMet(null, ctx) === true) -> weight =
//     CONDITION_EDGE_WEIGHT / UNCONDITIONAL_EDGE_WEIGHT respectively
//   - condition present but not satisfied today -> excluded (weight 0)
//
// Fallback: `met` can come back empty only when this node's edges are
// ALL conditional and none holds today - validateGraph deliberately does
// NOT require every non-terminal node to keep an unconditional edge (see
// its rule comment), so this is a legal graph shape, not a bug. Returning
// [] here would make candidatesFor's caller misread a live node as
// terminal. The safe fallback is every edge on this node at uniform
// weight 1 - NOT CONDITION_EDGE_WEIGHT, since none of them actually held;
// this mirrors the pre-A-5 code's own `met.length > 0 ? met : links`
// safety net (same links, same non-empty guarantee), just weighted
// uniformly instead of tied-filtered.
//
// CLAUDEMON_GATE_WEIGHTING=0 skips all of this and defers to
// legacyTiedPool instead.
function weightedCandidates(links, ctx) {
  if (!gateWeightingEnabled()) return legacyTiedPool(links, ctx);

  const met = links.filter((e) => conditionMet(e.when, ctx));
  if (met.length === 0) {
    return links.map((e) => ({ node: e.node, weight: UNCONDITIONAL_EDGE_WEIGHT }));
  }
  return met.map((e) => ({
    node: e.node,
    weight: (e.when === null || e.when === undefined)
      ? UNCONDITIONAL_EDGE_WEIGHT
      : CONDITION_EDGE_WEIGHT
  }));
}

// Pre-A-5 selection, kept only for the CLAUDEMON_GATE_WEIGHTING=0 rollback
// path: the first satisfied condition (or, absent one, the first
// unconditional edge - childrenOf/evolvesFrom both order conditional
// edges before unconditional ones, see readGraph) decides the day's
// winning `when`, and only edges sharing that exact `when` (by JSON
// equality) survive. This is the tied-filter that made a satisfied
// condition a lock rather than a bias (plan §2) - every sibling edge with
// a different `when` (including every unconditional edge, once any
// condition is satisfied) is dropped outright.
function legacyTiedPool(links, ctx) {
  const met = links.filter((e) => conditionMet(e.when, ctx));
  const pool = met.length > 0 ? met : links;
  const winner = JSON.stringify(pool[0].when);
  const tied = pool.filter((e) => JSON.stringify(e.when) === winner);
  return tied.map((e) => ({ node: e.node, weight: 1 }));
}

// Resolves the pool `pick` draws from by looking up which children evolve
// from `node` in the reverse index (childrenOf). This is the core change in
// the global-graph model (§B-1.1): fan-out is no longer declared by the
// node but derived from which children point back to it.
//
// Zero links means this is a terminal node, so return an empty array - the
// caller (selectRoute's forward phase) will detect this and repeat the
// same node for all remaining stages. Otherwise the edges become a
// weighted draw pool - see weightedCandidates.
function candidatesFor(node, ctx, childrenOf) {
  const links = childrenOf.get(node.id) || [];
  if (links.length === 0) return []; // terminal - no children point to this node
  return weightedCandidates(links, ctx);
}

// Draws one node from `candidates` ({ node, weight }[], see
// weightedCandidates) for `stage`, weighted by each candidate's `weight`.
// The draw is hashString(dateKST + rookie + stage) reduced mod the total
// weight and walked as a cumulative-weight scan, so it is stable all day
// and unrelated between neighbouring days (see hashString) while still
// favoring higher-weight candidates in proportion to their weight.
//
// CRITICAL: the hash key `${dateKST}|${rookie}|${stage}` must NEVER change -
// golden equality depends on it. Even after Phase A removes pack-based
// selection, this key preserves the old rotation's determinism for
// regression tests.
//
// useRandom (default false, see docs/lazy-route-plan.md §3 "last-moment
// lottery"): when true, draws with Math.random instead of the hash. Every
// existing call site omits this arg, so behavior is byte-for-byte identical
// unless a caller opts in explicitly - selectRoute only ever sets it from
// `locked.random`, and only for a stage that isn't already pinned (see
// selectRoute's prefix/forward walks), so a stage is drawn with real
// randomness at most once, the moment it's first reached. Math.random is
// otherwise never used here - see hashString's doc comment on why the daily
// pick has to be idempotent; this is the one place that invariant is
// deliberately traded away, and only for stages not yet pinned.
function pick(dateKST, rookie, stage, candidates, useRandom) {
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let index = useRandom
    ? Math.floor(Math.random() * totalWeight)
    : hashString(`${dateKST}|${rookie}|${stage}`) % totalWeight;
  for (const c of candidates) {
    if (index < c.weight) return c.node;
    index -= c.weight;
  }
  /* istanbul ignore next - unreachable: totalWeight is the sum of every
     candidate's weight, so the loop above always returns before this. */
  return candidates[candidates.length - 1].node;
}

// Records why a particular node was chosen for a stage. Captures the pool of
// candidates, their weights, the context that determined those weights, and
// whether the draw used Math.random or the date hash. This is what lets the
// menubar show "chosen from 7 candidates, swarm ×8, 38% probability" instead
// of just showing the resulting form with no explanation.
//
// parentId: the node id this stage evolved from (forward) or to (prefix).
// originalLinks: the raw edges (before weightedCandidates filters/weights them)
//   that fed into the draw. Each link is { node, when } per childrenOf or
//   evolvesFrom format (see selectRoute). Pass this rather than `candidates`
//   so recordRouteReason can tell whether fallback happened: if every link had
//   a condition (when !== null) but candidates all got weight 1, that's the
//   fallback path (all conditions failed, so weightedCandidates gave up and
//   made them equally likely - see weightedCandidates' met.length === 0 branch).
// candidates: the weighted pool pick() drew from ({ node, weight }[]).
// chosenNode: the node pick() returned.
// ctx: the signal context (dailyUserTurns, sessionCount, etc.) at draw time.
// useRandom: true if pick used Math.random, false if it used the date hash.
function recordRouteReason(parentId, originalLinks, candidates, chosenNode, ctx, useRandom) {
  const allConditional = originalLinks.every(e => e.when !== null && e.when !== undefined);
  const allWeightOne = candidates.every(c => c.weight === 1);
  const fallback = allConditional && allWeightOne;
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  const chosenCandidate = candidates.find(c => c.node.id === chosenNode.id);
  const chosenWeight = chosenCandidate ? chosenCandidate.weight : 1;
  return {
    parentId,
    candidates: candidates.map(c => ({
      id: c.node.id,
      name: c.node.name,
      weight: c.weight,
      when: originalLinks.find(e => e.node.id === c.node.id)?.when || null
    })),
    totalWeight,
    chosenId: chosenNode.id,
    probability: totalWeight > 0 ? chosenWeight / totalWeight : 1,
    ctx: {
      dailyUserTurns: ctx.dailyUserTurns || 0,
      outputPerTurn: ctx.outputPerTurn || 0,
      sessionCount: ctx.sessionCount || 0,
      topSharePct: ctx.topSharePct || 0,
      failureRatioPct: ctx.failureRatioPct || 0
    },
    method: useRandom ? "random" : "hash",
    fallback
  };
}

// Walks the GLOBAL stage ladder (TREE.stages) top to bottom, applying
// `locked` (see selectRoute's doc comment for what it does). Returns one
// node per stage the walk actually fills in - which for a line that ends
// early (terminal, or a tree that just stops declaring stages) is every
// global stage anyway (see the terminal-fill branch below), not only the
// stages this pack's tree declares.

// Drops links whose node is on the denylist (see readNodeDenylist), then
// drops links whose node has no dot file (sprites/nodes/<sprite>-0.png), so
// the route never lands on a form the menubar can only draw as the previous
// stage's dot. If no link has a dot, the links that survived the denylist
// are kept: a live node must not be misread as terminal. The denylist is
// applied first so this fallback can never bring a denied node back. Shared
// stages (digitama) draw from sprites/shared, not nodes, so they are never
// dropped for lacking a dot (the denylist still applies to them).
//
// With an empty denylist, `allowed` is `links` itself, so the result is the
// same as the dot-only filter that predates the denylist.
function linksWithDots(links, nodesDir, denylist = new Set()) {
  const allowed = denylist.size === 0 ? links : links.filter((e) => !denylist.has(e.node.id));
  const withDots = allowed.filter((e) =>
    e.node.stage === 'digitama' || fs.existsSync(path.join(nodesDir, `${e.node.sprite}-0.png`)));
  return withDots.length > 0 ? withDots : allowed;
}

// childrenOf lookalike whose get() applies linksWithDots; candidatesFor only
// ever calls childrenOf.get(id).
function dotFilteredChildren(childrenOf, nodesDir, denylist) {
  return { get: (id) => linksWithDots(childrenOf.get(id) || [], nodesDir, denylist) };
}

// Walks the global evolution graph from `rookie` (a child-stage node id
// that matches the pack directory name) and returns one node per stage:
// { id, name, sprite } keyed by stage id, plus routeReasons explaining why
// each node was chosen.
//
// Two phases (§B-1):
//
//   PREFIX (before rookie stage): Walk BACKWARD from rookie following
//   evolvesFrom edges until digitama. This preserves pack isolation while
//   digitama has 10 fan-out (Phase B). Once Phase A (§4 A-1) gates
//   digitama with conditions, this backward walk disappears.
//
//   FORWARD (rookie stage onward): candidatesFor + pick. When
//   candidatesFor returns [] (no children), this is terminal - repeat
//   node for all remaining stages.
//
// `locked` preserves lazy binding: pins stages ≤ throughStage to existing
// route, redraws stages above against today's ctx. If locked route doesn't
// line up (node disappeared), degrade to normal draw. `locked.random`
// (default falsy - every call site but computeDailyTokens omits it, and
// even that one only turns it on deliberately, see docs/lazy-route-plan.md
// §3) makes a stage without a pinned entry draw with Math.random instead of
// the date hash - see pick's doc comment for why that's safe.
//
// `locked.routeReasons` (optional): existing reasons for stages already pinned
// today. When a stage is reused from locked.route, its reason is also reused
// from locked.routeReasons verbatim, so the reason doesn't change mid-day.
//
// Returns { route, routeReasons } where routeReasons is keyed by stage id.
function selectRoute(dateKST, rookie, graph, ctx, locked) {
  const { byId } = graph;
  const nodesDir = graph.nodesDir || defaultNodesDir();
  // Read once per call (the file is tiny); graph.denylist (a Set) overrides
  // the file, for tests.
  const denylist = graph.denylist || readNodeDenylist();
  const childrenOf = dotFilteredChildren(graph.childrenOf, nodesDir, denylist);
  const route = {};
  const routeReasons = {};
  const stageOrder = TREE.stages.map(s => s.id);
  const stageIndex = new Map(stageOrder.map((id, i) => [id, i]));
  const rookieStageIdx = stageIndex.get('child');
  const lockedThroughIdx = locked ? stageIndex.get(locked.throughStage) : -1;
  let lockedActive = Boolean(locked);

  // PREFIX: backward walk from rookie to digitama. Applies weightedCandidates
  // (met -> fallback -> weight) to the parent list, same as the forward
  // walk's candidatesFor - see plan §Q3, weightedCandidates' doc comment.
  // This is pack isolation in Phase B - once digitama gets conditions
  // (A-1), delete this and start at digitama with forward walk.
  //
  // CRITICAL: must match scripts/migrate-packs-to-graph.js derivedChildOrder
  // in how it picks among multiple parents (already enforced by childrenOf
  // ordering in readGraph, but parent selection here mirrors that logic).
  const prefix = {};
  const prefixReasons = {};
  let currentNode = byId.get(rookie);
  if (!currentNode) return { route: {}, routeReasons: {} };

  // Prefix stages (digitama, baby, ...) are always "reached" from the start
  // of the day (stageState.stageId in computeDailyTokens begins at
  // TREE.stages[0]), so once route drawing can use real randomness
  // (locked.random - see pick's doc comment), the very first draw of the
  // day is also the last-moment one for these stages. Without pinning them
  // here too, every later poll would re-roll them with a fresh random
  // number and the sprite would flicker all day. So this mirrors the
  // forward walk's lock-check below: a pinned entry (already drawn earlier
  // today, echoed back via locked.route) is reused verbatim and never
  // re-rolled; only a stage without one yet is drawn (and only then does it
  // consult locked.random).
  let prefixLockedActive = Boolean(locked);
  for (let i = rookieStageIdx - 1; i >= 0; i--) {
    const stage = stageOrder[i];
    const parents = (currentNode.evolvesFrom || []).map(e => ({
      node: byId.get(e.from),
      when: e.when
    })).filter(p => p.node);

    if (parents.length === 0) break;

    const dotParents = linksWithDots(parents, nodesDir, denylist);
    // Every parent denied: nothing to draw from, so the prefix ends here
    // (pick cannot draw from an empty pool).
    if (dotParents.length === 0) break;
    const candidates = weightedCandidates(dotParents, ctx);

    let chosen = null;
    let reasonLocked = false;
    if (prefixLockedActive && i <= lockedThroughIdx) {
      const lockedEntry = locked.route && locked.route[stage];
      const node = lockedEntry && byId.get(lockedEntry.id);
      if (node) {
        chosen = node;
        reasonLocked = true;
      } else {
        prefixLockedActive = false;
      }
    }
    if (!chosen) {
      chosen = pick(dateKST, rookie, stage, candidates, Boolean(locked && locked.random));
    }

    prefix[stage] = { id: chosen.id, name: chosen.name, sprite: chosen.sprite };
    if (reasonLocked && locked.routeReasons && locked.routeReasons[stage]) {
      prefixReasons[stage] = locked.routeReasons[stage];
    } else if (candidates.length > 0) {
      prefixReasons[stage] = recordRouteReason(currentNode.id, dotParents, candidates, chosen, ctx, Boolean(locked && locked.random));
    }
    currentNode = chosen;
  }

  // FORWARD: rookie and beyond
  currentNode = byId.get(rookie);
  for (let i = rookieStageIdx; i < stageOrder.length; i++) {
    const stage = stageOrder[i];

    // First iteration: rookie stage itself - use the rookie node directly
    // No reason recorded here (rookie is the pack directory, not a choice)
    if (i === rookieStageIdx) {
      route[stage] = { id: currentNode.id, name: currentNode.name, sprite: currentNode.sprite };
      continue;
    }

    // Terminal fill: candidatesFor returns [] when no children point to
    // this node (replaces isTerminal flag - §B-1)
    // No reason recorded (no choice was made, just repeating the terminal node)
    if (currentNode && candidatesFor(currentNode, ctx, childrenOf).length === 0) {
      route[stage] = { id: currentNode.id, name: currentNode.name, sprite: currentNode.sprite };
      continue;
    }

    // childrenOf entries are already { node, when } - no need to map
    const originalLinks = childrenOf.get(currentNode.id) || [];

    // Locked stage
    let reasonLocked = false;
    if (lockedActive && i <= lockedThroughIdx) {
      const lockedEntry = locked.route && locked.route[stage];
      const node = lockedEntry && byId.get(lockedEntry.id);
      if (node) {
        route[stage] = { id: node.id, name: node.name, sprite: node.sprite };
        currentNode = node;
        reasonLocked = true;
        if (locked.routeReasons && locked.routeReasons[stage]) {
          routeReasons[stage] = locked.routeReasons[stage];
        }
        continue;
      }
      lockedActive = false;
    }

    // Normal forward walk
    const candidates = candidatesFor(currentNode, ctx, childrenOf);
    if (candidates.length === 0) {
      // Hit terminal unexpectedly
      route[stage] = { id: currentNode.id, name: currentNode.name, sprite: currentNode.sprite };
      continue;
    }

    const parentId = currentNode.id;
    const node = pick(dateKST, rookie, stage, candidates, Boolean(locked && locked.random));
    route[stage] = { id: node.id, name: node.name, sprite: node.sprite };
    routeReasons[stage] = recordRouteReason(parentId, originalLinks, candidates, node, ctx, Boolean(locked && locked.random));
    currentNode = node;
  }

  // Return route in stage order (digitama → baby → ... → superultimate)
  // for human-readable daily.json output. Prefix walk fills backward,
  // so { ...prefix, ...route } would produce baby → digitama → child order.
  const orderedRoute = {};
  const orderedReasons = {};
  for (const stage of stageOrder) {
    const entry = prefix[stage] || route[stage];
    if (entry) orderedRoute[stage] = entry;
    const reason = prefixReasons[stage] || routeReasons[stage];
    if (reason) orderedReasons[stage] = reason;
  }
  return { route: orderedRoute, routeReasons: orderedReasons };
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

// dex.json is the claudemon 도감 (dex): which nodes were ever reached, and
// the route each day ended on. Unlike mon-history it has no cap - a node's
// first-seen date is kept forever. Shape:
//
//   { version: 1, nodes: { "<node id>": "YYYY-MM-DD" },
//     days: { "YYYY-MM-DD": ["<node id>", ...] } }
//
// Only recordDex writes it. Nothing here ever sends a notification: the dex
// is shown in the menubar (claudemon-menubar.swift) and nowhere else.
const DEX_VERSION = 1;
const DEX_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEX_LEAF_NAMES = {
  always: '항상',
  toolSuccessCount: '도구 성공 수',
  globalToolSuccessCount: '누적 도구 성공 수',
  errorRatePct: '도구 오류율(%)',
  consecutiveDaysActive: '연속 활동 일',
  dailyOutputTokens: '오늘 출력 토큰',
  sessionCount: '세션 수',
  topSharePct: '최다 세션 비중(%)',
  failureRatioPct: '실패율(%)',
  dailyUserTurns: '사용자 턴',
  outputPerTurn: '턴당 출력'
};

function dexFilePath(claudemonDir) {
  return path.join(claudemonDir, 'dex.json');
}

function emptyDex() {
  return { version: DEX_VERSION, nodes: {}, days: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Reads dex.json into { version, nodes, days }, the shape recordDex writes.
// A missing file, unparsable JSON, a version mismatch, or a non-object
// nodes/days degrade to an empty dex and never throw (same as
// readMonHistory). Single bad entries are dropped instead of failing the
// whole file: a node whose value is not a YYYY-MM-DD string, and a day whose
// value is not an array of strings. C4 reads `nodes` (first-seen dates) and
// `days` (per-day routes) through this function.
function readDex(claudemonDir) {
  const file = dexFilePath(claudemonDir);
  if (!fs.existsSync(file)) return emptyDex();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return emptyDex();
  }
  if (!isPlainObject(parsed) || parsed.version !== DEX_VERSION) return emptyDex();
  if (!isPlainObject(parsed.nodes) || !isPlainObject(parsed.days)) return emptyDex();
  const dex = emptyDex();
  for (const [id, date] of Object.entries(parsed.nodes)) {
    if (typeof date === 'string' && DEX_DATE_RE.test(date)) dex.nodes[id] = date;
  }
  for (const [date, ids] of Object.entries(parsed.days)) {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) dex.days[date] = ids;
  }
  return dex;
}

// Node ids of a route in stage order, each once. selectRoute's terminal fill
// repeats the terminal node for every later stage, so the dedupe is needed
// to keep days[date] and newToday free of repeats.
function routeNodeIdsOf(route) {
  const ids = [];
  for (const stage of TREE.stages) {
    const entry = route[stage.id];
    if (entry && typeof entry.id === 'string' && !ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids;
}

// Folds one day's route into `dex` in place. A node's first-seen date is set
// once and never moved. The day's entry is replaced when its ids differ, so
// the lazy-route growth through the day leaves one entry per date. Returns
// whether anything changed.
function applyDexRoute(dex, dateKST, routeIds) {
  let changed = false;
  for (const id of routeIds) {
    if (!hasOwn(dex.nodes, id)) {
      dex.nodes[id] = dateKST;
      changed = true;
    }
  }
  const previous = dex.days[dateKST];
  const same = Array.isArray(previous)
    && previous.length === routeIds.length
    && previous.every((id, i) => id === routeIds[i]);
  if (!same) {
    dex.days[dateKST] = routeIds.slice();
    changed = true;
  }
  return changed;
}

// Records today's confirmed route and returns the updated dex. Runs on every
// ~30s poll, so an unchanged route skips the write (same as
// recordMonHistory). A write failure throws; computeDailyTokens isolates it
// so daily.json still gets written.
function recordDex(claudemonDir, dateKST, routeIds) {
  const dex = readDex(claudemonDir);
  if (!applyDexRoute(dex, dateKST, routeIds)) return dex;
  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(dexFilePath(claudemonDir), JSON.stringify(dex, null, 2));
  return dex;
}

// The deck rookies that exist in the graph: where the forward walk starts.
function deckStartIds(graph, packsDir, sharedDir, denylist) {
  return listValidPacks(packsDir, sharedDir, denylist).filter((id) => graph.byId.has(id));
}

// Forward BFS over the same edges selectRoute walks (dotFilteredChildren).
// Denied nodes never enter the set, and dotFilteredChildren drops denied
// children, so nothing is reached only through a denied node.
function reachableFrom(graph, startIds, denylist) {
  const nodesDir = graph.nodesDir || defaultNodesDir();
  const children = dotFilteredChildren(graph.childrenOf, nodesDir, denylist);
  const reached = new Set();
  const queue = [];
  for (const id of startIds) {
    if (denylist.has(id) || reached.has(id) || !graph.byId.has(id)) continue;
    reached.add(id);
    queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    for (const { node } of children.get(id)) {
      if (denylist.has(node.id) || reached.has(node.id)) continue;
      reached.add(node.id);
      queue.push(node.id);
    }
  }
  return reached;
}

// M, the denominator of "도감 N/M": every node a deck rookie can grow into
// under the current graph, deck, and denylist (the denylist is passed in,
// normally readNodeDenylist()). Recomputed on each poll.
//
// R10 limit: the real draw happens when each stage is reached, with that
// moment's ctx. This set assumes every conditional edge might fire, so M can
// include nodes that today's ctx never routes to. N (found) only counts nodes
// that landed in a recorded route, so N can lag M. Do not read N/M as a
// probability.
function reachableNodes(graph, packsDir, sharedDir, denylist) {
  return reachableFrom(graph, deckStartIds(graph, packsDir, sharedDir, denylist), denylist);
}

// True for an edge that carries a real condition, false for the
// unconditional (when null/undefined) fallback edge.
function isConditionalEdge(edge) {
  return edge.when !== null && edge.when !== undefined;
}

// The parent edges of `id` whose parent is inside `reachable`.
function parentEdgesIn(graph, id, reachable) {
  const node = graph.byId.get(id);
  const edges = node && Array.isArray(node.evolvesFrom) ? node.evolvesFrom : [];
  return edges.filter((e) => reachable.has(e.from));
}

function describeConditionLeaf(cond) {
  if (cond.type === 'always') return '항상';
  let name = DEX_LEAF_NAMES[cond.type] || String(cond.type);
  if (cond.type === 'milestone') name = `마일스톤(${cond.key})`;
  const bounds = [];
  if (cond.gte !== undefined) bounds.push(`${cond.gte} 이상`);
  if (cond.lte !== undefined) bounds.push(`${cond.lte} 이하`);
  let text = [name, ...bounds].join(' ');
  if (cond.relative === true) text += ' (최근 14일 상위 기준 적용, 이 값은 하한)';
  return text;
}

function describeConditionNode(cond) {
  if (!isPlainObject(cond)) return '알 수 없는 조건';
  if (Array.isArray(cond.all)) {
    return cond.all.length === 0 ? '항상' : cond.all.map(describeConditionNode).join(' 그리고 ');
  }
  if (Array.isArray(cond.any)) {
    return cond.any.length === 0 ? '해당 없음' : cond.any.map(describeConditionNode).join(' 또는 ');
  }
  const parts = [describeConditionLeaf(cond)];
  if (cond.and) parts.push(describeConditionNode(cond.and));
  return parts.join(' 그리고 ');
}

// Turns an edge's `when` into a Korean phrase for the hint. null/undefined
// (no condition) reads as luck. Never throws: an unknown type is printed as
// its name.
function describeCondition(when) {
  if (when === null || when === undefined) return '조건 없음(운)';
  return describeConditionNode(when);
}

// One "why not yet" sentence for the menubar: "<name> ← <parent>: <condition>".
// Picks one undiscovered reachable node. The frontier comes first: a deck
// rookie, or a node with a discovered parent. Within the frontier, nodes with
// a conditional edge win. The index is hashed from dateKST over a sorted list,
// so the choice holds all day. Returns undefined when nothing is left to find.
function hintFor(dateKST, graph, reachable, dex, startIds) {
  const undiscovered = [...reachable].filter((id) => !hasOwn(dex.nodes, id)).sort();
  if (undiscovered.length === 0) return undefined;
  const starts = new Set(startIds);
  const frontier = undiscovered.filter((id) => starts.has(id)
    || parentEdgesIn(graph, id, reachable).some((e) => hasOwn(dex.nodes, e.from)));
  const base = frontier.length > 0 ? frontier : undiscovered;
  const conditional = base.filter((id) => parentEdgesIn(graph, id, reachable).some(isConditionalEdge));
  const pool = conditional.length > 0 ? conditional : base;
  const id = pool[hashString(dateKST) % pool.length];
  const node = graph.byId.get(id);
  const edges = parentEdgesIn(graph, id, reachable);
  if (edges.length === 0) return `${node.name}: 덱 시작 성장기, 조건 없음(운)`;
  const edge = edges.find((e) => hasOwn(dex.nodes, e.from) && isConditionalEdge(e))
    || edges.find((e) => hasOwn(dex.nodes, e.from))
    || edges.find(isConditionalEdge)
    || edges[0];
  const parent = graph.byId.get(edge.from);
  return `${node.name} ← ${parent ? parent.name : edge.from}: ${describeCondition(edge.when)}`;
}

// The `dex` block of daily.json: { found, total, newToday, hint? }.
// total = |M| (reachable set). found = reachable nodes already in dex.nodes,
// so a denied or unreachable node in dex never counts. newToday = today's
// first finds that lie in M, in route order. hint is left out when nothing
// is undiscovered.
function dexFieldFor({ dex, graph, dateKST, routeIds, packsDir, sharedDir, denylist }) {
  const starts = deckStartIds(graph, packsDir, sharedDir, denylist);
  const reachable = reachableFrom(graph, starts, denylist);
  const found = [...reachable].filter((id) => hasOwn(dex.nodes, id)).length;
  const newToday = routeIds
    .filter((id) => reachable.has(id) && dex.nodes[id] === dateKST)
    .map((id) => graph.byId.get(id).name);
  const field = { found, total: reachable.size, newToday };
  const hint = hintFor(dateKST, graph, reachable, dex, starts);
  if (hint !== undefined) field.hint = hint;
  return field;
}

const TOKEN_HISTORY_VERSION = 1;

function isTokenHistoryEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && typeof entry.date === 'string'
    && Number.isFinite(entry.outputTokens)
    && entry.outputTokens >= 0;
}

// Reads token-history.json's { version, entries } (oldest -> newest). Same
// degradation as readMonHistory: a missing file, bad JSON, or a version
// mismatch reads as empty. Entries with a non-string date or a non-finite or
// negative outputTokens are dropped one by one, so one bad row cannot hide the
// rest of the window.
function readTokenHistory(claudemonDir) {
  const empty = { version: TOKEN_HISTORY_VERSION, entries: [] };
  const file = tokenHistoryFilePath(claudemonDir);
  if (!fs.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== TOKEN_HISTORY_VERSION || !Array.isArray(parsed.entries)) return empty;
    return { version: TOKEN_HISTORY_VERSION, entries: parsed.entries.filter(isTokenHistoryEntry) };
  } catch (e) {
    return empty;
  }
}

// Records today's Claude + Codex output total in token-history.json. Called
// on every ~30s poll, so the common case - same date, same value as the last
// entry - returns without writing.
//
//   - same date, same value as the last entry: return, no write.
//   - same date, new value: overwrite that entry, so a day ends up holding
//     the last poll's value.
//   - new date: append and trim the ring buffer to TOKEN_HISTORY_MAX from the
//     front. Past days are never back-filled.
function recordTokenHistory(claudemonDir, dateKST, outputTokens) {
  const history = readTokenHistory(claudemonDir);
  const last = history.entries[history.entries.length - 1];

  if (last && last.date === dateKST && last.outputTokens === outputTokens) return;

  if (last && last.date === dateKST) {
    last.outputTokens = outputTokens;
  } else {
    history.entries.push({ date: dateKST, outputTokens });
    if (history.entries.length > TOKEN_HISTORY_MAX) {
      history.entries = history.entries.slice(history.entries.length - TOKEN_HISTORY_MAX);
    }
  }

  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(tokenHistoryFilePath(claudemonDir), JSON.stringify(history, null, 2));
}

// Nearest-rank percentile of an ascending, non-empty array: the value at
// 1-based rank ceil(p * n). Kept free of I/O so the window logic is testable
// on its own.
function nearestRank(sorted, p) {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.max(rank, 1) - 1];
}

// The superultimate bar for dateKST. Today is left out so the bar cannot move
// during the day it applies to; earlier days stop changing once their day has
// passed, so it stays put all day. Fewer than TOP_TIER_WINDOW recorded days
// gives TOP_TIER_FLOOR.
function topTierThreshold(claudemonDir, dateKST) {
  const byDate = new Map();
  for (const entry of readTokenHistory(claudemonDir).entries) {
    if (entry.date !== dateKST) byDate.set(entry.date, entry.outputTokens);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < TOP_TIER_WINDOW) return TOP_TIER_FLOOR;
  const recent = dates.slice(dates.length - TOP_TIER_WINDOW).map((d) => byDate.get(d));
  recent.sort((a, b) => a - b);
  return Math.max(nearestRank(recent, TOP_TIER_PERCENTILE), TOP_TIER_FLOOR);
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

  const codex = scanCodex(now, { ...options, claudemonDir }, dayStartMs, dayEndMs, dateKST);
  dailyUserTurns += codex.userTurns;
  for (const [id, count] of Object.entries(codex.tokens)) {
    sessionTokens[id] = count;
    outputTokens += count;
  }

  // Signals computed before stage progression: the sage-day stage gates
  // (evolution-tree.json's `any` conditions) need outputPerTurn/
  // dailyUserTurns exactly like dailyOutputTokens does, so applyEvolution's
  // ctx has to carry them too.
  const signals = daySignals(claudemonDir, sessionTokens, dailyUserTurns, outputTokens);
  // traits is no longer what gates a branch (see selectRoute) - kept only as
  // a debug hint in daily.json for reading back "why this form today".
  const traits = activeTraits(signals);

  // Today's superultimate bar (see topTierThreshold). Read before today's own
  // total is recorded; it leaves today out either way. A failure falls back to
  // the fixed 2M bar and never breaks the poll.
  let dailyOutputTokensFloor = TOP_TIER_FLOOR;
  try {
    dailyOutputTokensFloor = topTierThreshold(claudemonDir, dateKST);
  } catch (e) {
    // keep TOP_TIER_FLOOR
  }

  const stageState = {
    stageId: TREE.stages[0].id,
    dailyOutputTokens: outputTokens,
    dailyOutputTokensFloor,
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

  // Feeds tomorrow's superultimate bar. A failed write only leaves today out
  // of the window, so it is caught the same way as the mon history above.
  try {
    recordTokenHistory(claudemonDir, dateKST, outputTokens);
  } catch (e) {
    // ignore - see comment above
  }

  // Today's branch through the global graph. Pinned for the day: once
  // daily.json holds today's route it is reused, so a mid-day rewrite can't
  // re-roll the form under the user. Rookie nodes that don't exist in the
  // graph get route: null (legacy stageNames-only packs).
  const graph = readGraph(graphFilePath());
  let route = null;
  let routeReasons = null;
  let dexField = null;
  if (graph && graph.byId.has(mon)) {
    const ctx = {
      dailyOutputTokens: outputTokens,
      dailyOutputTokensFloor,
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
    const pinnedReasons = previous && previous.dateKST === dateKST && previous.mon === mon && previous.routeReasons
      ? previous.routeReasons
      : null;
    // random: true is what makes a stage's tie-break, the moment it's first
    // reached, a genuine Math.random draw instead of the date hash (see
    // pick's and selectRoute's doc comments) - the "last-moment lottery" of
    // docs/lazy-route-plan.md §3. Passed unconditionally (route: pinned may
    // itself be null on the day's first run) so the very first stage drawn
    // today gets it too, not just later ones. Safe because every stage
    // already pinned in `pinned` is looked up and reused before pick() is
    // ever called (selectRoute's lock-check), so this can only draw a stage
    // that has no recorded value yet - never re-roll one that does.
    const { route: fullRoute, routeReasons: fullReasons } = selectRoute(dateKST, mon, graph, ctx,
                        { route: pinned, routeReasons: pinnedReasons, throughStage: stageState.stageId, random: true });

    // A-2 (docs/lazy-route-plan.md §3): keep only the stages actually
    // reached today - route grows across the day (append-only, see the
    // lock-check above) instead of exposing the whole lineage's future at
    // midnight. Must happen before terminalFrom below: with the full route,
    // terminalFrom reads as "where will this lineage end" (a spoiler);
    // truncated first, it reads as "has this lineage already ended", which
    // starts out null and only appears once the terminal stage is actually
    // reached.
    const reachedIdx = TREE.stages.findIndex((s) => s.id === stageState.stageId);
    const truncatedRoute = {};
    const truncatedReasons = {};
    for (let i = 0; i <= reachedIdx; i++) {
      const stageId = TREE.stages[i].id;
      if (fullRoute[stageId]) truncatedRoute[stageId] = fullRoute[stageId];
      if (fullReasons[stageId]) truncatedReasons[stageId] = fullReasons[stageId];
    }
    route = truncatedRoute;
    routeReasons = truncatedReasons;

    // Dex (도감): today's route is confirmed here, so its nodes are recorded
    // now. Lazy-route can still grow the route on later polls; recordDex
    // replaces today's day entry each time. Observational - a dex failure
    // must not break the daily.json write or the poll. If dex.json cannot be
    // written, count from the in-memory merge instead so the menu still
    // shows numbers.
    const routeIds = routeNodeIdsOf(route);
    let dexState;
    try {
      dexState = recordDex(claudemonDir, dateKST, routeIds);
    } catch (e) {
      dexState = readDex(claudemonDir);
      applyDexRoute(dexState, dateKST, routeIds);
    }
    try {
      dexField = dexFieldFor({
        dex: dexState,
        graph,
        dateKST,
        routeIds,
        packsDir,
        sharedDir,
        denylist: graph.denylist || readNodeDenylist()
      });
    } catch (e) {
      // keep dexField null: daily.json is written without a dex block
    }
  }

  // Clamp: a line that ends early (terminal, see isTerminal) must not show
  // stageState.stageId past it just because the day's token count alone
  // would justify a higher global stage - the mon itself has nowhere left
  // to go. Found by re-resolving each route entry's id against the node it
  // came from (route entries are plain strings for the menubar's sake, see
  // below) rather than by tagging route itself, so this works whether the
  // terminal node's stage is one `tree` declares directly or one walk()
  // filled in past where the pack's tree stops.
  //
  // terminalFrom: derived from childrenOf (no flag - §B-1). A node is
  // terminal when no children evolve from it. readDailyState.swift casts
  // route as `[String: [String: String]]`, so this stays a top-level field
  // rather than nested inside route entries.
  let terminalFrom = null;
  if (graph && route) {
    for (const stageDef of TREE.stages) {
      const entry = route[stageDef.id];
      if (!entry) continue;
      const node = graph.byId.get(entry.id);
      // Terminal when childrenOf has no entries for this node
      if (node && (graph.childrenOf.get(node.id) || []).length === 0) {
        terminalFrom = stageDef.id;
        break;
      }
    }
    if (terminalFrom) {
      const terminalIdx = TREE.stages.findIndex((s) => s.id === terminalFrom);
      const currentIdx = TREE.stages.findIndex((s) => s.id === stageState.stageId);
      if (currentIdx > terminalIdx) stageState.stageId = terminalFrom;
    }
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
  if (terminalFrom) result.terminalFrom = terminalFrom;
  if (routeReasons) result.routeReasons = routeReasons;
  if (dexField) result.dex = dexField;

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
  graphFilePath,
  cacheFilePath,
  dailyFilePath,
  monHistoryFilePath,
  readMonHistory,
  recordMonHistory,
  MON_HISTORY_MAX,
  DEX_VERSION,
  dexFilePath,
  readDex,
  recordDex,
  applyDexRoute,
  routeNodeIdsOf,
  reachableNodes,
  hintFor,
  describeCondition,
  dexFieldFor,
  tokenHistoryFilePath,
  readTokenHistory,
  recordTokenHistory,
  topTierThreshold,
  nearestRank,
  TOKEN_HISTORY_MAX,
  TOP_TIER_FLOOR,
  dateKSTString,
  startOfDayKSTUtcMs,
  listJsonlFiles,
  transcriptKey,
  scanFileIncrement,
  isRealUserTurn,
  isSubagentTranscript,
  listValidPacks,
  listRotationPacks,
  linksWithDots,
  readNodeDenylist,
  defaultDenylistPath,
  packDeclaresStage,
  topStageId,
  hashString,
  selectMon,
  readGraph,
  validateGraph,
  daySignals,
  activeTraits,
  selectRoute,
  candidatesFor
};
