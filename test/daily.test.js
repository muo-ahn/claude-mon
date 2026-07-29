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
  hashString,
  selectMon,
  computeDailyTokens
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

function writePack(packsDir, name, files) {
  const dir = path.join(packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'png');
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
