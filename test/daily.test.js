// Run: node --test test/
//
// Regression tests for the daily mon rotation. These exist because of a
// concrete bug: a stray sprites/packs/.omc directory was admitted as a
// rotation candidate, which shifted every pack's index by one and -- in
// combination with a hash whose output moved by exactly +1 per day --
// pinned the rotation on the same mon two days running.
//
// No test framework, no package.json: node --test only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listValidPacks,
  listRotationPacks,
  topStageId,
  selectRoute,
  readTree,
  validatePackTree,
  activeTraits,
  hashString,
  selectMon,
  computeDailyTokens,
  listJsonlFiles,
  transcriptKey,
  isRealUserTurn,
  defaultPacksDir,
  cacheFilePath
} = require('../lib/daily');

// --- helpers ---------------------------------------------------------

// Builds an isolated sprite root so no test depends on what actually
// lives in sprites/packs (the real tree is what the .omc bug polluted).
function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemon-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    packsDir: path.join(root, 'packs'),
    sharedDir: path.join(root, 'shared'),
    claudemonDir: path.join(root, 'claudemon'),
    projectsDir: path.join(root, 'projects')
  };
}

// Writes a pack that is also a rotation candidate: pack.json names the
// tree's top stage, which is what listRotationPacks requires. Pass
// `{ topStage: false }` for a line that stops short of it.
function writePack(packsDir, name, files, { topStage = true } = {}) {
  const dir = path.join(packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'png');
  const stageNames = { child: name };
  if (topStage) stageNames[topStageId()] = `${name}-최종체`;
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ name, stageNames }, null, 2));
}

function writeSharedEgg(sharedDir) {
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'digitama-0.png'), 'png');
}

// A complete pack: everything listValidPacks requires.
const FULL = ['idle-0.png', 'digitama-0.png'];

function dateAt(dayOffset) {
  // 03:00 UTC == noon KST, safely inside the KST day either way.
  return new Date(Date.UTC(2026, 6, 29 + dayOffset, 3, 0, 0));
}

function dateKeys(count) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  }
  return keys;
}

// --- listValidPacks --------------------------------------------------

test('listValidPacks skips dot-directories', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writePack(packsDir, 'agumon', FULL);
  // The exact shape of the real regression: OMC state written into the
  // pack directory. It has no sprites, and it sorts before every real
  // pack, so admitting it shifts the whole rotation.
  fs.mkdirSync(path.join(packsDir, '.omc', 'state'), { recursive: true });
  writeSharedEgg(sharedDir);

  assert.deepStrictEqual(listValidPacks(packsDir, sharedDir), ['agumon']);
});

test('listValidPacks requires idle-0.png', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writePack(packsDir, 'withidle', FULL);
  // The menubar app refuses to switch to a pack lacking idle-0.png, so a
  // pack without one must not win the draw either -- it would silently
  // leave yesterday's mon on screen.
  writePack(packsDir, 'noidle', ['digitama-0.png']);
  writeSharedEgg(sharedDir);

  assert.deepStrictEqual(listValidPacks(packsDir, sharedDir), ['withidle']);
});

test('listValidPacks accepts a pack without its own egg when the shared egg exists', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writePack(packsDir, 'ownegg', FULL);
  writePack(packsDir, 'sharedegg', ['idle-0.png']);
  writeSharedEgg(sharedDir);

  assert.deepStrictEqual(listValidPacks(packsDir, sharedDir), ['ownegg', 'sharedegg']);
});

test('listValidPacks rejects an eggless pack when there is no shared egg', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writePack(packsDir, 'ownegg', FULL);
  writePack(packsDir, 'sharedegg', ['idle-0.png']);
  // sharedDir deliberately not created.

  assert.deepStrictEqual(listValidPacks(packsDir, sharedDir), ['ownegg']);
});

test('listValidPacks ignores plain files and returns sorted names', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['veemon', 'agumon', 'impmon']) writePack(packsDir, name, FULL);
  fs.writeFileSync(path.join(packsDir, 'README.txt'), 'not a pack');
  writeSharedEgg(sharedDir);

  assert.deepStrictEqual(listValidPacks(packsDir, sharedDir), ['agumon', 'impmon', 'veemon']);
});

test('listValidPacks returns [] when packsDir is missing', (t) => {
  const { root, sharedDir } = makeRoot(t);
  assert.deepStrictEqual(listValidPacks(path.join(root, 'nope'), sharedDir), []);
});

// --- hashString ------------------------------------------------------

test('hashString is deterministic', () => {
  assert.strictEqual(hashString('2026-07-29'), hashString('2026-07-29'));
});

test('hashString avalanches consecutive dates apart', () => {
  // The bug's other half: with a bare h*31+c accumulator, dates one day
  // apart hashed to values exactly 1 apart, making the pack index a
  // sequential walk that any list-length change could cancel out.
  const keys = dateKeys(120);
  for (let i = 1; i < keys.length; i++) {
    const delta = Math.abs(hashString(keys[i]) - hashString(keys[i - 1]));
    assert.notStrictEqual(delta, 1, `${keys[i - 1]} -> ${keys[i]} still differs by 1`);
  }
});

// --- selectMon -------------------------------------------------------

test('selectMon is idempotent for the same date', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['agumon', 'gabumon', 'impmon']) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  const first = selectMon('2026-07-30', packsDir, sharedDir, null);
  assert.strictEqual(selectMon('2026-07-30', packsDir, sharedDir, null), first);
  assert.strictEqual(selectMon('2026-07-30', packsDir, sharedDir, null), first);
});

test('selectMon falls back to guilmon with no candidates', (t) => {
  const { root, sharedDir } = makeRoot(t);
  assert.strictEqual(selectMon('2026-07-30', path.join(root, 'nope'), sharedDir, null), 'guilmon');
});

test('selectMon steps away from avoidMon', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['aa', 'bb', 'cc']) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  const unguarded = selectMon('2026-07-30', packsDir, sharedDir, null);
  const guarded = selectMon('2026-07-30', packsDir, sharedDir, unguarded);
  assert.notStrictEqual(guarded, unguarded);
});

test('selectMon repeats the only candidate rather than failing', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writePack(packsDir, 'solo', FULL);
  writeSharedEgg(sharedDir);

  // Nothing to step to; returning 'solo' beats looping or throwing.
  assert.strictEqual(selectMon('2026-07-30', packsDir, sharedDir, 'solo'), 'solo');
});

test('selectMon never repeats across a year of dates', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['agumon', 'gabumon', 'guilmon', 'impmon', 'renamon', 'terriermon', 'veemon']) {
    writePack(packsDir, name, FULL);
  }
  writeSharedEgg(sharedDir);

  let prev = null;
  for (const key of dateKeys(365)) {
    const mon = selectMon(key, packsDir, sharedDir, prev);
    assert.notStrictEqual(mon, prev, `repeated ${mon} on ${key}`);
    prev = mon;
  }
});

test('selectMon spreads picks across all candidates', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const names = ['agumon', 'gabumon', 'guilmon', 'impmon', 'renamon', 'terriermon', 'veemon'];
  for (const name of names) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  const counts = {};
  let prev = null;
  for (const key of dateKeys(365)) {
    prev = selectMon(key, packsDir, sharedDir, prev);
    counts[prev] = (counts[prev] || 0) + 1;
  }
  // Guards against a degenerate rotation (e.g. ping-ponging between two
  // packs) without asserting a specific distribution.
  assert.deepStrictEqual(Object.keys(counts).sort(), [...names].sort());
  for (const name of names) {
    assert.ok(counts[name] > 20, `${name} picked only ${counts[name]} times in 365 days`);
  }
});

// --- computeDailyTokens: prevMon bookkeeping -------------------------

function setupDaily(t) {
  const dirs = makeRoot(t);
  for (const name of ['agumon', 'gabumon', 'guilmon', 'impmon', 'renamon']) {
    writePack(dirs.packsDir, name, FULL);
  }
  writeSharedEgg(dirs.sharedDir);
  fs.mkdirSync(dirs.projectsDir, { recursive: true });
  return dirs;
}

test('computeDailyTokens pins the mon across same-day reruns', (t) => {
  const dirs = setupDaily(t);
  const first = computeDailyTokens(dateAt(0), dirs);
  // A new pack landing on disk mid-day must not swap the sprite out.
  writePack(dirs.packsDir, 'aaa-newcomer', FULL);
  const second = computeDailyTokens(dateAt(0), dirs);

  assert.strictEqual(second.mon, first.mon);
});

test('computeDailyTokens carries prevMon through same-day rewrites', (t) => {
  const dirs = setupDaily(t);
  const day1 = computeDailyTokens(dateAt(0), dirs);
  const day2 = computeDailyTokens(dateAt(1), dirs);
  assert.strictEqual(day2.prevMon, day1.mon);

  // The menubar rewrites daily.json every ~30s; prevMon has to survive
  // those or tomorrow's guard loses its comparison value.
  for (let i = 0; i < 5; i++) computeDailyTokens(dateAt(1), dirs);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirs.claudemonDir, 'daily.json'), 'utf8'));
  assert.strictEqual(onDisk.prevMon, day1.mon);
  assert.strictEqual(onDisk.mon, day2.mon);
});

test('computeDailyTokens never repeats the mon on consecutive days', (t) => {
  const dirs = setupDaily(t);
  let prev = null;
  for (let day = 0; day < 40; day++) {
    const result = computeDailyTokens(dateAt(day), dirs);
    assert.notStrictEqual(result.mon, prev, `repeated ${result.mon} on ${result.dateKST}`);
    prev = result.mon;
  }
});

test('computeDailyTokens keeps guarding after a multi-day gap', (t) => {
  const dirs = setupDaily(t);
  const before = computeDailyTokens(dateAt(0), dirs);
  // Machine off for a week: prevMon is still the last mon actually seen.
  const after = computeDailyTokens(dateAt(7), dirs);

  assert.strictEqual(after.prevMon, before.mon);
  assert.notStrictEqual(after.mon, before.mon);
});

test('computeDailyTokens survives a corrupt daily.json', (t) => {
  const dirs = setupDaily(t);
  fs.mkdirSync(dirs.claudemonDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.claudemonDir, 'daily.json'), '{ not json');

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.prevMon, null);
  assert.ok(result.mon);
});

// --- computeDailyTokens: what counts as one transcript ----------------
//
// Two counting bugs met here, pulling in opposite directions: subagent
// transcripts live one level deeper than the scan used to look, so their
// tokens were never counted at all, while a session recorded under two
// project directories at once (same repo reached through a worktree or
// symlink path) had every one of its messages counted twice.

const SESSION = '11111111-2222-3333-4444-555555555555';

// Same shape as a real Claude Code transcript line, minus the fields the
// scan ignores.
function assistantLine(id, outputTokens) {
  return JSON.stringify({
    timestamp: '2026-07-29T02:00:00.000Z', // inside the KST day of dateAt(0)
    message: { role: 'assistant', id, usage: { output_tokens: outputTokens } }
  });
}

// A genuine human prompt line (see isRealUserTurn) - `type: "user"`, a text
// content block, no toolUseResult/isMeta. `n` only exists to give
// consecutive calls distinct (but still within-day) timestamps.
function userLine(text, n = 0) {
  return JSON.stringify({
    type: 'user',
    timestamp: `2026-07-29T02:${String(n % 60).padStart(2, '0')}:01.000Z`,
    message: { role: 'user', content: [{ type: 'text', text }] }
  });
}

// A tool_result line: shares `type: "user"` with a real prompt but must
// never be counted as one (see isRealUserTurn).
function toolResultLine(n = 0) {
  return JSON.stringify({
    type: 'user',
    timestamp: `2026-07-29T02:${String(n % 60).padStart(2, '0')}:01.000Z`,
    toolUseResult: { stdout: 'ok' },
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
  });
}

function writeTranscript(projectsDir, relPath, lines) {
  const file = path.join(projectsDir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

test('listJsonlFiles finds subagent transcripts nested under a session', (t) => {
  const dirs = setupDaily(t);
  const main = writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, []);
  const sub = writeTranscript(
    dirs.projectsDir,
    `-Users-me-repo/${SESSION}/subagents/agent-abc123.jsonl`,
    []
  );

  assert.deepStrictEqual(listJsonlFiles(dirs.projectsDir).sort(), [main, sub].sort());
});

test('transcriptKey ignores which project directory a transcript sits in', (t) => {
  const dirs = setupDaily(t);
  const real = transcriptKey(dirs.projectsDir, path.join(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`));
  const linked = transcriptKey(dirs.projectsDir, path.join(dirs.projectsDir, `-Users-me-wt-repo/${SESSION}.jsonl`));

  assert.strictEqual(real.key, linked.key);
  assert.strictEqual(real.sessionId, SESSION);

  // A subagent transcript keys separately but belongs to its session.
  const sub = transcriptKey(
    dirs.projectsDir,
    path.join(dirs.projectsDir, `-Users-me-repo/${SESSION}/subagents/agent-abc123.jsonl`)
  );
  assert.notStrictEqual(sub.key, real.key);
  assert.strictEqual(sub.sessionId, SESSION);
});

test('computeDailyTokens counts subagent tokens into the parent session', (t) => {
  const dirs = setupDaily(t);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [assistantLine('msg_main', 100)]);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}/subagents/agent-abc123.jsonl`, [
    assistantLine('msg_sub', 50)
  ]);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.outputTokens, 150);
  assert.deepStrictEqual(result.sessionTokens, { [SESSION]: 150 });
});

test('computeDailyTokens counts a session filed under two project dirs once', (t) => {
  const dirs = setupDaily(t);
  const lines = [assistantLine('msg_a', 100), assistantLine('msg_b', 40)];
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);
  writeTranscript(dirs.projectsDir, `-Users-me-wt-repo/${SESSION}.jsonl`, lines);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.outputTokens, 140);
  assert.deepStrictEqual(result.sessionTokens, { [SESSION]: 140 });
});

// --- rotation pool: only lines that reach the top stage ---------------
//
// A pack whose evolution line tops out early would sit one stage below
// the ceiling on the heaviest days of the month, so it is held out of the
// daily rotation entirely rather than shown with a stage it can never
// reach. It stays a *valid* pack - explicit selection and the guilmon
// fallback still render it.

test('listRotationPacks drops a line that stops short of the top stage', (t) => {
  const dirs = makeRoot(t);
  writePack(dirs.packsDir, 'reaches-top', FULL);
  writePack(dirs.packsDir, 'tops-out-early', FULL, { topStage: false });

  assert.deepStrictEqual(listRotationPacks(dirs.packsDir, dirs.sharedDir), ['reaches-top']);
  // Still a perfectly loadable pack - just not a rotation candidate.
  assert.deepStrictEqual(listValidPacks(dirs.packsDir, dirs.sharedDir), [
    'reaches-top',
    'tops-out-early'
  ]);
});

test('listRotationPacks drops a pack with no pack.json at all', (t) => {
  const dirs = makeRoot(t);
  const dir = path.join(dirs.packsDir, 'nameless');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FULL) fs.writeFileSync(path.join(dir, f), 'png');

  assert.deepStrictEqual(listValidPacks(dirs.packsDir, dirs.sharedDir), ['nameless']);
  assert.deepStrictEqual(listRotationPacks(dirs.packsDir, dirs.sharedDir), []);
});

test('selectMon never lands on a pack outside the rotation pool', (t) => {
  const dirs = makeRoot(t);
  writePack(dirs.packsDir, 'aaa-early', FULL, { topStage: false });
  writePack(dirs.packsDir, 'zzz-early', FULL, { topStage: false });
  for (const name of ['agumon', 'gabumon', 'guilmon']) writePack(dirs.packsDir, name, FULL);

  for (const key of dateKeys(120)) {
    const mon = selectMon(key, dirs.packsDir, dirs.sharedDir, null);
    assert.ok(['agumon', 'gabumon', 'guilmon'].includes(mon), `picked ${mon} on ${key}`);
  }
});

test('computeDailyTokens reaches the top stage past its threshold', (t) => {
  const dirs = setupDaily(t);
  // 2.1M output tokens in one KST day: past the top stage's gte.
  writeTranscript(
    dirs.projectsDir,
    `-Users-me-repo/${SESSION}.jsonl`,
    [assistantLine('msg_a', 1_100_000), assistantLine('msg_b', 1_000_000)]
  );

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.outputTokens, 2_100_000);
  assert.strictEqual(result.stageId, topStageId());
});

test('computeDailyTokens stays one stage below just under the threshold', (t) => {
  const dirs = setupDaily(t);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [
    assistantLine('msg_a', 1_999_999)
  ]);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.notStrictEqual(result.stageId, topStageId());
  assert.strictEqual(result.stageId, 'ultimate');
});

test('computeDailyTokens keeps one copy while the other catches up', (t) => {
  const dirs = setupDaily(t);
  const full = [assistantLine('msg_a', 100), assistantLine('msg_b', 40)];
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, full);
  // The second copy lags a turn behind; the incremental scan sees it
  // grow between runs, which must not add its messages a second time.
  const lagging = writeTranscript(dirs.projectsDir, `-Users-me-wt-repo/${SESSION}.jsonl`, [full[0]]);

  assert.strictEqual(computeDailyTokens(dateAt(0), dirs).outputTokens, 140);

  fs.appendFileSync(lagging, `${full[1]}\n`);
  const caughtUp = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(caughtUp.outputTokens, 140);
  assert.deepStrictEqual(caughtUp.sessionTokens, { [SESSION]: 140 });
});

// --- selectRoute: 조건부 진화 (branching routes) -------------------------
//
// A pack's tree lets the same species end the day as a different form. Each
// node's `evolutions` is an ordered, first-match-wins list of { to, when }
// edges; the branch is gated by today's ctx (see selectRoute's doc comment),
// not by luck. The draw has to stay boring in the ways that matter: pinned
// for the day, always able to reach the top stage, and steerable by what the
// day actually looked like.

const TREE = {
  digitama: [{ id: 'egg', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
  baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
  child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [
    { to: 'darkA', when: { type: 'failureRatioPct', gte: 5 } },
    { to: 'spineA', when: null },
    { to: 'deadA', when: null }
  ] }],
  adult: [
    { id: 'spineA', name: '정통', sprite: 'adult', evolutions: [{ to: 'spineP', when: null }] },
    { id: 'darkA', name: '어둠', sprite: 'adult-dark', evolutions: [{ to: 'spineP', when: null }] },
    // A dead end still needs its own guaranteed edge forward now (decision
    // C) - there is no code-level spine return to fall back on.
    { id: 'deadA', name: '막다른', sprite: 'adult-dead', evolutions: [{ to: 'spineP', when: null }] }
  ],
  perfect: [{ id: 'spineP', name: '완전', sprite: 'perfect', evolutions: [{ to: 'spineU', when: null }] }],
  ultimate: [{ id: 'spineU', name: '궁극', sprite: 'ultimate', evolutions: [{ to: 'top', when: null }] }],
  superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
};

test('selectRoute is stable for a date and moves between dates', () => {
  const a = selectRoute('2026-07-30', 'p', TREE, {});
  const b = selectRoute('2026-07-30', 'p', TREE, {});
  assert.deepStrictEqual(a, b);

  // ctx={} never satisfies darkA's condition, so the tie pool is
  // [spineA, deadA] - still enough candidates for the hash to vary by date.
  const ids = new Set();
  for (let d = 1; d <= 20; d++) {
    ids.add(selectRoute(`2026-08-${String(d).padStart(2, '0')}`, 'p', TREE, {}).adult.id);
  }
  assert.ok(ids.size > 1, `adult stage never varied across 20 days: ${[...ids]}`);
});

test('selectRoute always reaches the top stage, even through a dead end', () => {
  for (let d = 1; d <= 40; d++) {
    const route = selectRoute(`2026-09-${String(d).padStart(2, '0')}`, 'p', TREE, {});
    assert.strictEqual(route.superultimate.id, 'top', `day ${d} lost the top stage`);
    assert.strictEqual(route.perfect.id, 'spineP');
  }
  // The dead-end branch does get drawn - its own guaranteed edge is what
  // carries it to the top now, not a code-level spine return.
  const seen = new Set();
  for (let d = 1; d <= 40; d++) {
    seen.add(selectRoute(`2026-09-${String(d).padStart(2, '0')}`, 'p', TREE, {}).adult.id);
  }
  assert.ok(seen.has('deadA'), 'dead-end branch never appeared, test tree is not exercising it');
});

test('selectRoute deterministically follows a satisfied condition edge', () => {
  const ctx = { failureRatioPct: 10 };
  for (let d = 1; d <= 30; d++) {
    const route = selectRoute(`2026-10-${String(d).padStart(2, '0')}`, 'p', TREE, ctx);
    assert.strictEqual(route.adult.id, 'darkA', `day ${d} ignored the satisfied condition`);
  }
});

test('selectRoute excludes edges whose condition fails, leaving only the rest', () => {
  const ids = new Set();
  for (let d = 1; d <= 30; d++) {
    const route = selectRoute(`2026-11-${String(d).padStart(2, '0')}`, 'p', TREE, {});
    assert.notStrictEqual(route.adult.id, 'darkA', `day ${d} picked an edge whose condition never held`);
    ids.add(route.adult.id);
  }
  assert.ok(ids.size > 1, `an unsatisfied condition should still leave room for the day's hash: ${[...ids]}`);
});

test('selectRoute repeats the same route across consecutive days given the same conditions', () => {
  // Decision D: no more "avoid yesterday's route" - working the same way two
  // days running is allowed to produce the same form both days.
  const ctx = { failureRatioPct: 10 }; // deterministic: only darkA's edge is ever satisfied
  const day1 = selectRoute('2026-07-30', 'p', TREE, ctx);
  const day2 = selectRoute('2026-07-31', 'p', TREE, ctx);
  assert.deepStrictEqual(day1, day2);
  assert.strictEqual(day1.adult.id, 'darkA');
});

// --- selectRoute: lazy binding (`locked`) -----------------------------
//
// A pinned route used to be frozen whole for the day, which meant signals
// that can only become true partway through the day (sessionCount needs 5
// sessions - impossible in the first seconds after midnight) could never
// steer a branch. `locked` fixes that: stages already reached stay pinned,
// stages still ahead redraw against whatever ctx is *right now*.

test('selectRoute preserves the locked prefix and re-walks the rest', () => {
  const base = selectRoute('2026-07-30', 'p', TREE, {});
  const locked = {
    route: { ...base, adult: { id: 'deadA', name: '막다른', sprite: 'adult-dead' } },
    throughStage: 'adult'
  };
  const route = selectRoute('2026-07-30', 'p', TREE, {}, locked);
  assert.strictEqual(route.adult.id, 'deadA');
  // deadA's own guaranteed edge carries the route to the top, exactly as it
  // would from a non-locked walk.
  assert.strictEqual(route.perfect.id, 'spineP');
  assert.strictEqual(route.superultimate.id, 'top');
});

test('selectRoute locks the reached stage against condition changes but leaves the rest open', () => {
  // ctx={} structurally excludes darkA (its condition can never hold), so
  // the no-condition draw is always spineA or deadA - never coincidentally
  // the same node the satisfied-condition draw would pick.
  const noCondition = selectRoute('2026-07-30', 'p', TREE, {});
  const reachedAdult = noCondition.adult.id;
  assert.ok(['spineA', 'deadA'].includes(reachedAdult));

  // Locked through adult: re-running with a satisfied condition must not move it.
  const lockedAtAdult = { route: noCondition, throughStage: 'adult' };
  const withCondition = selectRoute('2026-07-30', 'p', TREE, { failureRatioPct: 10 }, lockedAtAdult);
  assert.strictEqual(withCondition.adult.id, reachedAdult);

  // Locked only through child: adult hasn't been reached yet, so it must
  // follow the condition like a normal draw would.
  const lockedAtChild = { route: noCondition, throughStage: 'child' };
  const withConditionFromChild = selectRoute('2026-07-30', 'p', TREE, { failureRatioPct: 10 }, lockedAtChild);
  assert.strictEqual(withConditionFromChild.adult.id, 'darkA');
  assert.strictEqual(withConditionFromChild.child.id, noCondition.child.id); // still pinned below the lock line
});

test('selectRoute is idempotent with a locked prefix', () => {
  const base = selectRoute('2026-07-30', 'p', TREE, {});
  const locked = { route: base, throughStage: 'adult' };
  const ctx = { failureRatioPct: 10 };
  const a = selectRoute('2026-07-30', 'p', TREE, ctx, locked);
  const b = selectRoute('2026-07-30', 'p', TREE, ctx, locked);
  assert.deepStrictEqual(a, b);
});

test('selectRoute degrades to a normal draw when the locked route no longer matches the tree', () => {
  const locked = {
    route: {
      digitama: { id: 'egg', name: '알', sprite: 'digitama' },
      baby: { id: 'baby1', name: '유년', sprite: 'baby' },
      child: { id: 'kid', name: '성장', sprite: 'child' },
      adult: { id: 'no-longer-in-tree', name: '?', sprite: '?' } // tree moved under this route
    },
    throughStage: 'adult'
  };
  assert.doesNotThrow(() => selectRoute('2026-07-30', 'p', TREE, {}, locked));
  const route = selectRoute('2026-07-30', 'p', TREE, {}, locked);
  assert.strictEqual(route.child.id, 'kid'); // still-valid locked stages stay locked
  assert.strictEqual(route.superultimate.id, 'top'); // degraded stages still reach the top
});

// --- readTree: next -> evolutions normalization ------------------------
//
// pack.json is a hand-authored file and README documents `next: [id, ...]`
// as a supported (legacy) shape, so readTree normalizes it into the
// `evolutions` shape selectRoute actually walks, in one single place.

function writeTreePack(dirs, name, tree) {
  const dir = path.join(dirs.packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FULL) fs.writeFileSync(path.join(dir, f), 'png');
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({ name, stageNames: { superultimate: '초궁극' }, tree }, null, 2)
  );
}

test('readTree normalizes a next-only node into an unconditional evolutions edge', (t) => {
  const dirs = makeRoot(t);
  writeTreePack(dirs, 'nextmon', {
    digitama: [{ id: 'egg', name: '알', sprite: 'digitama', next: ['baby1'] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', next: ['kid'] }],
    child: [{ id: 'kid', name: '성장', sprite: 'child', next: ['ad1'] }],
    adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', next: ['perf1'] }],
    perfect: [{ id: 'perf1', name: '완전', sprite: 'perfect', next: ['ult1'] }],
    ultimate: [{ id: 'ult1', name: '궁극', sprite: 'ultimate', next: ['top'] }],
    superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', next: [] }]
  });

  const tree = readTree(dirs.packsDir, 'nextmon');
  assert.deepStrictEqual(tree.child[0].evolutions, [{ to: 'ad1', when: null }]);
});

test('readTree leaves an evolutions-only node as-is', (t) => {
  const dirs = makeRoot(t);
  writeTreePack(dirs, 'evomon', TREE);

  const tree = readTree(dirs.packsDir, 'evomon');
  assert.deepStrictEqual(tree.child[0].evolutions, TREE.child[0].evolutions);
});

test('readTree prefers evolutions over next when a node declares both', (t) => {
  const dirs = makeRoot(t);
  writeTreePack(dirs, 'bothmon', {
    digitama: [{ id: 'egg', name: '알', sprite: 'digitama', next: ['baby1'] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', next: ['kid'] }],
    child: [{
      id: 'kid',
      name: '성장',
      sprite: 'child',
      next: ['ad1'], // stale legacy field - evolutions must win
      evolutions: [{ to: 'ad2', when: null }]
    }],
    adult: [
      { id: 'ad1', name: '성숙-구', sprite: 'adult', next: ['top'] },
      { id: 'ad2', name: '성숙-신', sprite: 'adult2', next: ['top'] }
    ],
    perfect: [{ id: 'perf1', name: '완전', sprite: 'perfect', next: ['top'] }],
    ultimate: [{ id: 'ult1', name: '궁극', sprite: 'ultimate', next: ['top'] }],
    superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', next: [] }]
  });

  const tree = readTree(dirs.packsDir, 'bothmon');
  assert.deepStrictEqual(tree.child[0].evolutions, [{ to: 'ad2', when: null }]);
});

test('readTree still returns null for a partially declared pack', (t) => {
  const dirs = makeRoot(t);
  writeTreePack(dirs, 'partialmon', {
    digitama: [{ id: 'egg', name: '알', sprite: 'digitama', next: ['baby1'] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', next: [] }]
    // child .. superultimate missing - listRotationPacks excludes lines like this.
  });

  assert.strictEqual(readTree(dirs.packsDir, 'partialmon'), null);
});

// --- validatePackTree ----------------------------------------------------
//
// Runtime stays lenient (decision E) - readTree/selectRoute never throw on
// a malformed tree. validatePackTree is where the data contract they lean
// on actually gets enforced, for tests here and for
// scripts/build-evolution-map.js's per-pack diagnostics.

const MINIMAL_TREE = {
  digitama: [{ id: 'egg', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
  baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
  child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'ad1', when: null }] }],
  adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'top', when: null }] }],
  superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
};

test('validatePackTree accepts a tree whose every non-top node ends in a guaranteed edge', () => {
  assert.deepStrictEqual(validatePackTree(MINIMAL_TREE), []);
  assert.deepStrictEqual(validatePackTree(TREE), []); // the branching fixture used above
});

test('validatePackTree passes a top-stage node with no evolutions field at all', () => {
  const tree = { ...MINIMAL_TREE, superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate' }] };
  assert.deepStrictEqual(validatePackTree(tree), []);
});

test('validatePackTree catches a missing unconditional edge', () => {
  const tree = {
    ...MINIMAL_TREE,
    adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'top', when: { type: 'sessionCount', gte: 5 } }] }]
  };
  assert.deepStrictEqual(validatePackTree(tree), [
    { rule: 'missing-unconditional-edge', stage: 'adult', node: 'ad1' }
  ]);
});

test('validatePackTree catches a stage skip', () => {
  // kid points straight at 'top' (superultimate), jumping over adult - the
  // exact silent-mis-slot hazard byId spanning every stage creates (plan §9
  // pitfall 2).
  const tree = { ...MINIMAL_TREE, child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'top', when: null }] }] };
  assert.deepStrictEqual(validatePackTree(tree), [
    { rule: 'stage-skip', stage: 'child', node: 'kid', to: 'top' }
  ]);
});

test('validatePackTree catches a to that names no node at all', () => {
  const tree = { ...MINIMAL_TREE, child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'ghost', when: null }] }] };
  assert.deepStrictEqual(validatePackTree(tree), [
    { rule: 'unknown-target', stage: 'child', node: 'kid', to: 'ghost' }
  ]);
});

test('validatePackTree catches an unknown condition type', () => {
  const tree = {
    ...MINIMAL_TREE,
    child: [{
      id: 'kid',
      name: '성장',
      sprite: 'child',
      evolutions: [
        { to: 'ad1', when: { type: 'typoType', gte: 1 } },
        { to: 'ad1', when: null }
      ]
    }]
  };
  assert.deepStrictEqual(validatePackTree(tree), [
    { rule: 'unknown-condition-type', stage: 'child', node: 'kid', condType: 'typoType' }
  ]);
});

test('validatePackTree recurses into a nested all to catch an unknown condition type', () => {
  // Regression for conditionMet's own `and` 1-level limitation (decision F)
  // - the checker has to actually walk `all` recursively, not just its
  // top level, or a typo two levels deep passes silently.
  const tree = {
    ...MINIMAL_TREE,
    child: [{
      id: 'kid',
      name: '성장',
      sprite: 'child',
      evolutions: [
        { to: 'ad1', when: { all: [{ type: 'sessionCount', gte: 1 }, { all: [{ type: 'bogus', gte: 1 }] }] } },
        { to: 'ad1', when: null }
      ]
    }]
  };
  assert.deepStrictEqual(validatePackTree(tree), [
    { rule: 'unknown-condition-type', stage: 'child', node: 'kid', condType: 'bogus' }
  ]);
});

// Safety net for commits 5/6: every shipped pack.json must validate clean
// before its data gets rewritten into evolutions/when. gaomon stops short
// of the top stage on purpose (README §로테이션 후보 요건) and readTree
// returns null for it - "every pack's tree reaches the top" is not an
// assumption this test makes (plan §9 pitfall 6).
test('validatePackTree finds zero violations across every shipped pack that has a tree', () => {
  const packsDir = defaultPacksDir();
  const names = fs
    .readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
  let checked = 0;
  for (const name of names) {
    const tree = readTree(packsDir, name);
    if (!tree) continue; // no tree, or a partial declaration - nothing to validate
    checked += 1;
    const violations = validatePackTree(tree);
    assert.deepStrictEqual(violations, [], `${name}: ${JSON.stringify(violations)}`);
  }
  assert.ok(checked > 0, 'no shipped pack had a usable tree - this test is not exercising anything');
});

test('activeTraits reads the day rather than luck', () => {
  assert.deepStrictEqual(activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2 }), []);
  assert.deepStrictEqual(activeTraits({ failureRatio: 0.2, sessionCount: 1, topShare: 0.1 }), ['dark']);
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 7, topShare: 0.9 }),
    ['swarm', 'focus']
  );
});

// --- activeTraits: sage (설계 날) ---------------------------------------
//
// Calibrated off 8 real days of transcript data (see TODOS.md / task brief):
// implementation-heavy days ran 149-228 user turns at 7.8k-9.4k output/turn;
// a discussion/design-heavy day ran 140 turns at ~5.4k/turn. sage needs both
// "lots of turns" and "low output per turn" - either alone also describes a
// low-activity day or a terse-but-code-heavy one.

test('activeTraits sets sage when turns are high and output-per-turn is low', () => {
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 140, outputPerTurn: 5400 }),
    ['sage']
  );
});

test('activeTraits withholds sage when turns are high but output-per-turn is also high', () => {
  // Implementation-heavy day shape: plenty of turns, but each one is
  // generating code, not just talking.
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 180, outputPerTurn: 8000 }),
    []
  );
});

test('activeTraits withholds sage when output-per-turn is low but turns never reached the floor', () => {
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 20, outputPerTurn: 500 }),
    []
  );
});

test('activeTraits sage gate is boundary-inclusive on both sides', () => {
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 80, outputPerTurn: 6000 }),
    ['sage']
  );
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 79, outputPerTurn: 6000 }),
    []
  );
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2, userTurns: 80, outputPerTurn: 6001 }),
    []
  );
});

test('activeTraits can combine sage with swarm/focus/dark', () => {
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 7, topShare: 0.9, userTurns: 140, outputPerTurn: 5400 }),
    ['swarm', 'focus', 'sage']
  );
});

// --- computeDailyTokens: lazy binding end-to-end ----------------------
//
// selectRoute's `locked` prefix is only half the story - computeDailyTokens
// has to actually pass it in on every rerun, keyed off the stage the mon
// has reached *this run*, not off whatever daily.json remembers. This is
// the regression the whole change exists for: swarm needs 5 concurrent
// sessions, which cannot be true in the first run right after midnight, so
// the only way it can ever steer a branch is if a later rerun the same day
// redraws the stages still ahead of the mon.

const LAZY_TREE = {
  digitama: [{ id: 'egg', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
  baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
  child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'ad1', when: null }] }],
  adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [
    { to: 'perfSwarm', when: { type: 'sessionCount', gte: 5 } },
    { to: 'perfSpine', when: null }
  ] }],
  perfect: [
    { id: 'perfSpine', name: '완전-정통', sprite: 'perfect', evolutions: [{ to: 'ult1', when: null }] },
    { id: 'perfSwarm', name: '완전-무리', sprite: 'perfect-swarm', evolutions: [{ to: 'ult1', when: null }] }
  ],
  ultimate: [{ id: 'ult1', name: '궁극', sprite: 'ultimate', evolutions: [{ to: 'top', when: null }] }],
  superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
};

// Only pack in the pool, so mon selection can't introduce randomness of
// its own (see "selectMon repeats the only candidate rather than failing").
function writeLazyPack(dirs) {
  const dir = path.join(dirs.packsDir, 'lazymon');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FULL) fs.writeFileSync(path.join(dir, f), 'png');
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({ name: 'lazymon', stageNames: { superultimate: '초궁극' }, tree: LAZY_TREE }, null, 2)
  );
}

test('computeDailyTokens keeps the reached stage pinned and re-walks the rest as ctx changes', (t) => {
  const dirs = makeRoot(t);
  writeLazyPack(dirs);
  fs.mkdirSync(dirs.projectsDir, { recursive: true });

  // 150,000 output tokens across 2 sessions: lands in adult (gte 100,000,
  // below perfect's 300,000), well under sessionCount's 5-session gate.
  writeTranscript(dirs.projectsDir, '-Users-me-repo/aaaaaaaa-0000-0000-0000-000000000001.jsonl', [
    assistantLine('msg_1', 75_000)
  ]);
  writeTranscript(dirs.projectsDir, '-Users-me-repo/aaaaaaaa-0000-0000-0000-000000000002.jsonl', [
    assistantLine('msg_2', 75_000)
  ]);

  const first = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(first.stageId, 'adult');
  assert.strictEqual(first.route.adult.id, 'ad1');
  assert.deepStrictEqual(first.traits, []);

  // Three more low-token sessions push sessionCount to 5 without moving the
  // total out of the adult range - the day "catches up" to a condition it
  // couldn't have satisfied on the first run.
  for (let i = 3; i <= 5; i++) {
    writeTranscript(
      dirs.projectsDir,
      `-Users-me-repo/aaaaaaaa-0000-0000-0000-00000000000${i}.jsonl`,
      [assistantLine(`msg_${i}`, 1_000)]
    );
  }

  const second = computeDailyTokens(dateAt(0), dirs);
  assert.ok(second.traits.includes('swarm'));
  assert.strictEqual(second.stageId, 'adult'); // still the same stage today
  assert.strictEqual(second.route.adult.id, 'ad1'); // reached stage: pinned despite the new signal
  assert.strictEqual(second.route.child.id, first.route.child.id); // pinned prefix below it too
  assert.strictEqual(second.route.perfect.id, 'perfSwarm'); // not yet reached: redrawn against today's ctx
});

// Decision D's flip side: dropping "avoid yesterday's route" only pays off if
// the same day's signals reliably produce the same route back. Without a
// changed signal between reruns, every stage - reached or not - has to
// redraw to the exact same node (the menubar polls every ~30s, so this runs
// dozens of times a day for a stationary mon).
test('computeDailyTokens produces the same route on a same-day rerun with unchanged signals', (t) => {
  const dirs = makeRoot(t);
  writeLazyPack(dirs);
  fs.mkdirSync(dirs.projectsDir, { recursive: true });

  writeTranscript(dirs.projectsDir, '-Users-me-repo/aaaaaaaa-0000-0000-0000-000000000001.jsonl', [
    assistantLine('msg_1', 75_000)
  ]);
  writeTranscript(dirs.projectsDir, '-Users-me-repo/aaaaaaaa-0000-0000-0000-000000000002.jsonl', [
    assistantLine('msg_2', 75_000)
  ]);

  const first = computeDailyTokens(dateAt(0), dirs);
  const second = computeDailyTokens(dateAt(0), dirs); // no new transcripts - same signals
  assert.deepStrictEqual(second.route, first.route);
  assert.strictEqual(second.stageId, first.stageId);
});

// --- computeDailyTokens: malformed tree data must never throw ----------
//
// readTree's own exception guard only catches JSON parse errors and
// incomplete stage declarations (see readTree). A tree that parses fine but
// points an edge at an id that doesn't exist is a different kind of bad
// data, and selectRoute/candidatesFor must degrade instead of throwing - an
// uncaught exception here takes daily-tokens.js, and all token tracking
// with it, down (see lib/daily.js:222-227's comment on this exact failure
// mode).
test('computeDailyTokens survives a pack tree with a dangling evolution target', (t) => {
  const dirs = makeRoot(t);
  writeTreePack(dirs, 'brokenmon', {
    digitama: [{ id: 'egg', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
    child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'does-not-exist', when: null }] }],
    adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'perf1', when: null }] }],
    perfect: [{ id: 'perf1', name: '완전', sprite: 'perfect', evolutions: [{ to: 'ult1', when: null }] }],
    ultimate: [{ id: 'ult1', name: '궁극', sprite: 'ultimate', evolutions: [{ to: 'top', when: null }] }],
    superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
  });
  fs.mkdirSync(dirs.projectsDir, { recursive: true });

  assert.doesNotThrow(() => computeDailyTokens(dateAt(0), dirs));
  const result = computeDailyTokens(dateAt(0), dirs);
  assert.ok(result.mon);
  assert.ok(result.route); // dangling target falls back rather than crashing
});

// --- isRealUserTurn / userTurns counting --------------------------------
//
// A "설계 날" (design day) is detected from genuine human prompts, which
// share `type: "user"` in the transcript with several things that are not
// a person typing: tool results, meta/system-injected entries, and (for
// subagents specifically) the parent's own injected spawn prompt.

test('isRealUserTurn accepts a plain text prompt (string or block form)', () => {
  assert.strictEqual(
    isRealUserTurn({ type: 'user', message: { role: 'user', content: 'hello there' } }),
    true
  );
  assert.strictEqual(
    isRealUserTurn({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    true
  );
});

test('isRealUserTurn rejects a tool_result entry', () => {
  assert.strictEqual(
    isRealUserTurn({
      type: 'user',
      toolUseResult: { stdout: 'ok' },
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
    }),
    false
  );
});

test('isRealUserTurn rejects a meta entry, an empty/whitespace prompt, and a local-command/Caveat shell', () => {
  assert.strictEqual(
    isRealUserTurn({ type: 'user', isMeta: true, message: { role: 'user', content: 'system note' } }),
    false
  );
  assert.strictEqual(isRealUserTurn({ type: 'user', message: { role: 'user', content: '   ' } }), false);
  assert.strictEqual(
    isRealUserTurn({ type: 'user', message: { role: 'user', content: '<local-command-stdin>/clear</local-command-stdin>' } }),
    false
  );
  assert.strictEqual(
    isRealUserTurn({ type: 'user', message: { role: 'user', content: 'Caveat: the messages below...' } }),
    false
  );
});

test('isRealUserTurn rejects a non-user type/role and a content array with no text block', () => {
  assert.strictEqual(isRealUserTurn(null), false);
  assert.strictEqual(isRealUserTurn({ type: 'assistant', message: { role: 'assistant', content: 'x' } }), false);
  assert.strictEqual(
    isRealUserTurn({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } }),
    false
  );
});

test('computeDailyTokens counts real user turns and excludes tool results', (t) => {
  const dirs = setupDaily(t);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [
    userLine('첫 턴', 1),
    assistantLine('msg_1', 100),
    toolResultLine(2),
    toolResultLine(3),
    userLine('둘째 턴', 4),
    assistantLine('msg_2', 100)
  ]);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.dailyUserTurns, 2);
});

test('computeDailyTokens excludes a subagent transcript\'s injected prompt from userTurns', (t) => {
  const dirs = setupDaily(t);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [
    userLine('real human turn', 1),
    assistantLine('msg_main', 100)
  ]);
  // Shaped exactly like a real user turn - only its path under `subagents`
  // says it's the prompt the parent injected to spawn the subagent.
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}/subagents/agent-abc123.jsonl`, [
    userLine('injected spawn prompt', 2),
    assistantLine('msg_sub', 50)
  ]);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.dailyUserTurns, 1);
  assert.strictEqual(result.outputTokens, 150); // subagent's tokens still roll up (existing behavior)
});

// --- computeDailyTokens: the sage (설계 날) stage gate --------------------
//
// evolution-tree.json's stage conditions are `any: [tokens, sage-and-turns]`
// so a day with many real user turns but little assistant output can still
// climb stages that a token-only day of the same size never would.

test('computeDailyTokens reaches a stage via the sage gate that token count alone would not reach', (t) => {
  const dirs = setupDaily(t);
  const lines = [];
  // 80 real user turns (sage's own floor) with a token total (~400) far
  // below even the child stage's 30,000-token path.
  for (let i = 0; i < 80; i++) {
    lines.push(userLine(`턴 ${i}`, i));
    lines.push(assistantLine(`msg_${i}`, 5));
  }
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.dailyUserTurns, 80);
  assert.ok(result.outputPerTurn <= 6000, `outputPerTurn ${result.outputPerTurn} should qualify for sage`);
  assert.ok(result.traits.includes('sage'));
  // child (turns>=30) and adult (turns>=60) both clear at 80 turns; perfect
  // (turns>=120) does not - and dailyOutputTokens (~400) clears none of the
  // token thresholds on its own.
  assert.strictEqual(result.stageId, 'adult');
});

test('computeDailyTokens climbs further via the sage gate as turns pass each stage\'s own floor', (t) => {
  const dirs = setupDaily(t);
  const lines = [];
  for (let i = 0; i < 130; i++) {
    lines.push(userLine(`턴 ${i}`, i));
    lines.push(assistantLine(`msg_${i}`, 5));
  }
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.dailyUserTurns, 130);
  assert.ok(result.traits.includes('sage'));
  // 130 turns clears perfect's floor (120) but not ultimate's (250).
  assert.strictEqual(result.stageId, 'perfect');
});

test('computeDailyTokens withholds the sage gate below its own 80-turn floor even with tiny output-per-turn', (t) => {
  const dirs = setupDaily(t);
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(userLine(`턴 ${i}`, i));
    lines.push(assistantLine(`msg_${i}`, 5));
  }
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.dailyUserTurns, 50);
  assert.ok(!result.traits.includes('sage'));
  assert.strictEqual(result.stageId, 'baby'); // dailyOutputTokens (~250) only clears baby's gte:1
});

// --- token-scan-cache.json: version-mismatch forces one full rescan -----
//
// userTurns is a field old cache entries never had. An old-shaped cache
// (no `version`, offsets already sitting at end-of-file from a prior scan
// that only ever tracked `contribution`) must not be trusted at face value
// for userTurns - the field would silently and permanently read as 0 for
// every byte already consumed under the old scheme. See CACHE_VERSION.

test('computeDailyTokens rescans fully when the cache predates the userTurns field', (t) => {
  const dirs = setupDaily(t);
  const lines = [];
  for (let i = 0; i < 90; i++) {
    lines.push(userLine(`턴 ${i}`, i));
    lines.push(assistantLine(`msg_${i}`, 5));
  }
  const file = writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);

  // Simulate a pre-existing cache from before userTurns existed: same date,
  // offset already at EOF, contribution correct, but no version field and
  // no userTurns - exactly what a real deployed cache looked like the
  // moment this feature shipped.
  fs.mkdirSync(dirs.claudemonDir, { recursive: true });
  const oldShapeCache = {
    dateKST: '2026-07-29',
    files: {
      [file]: { offset: fs.statSync(file).size, contribution: 450, mtimeMs: fs.statSync(file).mtimeMs }
    }
  };
  fs.writeFileSync(cacheFilePath(dirs.claudemonDir), JSON.stringify(oldShapeCache, null, 2));

  const result = computeDailyTokens(dateAt(0), dirs);
  // Had the stale offset been trusted, userTurns would be stuck at 0
  // forever (no unread bytes left to scan for it) despite 90 real turns
  // sitting in already-consumed bytes.
  assert.strictEqual(result.dailyUserTurns, 90);

  const savedCache = JSON.parse(fs.readFileSync(cacheFilePath(dirs.claudemonDir), 'utf8'));
  assert.strictEqual(savedCache.version, 2);
});

test('computeDailyTokens does not rescan (stays incremental) once the cache is current', (t) => {
  const dirs = setupDaily(t);
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [
    userLine('턴 1', 1),
    assistantLine('msg_1', 100)
  ]);

  const first = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(first.dailyUserTurns, 1);

  // A same-day rerun with no new content must reproduce the same totals
  // via the incremental path, not silently re-double anything.
  const second = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(second.dailyUserTurns, 1);
  assert.strictEqual(second.outputTokens, first.outputTokens);
});
