// Run: node --test test/evolve.test.js
//
// Unit tests for the condition engine that route selection (lib/daily.js)
// gates edges through. checkCondition itself isn't exported - every case
// here goes through conditionMet with a bare (non-`all`, non-`and`)
// condition, which is exactly checkCondition's behavior for that shape.

const test = require('node:test');
const assert = require('node:assert');

const { conditionMet } = require('../lib/evolve');

// --- checkCondition: new types -----------------------------------------

test('sessionCount gates on ctx.sessionCount >= gte', () => {
  assert.strictEqual(conditionMet({ type: 'sessionCount', gte: 5 }, { sessionCount: 5 }), true);
  assert.strictEqual(conditionMet({ type: 'sessionCount', gte: 5 }, { sessionCount: 4 }), false);
  assert.strictEqual(conditionMet({ type: 'sessionCount', gte: 5 }, { sessionCount: 6 }), true);
});

test('sessionCount treats a missing ctx field as 0', () => {
  assert.strictEqual(conditionMet({ type: 'sessionCount', gte: 1 }, {}), false);
  assert.strictEqual(conditionMet({ type: 'sessionCount', gte: 0 }, {}), true);
});

test('topSharePct gates on gte', () => {
  assert.strictEqual(conditionMet({ type: 'topSharePct', gte: 60 }, { topSharePct: 60 }), true);
  assert.strictEqual(conditionMet({ type: 'topSharePct', gte: 60 }, { topSharePct: 59.9 }), false);
  assert.strictEqual(conditionMet({ type: 'topSharePct', gte: 60 }, { topSharePct: 80 }), true);
});

test('topSharePct gates on lte', () => {
  assert.strictEqual(conditionMet({ type: 'topSharePct', lte: 30 }, { topSharePct: 30 }), true);
  assert.strictEqual(conditionMet({ type: 'topSharePct', lte: 30 }, { topSharePct: 30.1 }), false);
  assert.strictEqual(conditionMet({ type: 'topSharePct', lte: 30 }, { topSharePct: 10 }), true);
});

test('topSharePct treats a missing ctx field as 0', () => {
  assert.strictEqual(conditionMet({ type: 'topSharePct', gte: 10 }, {}), false);
  assert.strictEqual(conditionMet({ type: 'topSharePct', lte: 10 }, {}), true);
});

test('failureRatioPct gates on gte', () => {
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', gte: 5 }, { failureRatioPct: 5 }), true);
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', gte: 5 }, { failureRatioPct: 4.9 }), false);
});

test('failureRatioPct gates on lte', () => {
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', lte: 5 }, { failureRatioPct: 5 }), true);
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', lte: 5 }, { failureRatioPct: 5.1 }), false);
});

test('failureRatioPct treats a missing ctx field as 0', () => {
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', gte: 1 }, {}), false);
  assert.strictEqual(conditionMet({ type: 'failureRatioPct', lte: 1 }, {}), true);
});

test('an unknown condition type is false, not a throw', () => {
  assert.strictEqual(conditionMet({ type: 'nonsenseType', gte: 1 }, { nonsenseType: 999 }), false);
});

// --- conditionMet: composition ------------------------------------------

test('all: every sub-condition passing is true', () => {
  const when = {
    all: [
      { type: 'sessionCount', gte: 5 },
      { type: 'failureRatioPct', lte: 5 }
    ]
  };
  assert.strictEqual(conditionMet(when, { sessionCount: 5, failureRatioPct: 0 }), true);
});

test('all: one sub-condition failing makes the whole thing false', () => {
  const when = {
    all: [
      { type: 'sessionCount', gte: 5 },
      { type: 'failureRatioPct', lte: 5 }
    ]
  };
  assert.strictEqual(conditionMet(when, { sessionCount: 5, failureRatioPct: 10 }), false);
});

test('all: [] is vacuously true', () => {
  assert.strictEqual(conditionMet({ all: [] }, {}), true);
});

test('nested all actually recurses (regression for the old and-only-once limit)', () => {
  const when = {
    all: [
      { type: 'sessionCount', gte: 1 },
      { all: [
        { type: 'topSharePct', gte: 10 },
        { type: 'failureRatioPct', lte: 50 }
      ] }
    ]
  };
  assert.strictEqual(
    conditionMet(when, { sessionCount: 1, topSharePct: 10, failureRatioPct: 50 }),
    true
  );
  assert.strictEqual(
    conditionMet(when, { sessionCount: 1, topSharePct: 5, failureRatioPct: 50 }),
    false
  );
});

// --- conditionMet: `any` (all's symmetric counterpart) -----------------
//
// Added for the "설계 날" (sage day) gate: a stage needs to reach either
// the usual token threshold OR the sage-day alternative, so applyEvolution
// (which already routes stage progression through conditionMet) needs an
// OR combinator with the same recursive shape `all` has.

test('any: one sub-condition passing is enough', () => {
  const when = {
    any: [
      { type: 'dailyOutputTokens', gte: 1000000 },
      { type: 'dailyUserTurns', gte: 80 }
    ]
  };
  assert.strictEqual(conditionMet(when, { dailyOutputTokens: 0, dailyUserTurns: 80 }), true);
  assert.strictEqual(conditionMet(when, { dailyOutputTokens: 1000000, dailyUserTurns: 0 }), true);
});

test('any: every sub-condition failing makes the whole thing false', () => {
  const when = {
    any: [
      { type: 'dailyOutputTokens', gte: 1000000 },
      { type: 'dailyUserTurns', gte: 80 }
    ]
  };
  assert.strictEqual(conditionMet(when, { dailyOutputTokens: 0, dailyUserTurns: 0 }), false);
});

test('any: [] is never met (the symmetric opposite of all: [])', () => {
  assert.strictEqual(conditionMet({ any: [] }, {}), false);
});

test('any nests inside all and vice versa', () => {
  const when = {
    all: [
      { type: 'dailyUserTurns', gte: 80 },
      { any: [
        { type: 'outputPerTurn', lte: 6000 },
        { type: 'dailyOutputTokens', gte: 1000000 }
      ] }
    ]
  };
  assert.strictEqual(
    conditionMet(when, { dailyUserTurns: 80, outputPerTurn: 5000, dailyOutputTokens: 0 }),
    true
  );
  assert.strictEqual(
    conditionMet(when, { dailyUserTurns: 80, outputPerTurn: 9000, dailyOutputTokens: 0 }),
    false
  );
});

test('dailyUserTurns gates on ctx.dailyUserTurns >= gte', () => {
  assert.strictEqual(conditionMet({ type: 'dailyUserTurns', gte: 80 }, { dailyUserTurns: 80 }), true);
  assert.strictEqual(conditionMet({ type: 'dailyUserTurns', gte: 80 }, { dailyUserTurns: 79 }), false);
});

test('outputPerTurn gates on lte and gte', () => {
  assert.strictEqual(conditionMet({ type: 'outputPerTurn', lte: 6000 }, { outputPerTurn: 6000 }), true);
  assert.strictEqual(conditionMet({ type: 'outputPerTurn', lte: 6000 }, { outputPerTurn: 6001 }), false);
  assert.strictEqual(conditionMet({ type: 'outputPerTurn', gte: 100 }, { outputPerTurn: 99 }), false);
});

test('legacy 2-item `and` matches the equivalent all: [a, b]', () => {
  const withAnd = { type: 'sessionCount', gte: 1, and: { type: 'topSharePct', gte: 10 } };
  const withAll = { all: [{ type: 'sessionCount', gte: 1 }, { type: 'topSharePct', gte: 10 }] };
  for (const ctx of [{ sessionCount: 1, topSharePct: 10 }, { sessionCount: 0, topSharePct: 10 }]) {
    assert.strictEqual(conditionMet(withAnd, ctx), conditionMet(withAll, ctx));
  }
});

test('and now recurses through a chained and.and (old limit: only the first and was checked)', () => {
  const chained = {
    type: 'sessionCount',
    gte: 1,
    and: { type: 'topSharePct', gte: 10, and: { type: 'failureRatioPct', lte: 5 } }
  };
  assert.strictEqual(
    conditionMet(chained, { sessionCount: 1, topSharePct: 10, failureRatioPct: 5 }),
    true
  );
  assert.strictEqual(
    conditionMet(chained, { sessionCount: 1, topSharePct: 10, failureRatioPct: 50 }),
    false
  );
});

test('when: null or undefined is the unconditional edge', () => {
  assert.strictEqual(conditionMet(null, {}), true);
  assert.strictEqual(conditionMet(undefined, {}), true);
});
