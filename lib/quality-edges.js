// C6 quality-axis edges in evolution-graph.json (D-10). Shared by the graph
// generator (scripts/add-quality-conditions.js), the audit's --quality check
// (scripts/audit-canon-edges.js), and the real-graph test in test/daily.test.js.
//
// Rules, all weight-only (see evolve.js):
//   - at most QUALITY_EDGE_CAP edges carry a quality condition
//   - one per parent, and only on parents with fan-out >= QUALITY_MIN_FAN_OUT
//   - parents are ranked by fan-out (desc), then id (asc); the rank decides
//     the axis: even rank -> QUALITY_AXES[0], odd rank -> QUALITY_AXES[1]
//
// Measured on 2026-11-11: 117 parents have fan-out >= 4. The cap keeps the 111
// with the largest fan-out. The six left out are the fan-out-4 parents that
// sort last by id.

const { QUALITY_CONDITION_TYPES, isQualityCondition } = require('./evolve');

const QUALITY_EDGE_CAP = 111;
const QUALITY_MIN_FAN_OUT = 4;
const QUALITY_AXES = QUALITY_CONDITION_TYPES;

function fanOutMap(graph) {
  const fan = new Map();
  for (const node of graph.nodes || []) {
    for (const edge of node.evolvesFrom || []) {
      fan.set(edge.from, (fan.get(edge.from) || 0) + 1);
    }
  }
  return fan;
}

// Fan-out descending, then parent id ascending by code point. Both the
// generator and the audit sort with this, so the axis alternation can be
// checked from the graph alone.
function sortByFanThenId(parentIds, fan) {
  return [...parentIds].sort((a, b) => {
    const diff = (fan.get(b) || 0) - (fan.get(a) || 0);
    if (diff !== 0) return diff;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

// Parents eligible for a quality edge, in rank order: fan-out >= 4 and at
// least one unconditional edge to put the condition on. Not truncated.
function rankQualityParents(graph) {
  const fan = fanOutMap(graph);
  const hasUnconditional = new Set();
  for (const node of graph.nodes || []) {
    for (const edge of node.evolvesFrom || []) {
      if (edge.when === null || edge.when === undefined) hasUnconditional.add(edge.from);
    }
  }
  const eligible = [...fan.keys()].filter(
    (parent) => fan.get(parent) >= QUALITY_MIN_FAN_OUT && hasUnconditional.has(parent)
  );
  return sortByFanThenId(eligible, fan);
}

// True when the condition mentions a quality axis anywhere it cannot be read
// as a plain leaf: inside all/any/and, or with a gte that is neither 'p50' nor
// a number. Returns a short reason, or null when the shape is fine.
function hasQualityLeaf(when) {
  if (!when) return false;
  if (Array.isArray(when.all)) return when.all.some(hasQualityLeaf);
  if (Array.isArray(when.any)) return when.any.some(hasQualityLeaf);
  if (QUALITY_CONDITION_TYPES.includes(when.type)) return true;
  return hasQualityLeaf(when.and);
}

function qualityShapeProblem(when) {
  if (!hasQualityLeaf(when)) return null;
  if (!isQualityCondition(when)) return 'nested';
  if (!(when.gte === 'p50' || Number.isFinite(when.gte))) return 'bad-gte';
  return null;
}

// Audits the graph against the C6 rules. `violations` is empty when the graph
// is valid. `perAxis` counts the quality edges per axis.
function auditQualityEdges(graph) {
  const fan = fanOutMap(graph);
  const quality = [];
  const violations = [];
  for (const node of graph.nodes || []) {
    for (const edge of node.evolvesFrom || []) {
      const problem = qualityShapeProblem(edge.when);
      if (problem) violations.push(`shape: ${node.id} <- ${edge.from} (${problem})`);
      if (isQualityCondition(edge.when)) {
        quality.push({ parent: edge.from, child: node.id, axis: edge.when.type });
      }
    }
  }

  const perAxis = Object.fromEntries(QUALITY_AXES.map((axis) => [axis, 0]));
  const axisByParent = new Map();
  const countByParent = new Map();
  for (const q of quality) {
    perAxis[q.axis] += 1;
    axisByParent.set(q.parent, q.axis);
    countByParent.set(q.parent, (countByParent.get(q.parent) || 0) + 1);
  }

  if (quality.length > QUALITY_EDGE_CAP) {
    violations.push(`over-cap: ${quality.length} > ${QUALITY_EDGE_CAP}`);
  }
  for (const [parent, n] of countByParent) {
    if (n > 1) violations.push(`multi-per-parent: ${parent} x${n}`);
    if ((fan.get(parent) || 0) < QUALITY_MIN_FAN_OUT) {
      violations.push(`low-fan-out: ${parent} (${fan.get(parent) || 0})`);
    }
  }

  const ordered = sortByFanThenId(countByParent.keys(), fan);
  ordered.forEach((parent, rank) => {
    const expected = QUALITY_AXES[rank % 2];
    if (axisByParent.get(parent) !== expected) {
      violations.push(`axis-alternation: rank ${rank} ${parent} expects ${expected}`);
    }
  });

  return { cap: QUALITY_EDGE_CAP, count: quality.length, perAxis, parents: countByParent.size, violations };
}

module.exports = {
  QUALITY_EDGE_CAP,
  QUALITY_MIN_FAN_OUT,
  QUALITY_AXES,
  fanOutMap,
  sortByFanThenId,
  rankQualityParents,
  qualityShapeProblem,
  auditQualityEdges
};
