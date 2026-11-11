#!/usr/bin/env node
// C4 lazy-route simulator: measures how concentrated the final form is under
// the dex tilt (docs/dex-weighting.md). Runs the real selectRoute, selectMon
// and applyDexRoute from lib/daily.js, so it does not re-implement the draw.
//
// What it mirrors from computeDailyTokens:
//   - a day is walked stage by stage as dailyOutputTokens grows; each stage
//     reach is one selectRoute call with the ctx of that moment, and the
//     route is pinned up to the reached stage (lazy binding, A-2);
//   - the reached route is folded into the dex after every call;
//   - the rookie comes from the real selectMon with yesterday's pack as avoid.
//
// What it assumes (not measured from the user's data, by design):
//   - the day's output tokens are lognormal (SIM_TOKENS_MEDIAN, SIM_TOKENS_SIGMA);
//   - output per turn is lognormal (SIM_PER_TURN_MEDIAN, SIM_PER_TURN_SIGMA);
//   - sessions and top-session share and failure ratio are drawn per day;
//   - inside a day, sessionCount and dailyUserTurns grow in proportion to
//     the tokens reached; per-turn output and the shares stay constant.
// The superultimate bar is the real topTierThreshold rule (P90 of the last
// TOP_TIER_WINDOW days, floored at 2M), computed in memory from the simulated
// days, never from a real state directory.
//
// Determinism: the day inputs come from one fixed-seed stream that is
// generated once per trial and reused by every scenario, so scenarios differ
// only in the dex multipliers. Math.random (used by lazy draws) is replaced
// by a second fixed-seed stream that is reset per scenario and trial.
//
// Run: node scripts/sim-lazy-route.js

const fs = require('fs');
const path = require('path');

const {
  selectRoute,
  selectMon,
  readGraph,
  graphFilePath,
  defaultPacksDir,
  defaultSharedDir,
  readNodeDenylist,
  applyDexRoute,
  routeNodeIdsOf,
  buildDexWeighting,
  nearestRank,
  TOP_TIER_WINDOW,
  TOP_TIER_PERCENTILE,
  DEX_WEIGHT_SCALE
} = require('../lib/daily');
const { TREE, applyEvolution } = require('../lib/evolve');

const SIM_SEED = 20261111;
const SIM_TRIALS = 40;
const SIM_DAYS = 365;
const SIM_START_DATE = '2027-01-01';
const SIM_TOKENS_MEDIAN = 800000;
const SIM_TOKENS_SIGMA = 1.0;
const SIM_PER_TURN_MEDIAN = 9000;
const SIM_PER_TURN_SIGMA = 0.5;
const SIM_TOP_TIER_FLOOR = 2000000;
const SIM_LEVEL_RATIO = 1.03;
const SIM_STAGE_BARS = [30000, 100000, 300000, 1000000];
const SIM_REPO_NODES_DIR = path.join(__dirname, '..', 'sprites', 'nodes');
const SIM_G2_SHARE_PCT = 12.2;

const SCENARIO_BASELINE = { name: '기준선(배수 없음)', cfg: null };

// Every scenario keeps DEX_WEIGHT_SCALE; only the multipliers change.
const SCENARIOS = [
  SCENARIO_BASELINE,
  { name: '미발견 x3 단독', cfg: { undiscoveredMult: 3, recentMult: 1 } },
  { name: '감점 x0.5 단독', cfg: { undiscoveredMult: 1, recentMult: 0.5 } },
  { name: 'x3 / x0.5', cfg: { undiscoveredMult: 3, recentMult: 0.5 } },
  { name: 'x3 / x0.25', cfg: { undiscoveredMult: 3, recentMult: 0.25 } },
  { name: 'x4 / x0.5', cfg: { undiscoveredMult: 4, recentMult: 0.5 } },
  { name: 'x4 / x0.25', cfg: { undiscoveredMult: 4, recentMult: 0.25 } },
  { name: 'x5 / x0.5', cfg: { undiscoveredMult: 5, recentMult: 0.5 } },
  { name: 'x5 / x0.25', cfg: { undiscoveredMult: 5, recentMult: 0.25 } }
];

// Combos eligible for the confirmed value (the draft's x3~x5 by x0.5~x0.25).
const SELECTION_COMBOS = SCENARIOS.filter((s) => s.cfg && s.cfg.recentMult < 1 && s.cfg.undiscoveredMult > 1);

// --- PRNG (state object; no closures, so no nested functions) ---------------

function nextRandom(rng) {
  rng.s = (rng.s + 0x6D2B79F5) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function gaussian(rng) {
  const u1 = Math.max(nextRandom(rng), 1e-12);
  const u2 = nextRandom(rng);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function lognormal(rng, median, sigma) {
  return median * Math.exp(sigma * gaussian(rng));
}

function dateAddDays(dateKST, days) {
  const ms = Date.parse(`${dateKST}T00:00:00Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// --- day inputs (generated once per trial, shared by all scenarios) ---------

function makeDayInputs(trial) {
  const rng = { s: SIM_SEED + trial * 7919 };
  const days = [];
  for (let i = 0; i < SIM_DAYS; i++) {
    const tokens = Math.round(lognormal(rng, SIM_TOKENS_MEDIAN, SIM_TOKENS_SIGMA));
    const perTurn = Math.max(1, Math.round(lognormal(rng, SIM_PER_TURN_MEDIAN, SIM_PER_TURN_SIGMA)));
    const turns = Math.max(1, Math.round(tokens / perTurn));
    const sessions = Math.max(1, Math.round(turns / 25 + nextRandom(rng) * 3));
    days.push({
      dateKST: dateAddDays(SIM_START_DATE, trial * SIM_DAYS + i),
      tokens,
      turns,
      perTurn: tokens / turns,
      sessions,
      topShare: 0.3 + 0.7 * nextRandom(rng),
      failRatio: 0.1 * nextRandom(rng),
      levels: levelsFor(tokens)
    });
  }
  return days;
}

// Token levels at which a poll could cross a stage bar: a geometric grid plus
// the exact bars, so a stage is reached at most ~3% late (and exactly at the
// bars themselves).
function levelsFor(tokens) {
  const set = new Set([0, tokens]);
  for (let v = 1; v < tokens; v = Math.ceil(v * SIM_LEVEL_RATIO)) set.add(v);
  for (const bar of SIM_STAGE_BARS) if (bar <= tokens) set.add(bar);
  if (SIM_TOP_TIER_FLOOR <= tokens) set.add(SIM_TOP_TIER_FLOOR);
  return [...set].sort((a, b) => a - b);
}

// Superultimate bar for each day, computed from the simulated history like
// topTierThreshold does (today excluded, P90 of the last 14 days, floor 2M).
function floorsFor(days) {
  return days.map((_, i) => {
    if (i < TOP_TIER_WINDOW) return SIM_TOP_TIER_FLOOR;
    const recent = days.slice(i - TOP_TIER_WINDOW, i).map((d) => d.tokens).sort((a, b) => a - b);
    return Math.max(nearestRank(recent, TOP_TIER_PERCENTILE), SIM_TOP_TIER_FLOOR);
  });
}

// --- day walk (mirrors computeDailyTokens' poll loop at stage reaches) ------

function reachedIndex(stageId) {
  return TREE.stages.findIndex((s) => s.id === stageId);
}

function truncateTo(full, stageId) {
  const cut = {};
  const idx = reachedIndex(stageId);
  for (let i = 0; i <= idx; i++) {
    const id = TREE.stages[i].id;
    if (full[id]) cut[id] = full[id];
  }
  return cut;
}

function dayCtx(day, level, floor, dex, cfg) {
  const f = level / day.tokens;
  const turns = day.turns * f;
  return {
    dailyOutputTokens: level,
    dailyOutputTokensFloor: floor,
    dailyUserTurns: turns,
    outputPerTurn: level / Math.max(1, turns),
    sessionCount: level > 0 ? Math.max(1, Math.round(day.sessions * f)) : 0,
    topSharePct: day.topShare * 100,
    failureRatioPct: day.failRatio * 100,
    global: {},
    dex: cfg ? buildDexWeighting(dex, day.dateKST, cfg) : null
  };
}

// Returns the day's end state: the superultimate slot of the full route at the
// last selectRoute call (primary metric), the form shown at day end, and
// whether the top stage was reached.
function walkDay(day, floor, mon, graph, dex, cfg) {
  let stageId = null;
  let pinned = null;
  let pinnedReasons = null;
  let lastFull = null;
  let lastShown = null;
  for (const level of day.levels) {
    const state = {
      stageId: stageId || TREE.stages[0].id,
      dailyOutputTokens: level,
      dailyOutputTokensFloor: floor,
      dailyUserTurns: day.turns * (level / day.tokens),
      outputPerTurn: level / Math.max(1, day.turns * (level / day.tokens))
    };
    applyEvolution(state, {});
    if (state.stageId === stageId) continue;
    stageId = state.stageId;
    const ctx = dayCtx(day, level, floor, dex, cfg);
    const locked = { route: pinned, routeReasons: pinnedReasons, throughStage: stageId, random: true };
    const { route: full, routeReasons: fullReasons } = selectRoute(day.dateKST, mon, graph, ctx, locked);
    const cut = truncateTo(full, stageId);
    const cutReasons = {};
    for (const id of Object.keys(cut)) if (fullReasons[id]) cutReasons[id] = fullReasons[id];
    pinned = cut;
    pinnedReasons = cutReasons;
    applyDexRoute(dex, day.dateKST, routeNodeIdsOf(cut));
    lastFull = full;
    lastShown = cut[stageId] ? cut[stageId].id : null;
  }
  return {
    topId: lastFull && lastFull.superultimate ? lastFull.superultimate.id : null,
    shownId: lastShown,
    reachedTop: stageId === 'superultimate'
  };
}

// --- scenario runner ---------------------------------------------------------

// fs.existsSync is consulted once per link per stage (linksWithDots); the
// answer never changes during a run, so memoize it for the simulation.
const existsCache = new Map();
const realExistsSync = fs.existsSync;

function cachedExistsSync(p) {
  if (!existsCache.has(p)) existsCache.set(p, realExistsSync(p));
  return existsCache.get(p);
}

function emptyDexObject() {
  return { version: 1, nodes: {}, days: {} };
}

function runTrial(days, floors, graph, packsDir, sharedDir, cfg, rngSeed) {
  const random = { s: rngSeed };
  const realRandom = Math.random;
  Math.random = () => nextRandom(random);
  const dex = emptyDexObject();
  const results = [];
  let prevMon = null;
  try {
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const mon = selectMon(day.dateKST, packsDir, sharedDir, prevMon);
      prevMon = mon;
      if (!graph.byId.has(mon)) {
        results.push(null);
        continue;
      }
      results.push(walkDay(day, floors[i], mon, graph, dex, cfg));
    }
  } finally {
    Math.random = realRandom;
  }
  return results;
}

function tally(results) {
  const counts = new Map();
  const shown = new Map();
  let reachedTop = 0;
  let total = 0;
  for (const r of results) {
    if (!r || !r.topId) continue;
    total += 1;
    counts.set(r.topId, (counts.get(r.topId) || 0) + 1);
    if (r.shownId) shown.set(r.shownId, (shown.get(r.shownId) || 0) + 1);
    if (r.reachedTop) reachedTop += 1;
  }
  return { counts, shown, reachedTop, total };
}

function topShare(counts, total) {
  let best = 0;
  for (const c of counts.values()) best = Math.max(best, c);
  return total > 0 ? (best / total) * 100 : 0;
}

function effectiveSpecies(counts, total) {
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log(p);
  }
  return Math.exp(h);
}

function summarize(scenario, trialResults) {
  const all = [];
  const second = [];
  const trialShares = [];
  for (const results of trialResults) {
    all.push(...results);
    second.push(...results.slice(Math.floor(results.length / 2)));
    trialShares.push(topShare(tally(results).counts, tally(results).total));
  }
  const full = tally(all);
  const half = tally(second);
  return {
    name: scenario.name,
    cfg: scenario.cfg,
    share: topShare(full.counts, full.total),
    species: effectiveSpecies(full.counts, full.total),
    unique: full.counts.size,
    shownShare: topShare(full.shown, full.total),
    shownSpecies: effectiveSpecies(full.shown, full.total),
    reachRate: full.total > 0 ? (full.reachedTop / full.total) * 100 : 0,
    secondHalfShare: topShare(half.counts, half.total),
    secondHalfSpecies: effectiveSpecies(half.counts, half.total),
    trialMin: Math.min(...trialShares),
    trialMax: Math.max(...trialShares),
    days: full.total
  };
}

function fmt(n, digits = 1) {
  return Number(n).toFixed(digits);
}

// Ranks the x3~x5 by x0.5~x0.25 combos: 1위 점유율(0.1%p) 낮은 순, 같으면 유효
// 종 수 큰 순, 그래도 같으면 변화 폭(미발견 배수-1 + 1-감점 배수) 작은 순.
function changeWidth(cfg) {
  return (cfg.undiscoveredMult - 1) + (1 - cfg.recentMult);
}

function rankCombos(summaries) {
  const combos = summaries.filter((s) => s.cfg && SELECTION_COMBOS.some((c) => c.name === s.name));
  return combos.slice().sort((a, b) => {
    const sa = Math.round(a.share * 10);
    const sb = Math.round(b.share * 10);
    if (sa !== sb) return sa - sb;
    if (b.species !== a.species) return b.species - a.species;
    return changeWidth(a.cfg) - changeWidth(b.cfg);
  });
}

function main() {
  const graph = readGraph(graphFilePath());
  if (!graph) throw new Error('evolution-graph.json 을 읽지 못했다');
  graph.nodesDir = SIM_REPO_NODES_DIR;
  graph.denylist = readNodeDenylist();
  const packsDir = defaultPacksDir();
  const sharedDir = defaultSharedDir();

  const inputs = [];
  for (let t = 0; t < SIM_TRIALS; t++) inputs.push(makeDayInputs(t));
  const floors = inputs.map((days) => floorsFor(days));

  const realExists = fs.existsSync;
  fs.existsSync = cachedExistsSync;
  const summaries = [];
  try {
    for (const scenario of SCENARIOS) {
      const trialResults = [];
      for (let t = 0; t < SIM_TRIALS; t++) {
        trialResults.push(runTrial(inputs[t], floors[t], graph, packsDir, sharedDir, scenario.cfg, SIM_SEED ^ (t * 104729 + 1)));
      }
      summaries.push(summarize(scenario, trialResults));
    }
  } finally {
    fs.existsSync = realExists;
  }

  printReport(summaries);
}

function printReport(summaries) {
  console.log(`# lazy-route 도감 가중치 시뮬 (SEED ${SIM_SEED}, trials ${SIM_TRIALS}, days ${SIM_DAYS}, scale ${DEX_WEIGHT_SCALE})`);
  console.log('');
  console.log('| 조합 | 미발견 | 감점 | 1위 점유율(%) | 유효 종 수 | 고유 종 | 1위 점유율 후반(%) | 유효 종 수 후반 | 표시 최종형 1위(%) | 최상위 도달(%) | trial 1위 min-max(%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const u = s.cfg ? `x${s.cfg.undiscoveredMult}` : '-';
    const r = s.cfg ? `x${s.cfg.recentMult}` : '-';
    console.log(`| ${s.name} | ${u} | ${r} | ${fmt(s.share)} | ${fmt(s.species, 2)} | ${s.unique} | ${fmt(s.secondHalfShare)} | ${fmt(s.secondHalfSpecies, 2)} | ${fmt(s.shownShare)} | ${fmt(s.reachRate)} | ${fmt(s.trialMin)}-${fmt(s.trialMax)} |`);
  }
  console.log('');
  const ranked = rankCombos(summaries);
  const pick = ranked[0];
  console.log(`확정 조합 후보 순위(1위 점유율 0.1%p 기준 → 유효 종 수 → 변화 폭): ${ranked.map((s) => s.name).join(' > ')}`);
  const baseline = summaries.find((s) => s.name === SCENARIO_BASELINE.name);
  console.log(`기준선 1위 점유율 ${fmt(baseline.share)}%, 확정 후보 ${pick.name} 1위 점유율 ${fmt(pick.share)}% (${pick.share < SIM_G2_SHARE_PCT ? '12.2% 미만' : '12.2% 이상'})`);
  console.log(`확정 수치: undiscoveredMult=${pick.cfg.undiscoveredMult}, recentMult=${pick.cfg.recentMult}`);
}

main();
