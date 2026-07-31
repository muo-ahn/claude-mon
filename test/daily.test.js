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
  packTopStage,
  topStageId,
  minCeilingId,
  pruneTree,
  readTree,
  selectRoute,
  activeTraits,
  hashString,
  selectMon,
  computeDailyTokens,
  listJsonlFiles,
  transcriptKey
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
// minimum ceiling, which is what listRotationPacks requires. Pass
// `{ topStage: false }` for a line that doesn't even reach 궁극체.
function writePack(packsDir, name, files, { topStage = true } = {}) {
  const dir = path.join(packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'png');
  const stageNames = { child: name };
  if (topStage) stageNames[minCeilingId()] = `${name}-최종체`;
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

test('listRotationPacks drops a line that does not even reach the minimum ceiling', (t) => {
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

// --- selectRoute: 랜덤 진화 (branching routes) -------------------------
//
// A pack's tree lets the same species end the day as a different form. The
// draw has to stay boring in the ways that matter: pinned for the day,
// always able to reach the top stage, and steerable by what the day looked
// like rather than by luck alone.

const TREE = {
  digitama: [{ id: 'egg', name: '알', sprite: 'digitama', next: ['baby1'] }],
  baby: [{ id: 'baby1', name: '유년', sprite: 'baby', next: ['kid'] }],
  child: [{ id: 'kid', name: '성장', sprite: 'child', next: ['spineA', 'darkA', 'deadA'] }],
  adult: [
    { id: 'spineA', name: '정통', sprite: 'adult', next: ['spineP'] },
    { id: 'darkA', name: '어둠', sprite: 'adult-dark', traits: ['dark'], next: ['spineP'] },
    { id: 'deadA', name: '막다른', sprite: 'adult-dead', next: [] }
  ],
  perfect: [{ id: 'spineP', name: '완전', sprite: 'perfect', next: ['spineU'] }],
  ultimate: [{ id: 'spineU', name: '궁극', sprite: 'ultimate', next: ['top'] }],
  superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', next: [] }]
};

// selectRoute is always handed a pruned tree in production (readTree does
// the pruning), so the route tests work off PRUNED rather than the raw
// TREE - passing raw trees would test a state that can't occur.
const PRUNED = pruneTree(TREE, () => true, 'superultimate');

test('selectRoute is stable for a date and moves between dates', () => {
  const a = selectRoute('2026-07-30', 'p', PRUNED, [], null);
  const b = selectRoute('2026-07-30', 'p', PRUNED, [], null);
  assert.deepStrictEqual(a, b);

  const ids = new Set();
  for (let d = 1; d <= 20; d++) {
    ids.add(selectRoute(`2026-08-${String(d).padStart(2, '0')}`, 'p', PRUNED, [], null).adult.id);
  }
  assert.ok(ids.size > 1, `adult stage never varied across 20 days: ${[...ids]}`);
});

// A dead end used to be rescued by handing the next stage back to the
// spine, which is how 라이즈그레이몬 ended up "evolving" into 워그레이몬 -
// a different line entirely. Pruning removes the branch instead, so the
// walk only ever follows edges the tree actually declares.

test('pruneTree drops a branch that dead-ends short of the ceiling', () => {
  assert.deepStrictEqual(
    PRUNED.adult.map((n) => n.id),
    ['spineA', 'darkA'],
    'the dead-end branch survived pruning'
  );
  assert.deepStrictEqual(PRUNED.child[0].next, ['spineA', 'darkA'], 'edge to the dead end survived');
});

test('pruneTree drops a branch whose dots are missing', () => {
  const pruned = pruneTree(TREE, (sprite) => sprite !== 'adult-dark', 'superultimate');
  assert.deepStrictEqual(pruned.adult.map((n) => n.id), ['spineA']);
  assert.deepStrictEqual(pruned.child[0].next, ['spineA']);
});

test('pruneTree drops a node nothing arrives at any more', () => {
  // orphanA has dots and reaches the top, but no edge leads into it - the
  // 인퍼몬 → 베르제브몬 removal leaves exactly this shape behind. An orphan
  // is never drawable, yet left in place it would sit first in the stage
  // array and become the spine.
  const orphaned = JSON.parse(JSON.stringify(TREE));
  orphaned.child[0].next = ['spineA'];
  orphaned.adult = [
    { id: 'orphanA', name: '고아', sprite: 'adult-dark', next: ['spineP'] },
    { id: 'spineA', name: '정통', sprite: 'adult', next: ['spineP'] }
  ];
  const pruned = pruneTree(orphaned, () => true, 'superultimate');
  assert.deepStrictEqual(pruned.adult.map((n) => n.id), ['spineA']);
});

test('pruneTree keeps a route that ends at the minimum ceiling', () => {
  // 초궁극체 도트가 없어도 궁극체까지 가면 유효하다 — 2M을 넘겨도 더 진화하지
  // 않을 뿐이다. 이게 최소천장 규칙의 핵심이고, 길몬 다크 분기를 열어준다.
  const pruned = pruneTree(TREE, (sprite) => sprite !== 'superultimate', 'superultimate');
  assert.ok(pruned, 'a line complete up to 궁극체 was rejected');
  assert.strictEqual(pruned.superultimate, undefined, 'route ran past what it has dots for');
  assert.deepStrictEqual(pruned.ultimate.map((n) => n.id), ['spineU']);
});

test('pruneTree returns null when nothing reaches the minimum ceiling', () => {
  const dead = (sprite) => sprite !== 'superultimate' && sprite !== 'ultimate';
  assert.strictEqual(pruneTree(TREE, dead, 'superultimate'), null);
});

test('selectRoute ends a route at the minimum ceiling instead of failing', () => {
  const short = pruneTree(TREE, (sprite) => sprite !== 'superultimate', 'superultimate');
  const route = selectRoute('2026-08-01', 'p', short, [], null);
  assert.ok(route, 'selectRoute gave up on a valid short route');
  assert.strictEqual(route.ultimate.id, 'spineU');
  assert.ok(!('superultimate' in route), 'route invented a stage it has no dots for');
});

test('pruneTree stops at a pack ceiling below the tree top', () => {
  // 사쿠야몬/세인트가르고몬 have no 초궁극체 in canon; such a pack declares
  // its own ceiling and is judged against that, not against the full tree.
  const short = pruneTree(TREE, (sprite) => sprite !== 'superultimate', 'ultimate');
  assert.ok(short, 'a line complete up to its declared ceiling was rejected');
  assert.strictEqual(short.superultimate, undefined, 'route ran past the declared ceiling');
  assert.deepStrictEqual(short.ultimate.map((n) => n.id), ['spineU']);
});

test('selectRoute only follows edges the tree declares', () => {
  for (let d = 1; d <= 40; d++) {
    const route = selectRoute(`2026-09-${String(d).padStart(2, '0')}`, 'p', PRUNED, [], null);
    assert.strictEqual(route.superultimate.id, 'top', `day ${d} lost the top stage`);
    assert.notStrictEqual(route.adult.id, 'deadA', `day ${d} drew a pruned branch`);
    // Every hop must appear in the previous node's next list.
    const stages = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];
    for (let i = 1; i < stages.length; i++) {
      const from = PRUNED[stages[i - 1]].find((n) => n.id === route[stages[i - 1]].id);
      assert.ok(
        from.next.includes(route[stages[i]].id),
        `day ${d}: ${from.id} -> ${route[stages[i]].id} is not an edge`
      );
    }
  }
});

test('selectRoute walks only to the pack declared ceiling', () => {
  const short = pruneTree(TREE, (sprite) => sprite !== 'superultimate', 'ultimate');
  const route = selectRoute('2026-09-01', 'p', short, [], null);
  assert.strictEqual(route.ultimate.id, 'spineU');
  assert.ok(!('superultimate' in route), 'route invented a stage past the ceiling');
});

test('selectRoute prefers branches matching the day traits', () => {
  for (let d = 1; d <= 30; d++) {
    const route = selectRoute(`2026-10-${String(d).padStart(2, '0')}`, 'p', PRUNED, ['dark'], null);
    assert.strictEqual(route.adult.id, 'darkA', `day ${d} ignored the dark trait`);
  }
});

test('selectRoute falls back to every candidate when no trait matches', () => {
  const ids = new Set();
  for (let d = 1; d <= 30; d++) {
    ids.add(selectRoute(`2026-11-${String(d).padStart(2, '0')}`, 'p', PRUNED, ['nonexistent'], null).adult.id);
  }
  assert.ok(ids.size > 1, `an unmatched trait narrowed the draw to ${[...ids]}`);
});

test('selectRoute steps away from yesterday route', () => {
  const yesterday = selectRoute('2026-07-30', 'p', PRUNED, [], null);
  const guarded = selectRoute('2026-07-30', 'p', PRUNED, [], yesterday);
  assert.notDeepStrictEqual(guarded, yesterday);
  assert.strictEqual(guarded.superultimate.id, 'top');
});

test('activeTraits reads the day rather than luck', () => {
  assert.deepStrictEqual(activeTraits({ failureRatio: 0, sessionCount: 1, topShare: 0.2 }), []);
  assert.deepStrictEqual(activeTraits({ failureRatio: 0.2, sessionCount: 1, topShare: 0.1 }), ['dark']);
  assert.deepStrictEqual(
    activeTraits({ failureRatio: 0, sessionCount: 7, topShare: 0.9 }),
    ['swarm', 'focus']
  );
});

// --- pack ceilings (topStage) ----------------------------------------
//
// A line can be short on purpose. 사쿠야몬 and 세인트가르고몬 have no
// 합체/모드체인지 form in canon, so those packs top out at 궁극체 and no
// amount of sprite work will change that -- while 임프몬 is only waiting
// for 베르제브몬 블래스트 모드 dots. Before topStage both looked like the
// same "doesn't reach the top" case and both sat out the rotation.

function writeTreePack(packsDir, name, { topStage, stageNames, tree }) {
  const dir = path.join(packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const body = { name };
  if (topStage) body.topStage = topStage;
  body.stageNames = stageNames;
  if (tree) body.tree = tree;
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(body, null, 2));
  return dir;
}

test('packTopStage honours a declared ceiling', (t) => {
  const { packsDir } = makeRoot(t);
  writeTreePack(packsDir, 'short', { topStage: 'ultimate', stageNames: { ultimate: '사쿠야몬' } });
  assert.strictEqual(packTopStage(packsDir, 'short'), 'ultimate');
});

test('packTopStage holds an undeclared pack to the full tree', (t) => {
  const { packsDir } = makeRoot(t);
  writeTreePack(packsDir, 'silent', { stageNames: { ultimate: '베르제브몬' } });
  assert.strictEqual(packTopStage(packsDir, 'silent'), topStageId());
});

test('packTopStage ignores a ceiling that is not a real stage', (t) => {
  const { packsDir } = makeRoot(t);
  writeTreePack(packsDir, 'typo', { topStage: 'megaultimate', stageNames: {} });
  assert.strictEqual(packTopStage(packsDir, 'typo'), topStageId());
});

test('packTopStage falls back to the full tree with no pack.json', (t) => {
  const { packsDir } = makeRoot(t);
  fs.mkdirSync(path.join(packsDir, 'bare'), { recursive: true });
  assert.strictEqual(packTopStage(packsDir, 'bare'), topStageId());
});

test('listRotationPacks admits a line that reaches its own declared ceiling', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  writeSharedEgg(sharedDir);
  for (const f of ['idle-0.png', 'digitama-0.png']) {
    // renamon-shaped: complete through 궁극체, no 초궁극체 in canon.
    const dir = writeTreePack(packsDir, 'short', {
      topStage: 'ultimate',
      stageNames: { child: '레나몬', ultimate: '사쿠야몬' }
    });
    fs.writeFileSync(path.join(dir, f), 'png');
  }
  // impmon-shaped: silent about its ceiling, so it is held to the full
  // tree and stays out until 초궁극체 is actually named.
  writePack(packsDir, 'unfinished', FULL, { topStage: false });

  assert.deepStrictEqual(listRotationPacks(packsDir, sharedDir), ['short']);
});

// --- readTree: R7 fallback -------------------------------------------

test('readTree returns null when the line has no walkable route', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const dir = writeTreePack(packsDir, 'half', {
    stageNames: { child: '반쯤' },
    tree: TREE
  });
  // Only the egg has dots: the rest of the line is named but not drawn yet,
  // which is the normal state of a half-filled pack (dots are gitignored).
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'digitama-0.png'), 'png');
  assert.strictEqual(readTree(packsDir, 'half', sharedDir), null);
});

test('readTree prunes to the routes whose dots exist', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const dir = writeTreePack(packsDir, 'partial', {
    stageNames: { child: '일부' },
    tree: TREE
  });
  for (const s of ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate']) {
    fs.writeFileSync(path.join(dir, `${s}-0.png`), 'png');
  }
  // adult-dark and adult-dead deliberately absent.
  const tree = readTree(packsDir, 'partial', sharedDir);
  assert.deepStrictEqual(tree.adult.map((n) => n.id), ['spineA']);
});

// --- tree lint: the shipped pack.json files --------------------------
//
// R1 only holds if the adjacency lists are sound, and a typo'd `next` id
// used to be invisible: the spine return quietly covered for it. These
// run against the real pack.json files, which are tracked (unlike dots).

const STAGE_ORDER = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];

test('shipped pack trees only point at the next stage', () => {
  const packsDir = path.join(__dirname, '..', 'sprites', 'packs');
  for (const pack of fs.readdirSync(packsDir)) {
    if (pack.startsWith('.')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8'));
    } catch (e) {
      continue; // no pack.json is a valid state; listRotationPacks handles it
    }
    if (!parsed.tree) continue;
    const stageOf = new Map();
    for (const stage of STAGE_ORDER) {
      for (const node of parsed.tree[stage] || []) {
        assert.ok(!stageOf.has(node.id), `${pack}: duplicate node id ${node.id}`);
        stageOf.set(node.id, stage);
        assert.ok(node.name && node.sprite, `${pack}: ${node.id} is missing name or sprite`);
      }
    }
    const ceiling = parsed.topStage || STAGE_ORDER[STAGE_ORDER.length - 1];
    for (const stage of STAGE_ORDER) {
      const nodes = parsed.tree[stage] || [];
      if (stage !== ceiling) {
        assert.ok(nodes.length > 0, `${pack}: stage ${stage} has no spine`);
      }
      const expected = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
      for (const node of nodes) {
        for (const id of node.next || []) {
          assert.ok(stageOf.has(id), `${pack}: ${node.id} -> ${id} does not exist`);
          // Pointing only one stage forward makes cycles impossible.
          assert.strictEqual(
            stageOf.get(id),
            expected,
            `${pack}: ${node.id} (${stage}) -> ${id} (${stageOf.get(id)}) skips or reverses a stage`
          );
        }
        if (stage === ceiling) {
          assert.deepStrictEqual(node.next || [], [], `${pack}: ${node.id} evolves past the ceiling`);
        }
      }
      if (stage === ceiling) break;
    }
  }
});

// --- the generated node map ------------------------------------------
//
// docs/evolution-routes.md carries a mermaid map of every pack's tree. It is
// generated from pack.json, so the only way it stays true is for staleness to
// be a test failure rather than something you notice months later.
//
// This asserts the doc matches what the generator produces *right now*, which
// also means the pruning shown in the map is the pruning the draw uses.

test('the evolution map in the docs is not stale', () => {
  const { render, splice, DOC } = require('../scripts/evolution-map');
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.strictEqual(
    doc,
    splice(doc, render()),
    'docs/evolution-routes.md map is stale -- run: node scripts/evolution-map.js --write'
  );
});
