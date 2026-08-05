const fs = require('fs');
const path = require('path');

const TREE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evolution-tree.json'), 'utf8'));

function stageById(id) {
  return TREE.stages.find((s) => s.id === id);
}

function checkCondition(cond, ctx) {
  if (!cond) return true;
  switch (cond.type) {
    case 'always':
      return true;
    case 'toolSuccessCount':
      return ctx.toolSuccessCount >= cond.gte;
    case 'globalToolSuccessCount':
      return (ctx.global.toolSuccessCount || 0) >= cond.gte;
    case 'errorRatePct': {
      const total = ctx.toolSuccessCount + ctx.toolFailureCount;
      const rate = total === 0 ? 0 : (ctx.toolFailureCount / total) * 100;
      return rate <= cond.lte;
    }
    case 'consecutiveDaysActive':
      return ctx.consecutiveDaysActive >= cond.gte;
    case 'milestone':
      return (ctx.milestones[cond.key] || 0) >= cond.gte;
    case 'dailyOutputTokens':
      return (ctx.dailyOutputTokens || 0) >= cond.gte;
    case 'sessionCount':
      return (ctx.sessionCount || 0) >= cond.gte;
    case 'topSharePct': {
      const pct = ctx.topSharePct || 0;
      if (cond.gte !== undefined && pct < cond.gte) return false;
      if (cond.lte !== undefined && pct > cond.lte) return false;
      return true;
    }
    case 'failureRatioPct': {
      const pct = ctx.failureRatioPct || 0;
      if (cond.gte !== undefined && pct < cond.gte) return false;
      if (cond.lte !== undefined && pct > cond.lte) return false;
      return true;
    }
    default:
      return false;
  }
}

// `all: [...]` is the general form; a bare condition is an implicit
// single-element `all`, and `and` is a two-item alias kept for pack.json
// files written before `all` existed. `undefined`/`null` (no condition
// declared - the guaranteed edge) and `all: []` both mean "always met".
function conditionMet(condition, ctx) {
  if (!condition) return true;
  if (Array.isArray(condition.all)) {
    return condition.all.every((c) => conditionMet(c, ctx));
  }
  const base = checkCondition(condition, ctx);
  if (condition.and) {
    return base && conditionMet(condition.and, ctx);
  }
  return base;
}

// Advances state.stageId as far as the current counters allow (handles
// multi-stage catch-up, e.g. simulate script firing 100 events at once).
// `global` carries the cross-session accumulator (see lib/state.js
// loadGlobal()) used by globalToolSuccessCount conditions; callers that
// omit it simply never satisfy those conditions.
function applyEvolution(state, global = {}) {
  const ctx = { ...state, global };
  let current = stageById(state.stageId) || TREE.stages[0];
  let changed = false;
  while (current.next) {
    const next = stageById(current.next);
    if (conditionMet(next.condition, ctx)) {
      state.stageId = next.id;
      current = next;
      changed = true;
    } else {
      break;
    }
  }
  return changed;
}

function applyRegression(state, now = new Date()) {
  const rule = TREE.regression;
  if (!rule) return false; // pack defines no regression (e.g. daily-reset packs)
  if (!state.lastActiveAt) return false;
  const hoursSince = (now - new Date(state.lastActiveAt)) / 36e5;
  if (hoursSince >= rule.gte && state.stageId !== rule.resetTo) {
    const targetIdx = TREE.stages.findIndex((s) => s.id === rule.resetTo);
    const currentIdx = TREE.stages.findIndex((s) => s.id === state.stageId);
    if (currentIdx > targetIdx) {
      state.stageId = rule.resetTo;
      return true;
    }
  }
  return false;
}

// Context-usage color shift applies regardless of stage (matches the
// "heat-map" behavior described in the PRD), not just the stage that
// happens to declare a `warning` block.
const CONTEXT_WARNING_THRESHOLD = 70;

function getWarning(state) {
  if ((state.contextUsagePct || 0) >= CONTEXT_WARNING_THRESHOLD) {
    return 'red';
  }
  return null;
}

module.exports = { TREE, stageById, applyEvolution, applyRegression, getWarning, conditionMet };
