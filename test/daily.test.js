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
