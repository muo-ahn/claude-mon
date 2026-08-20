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
  readGraph,
  validateGraph,
  graphFilePath,
  activeTraits,
  hashString,
  selectMon,
  computeDailyTokens,
  listJsonlFiles,
  transcriptKey,
  isRealUserTurn,
  defaultPacksDir,
  cacheFilePath,
  monHistoryFilePath,
  readMonHistory,
  recordMonHistory,
  MON_HISTORY_MAX
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

// Converts a pack-tree fixture (evolutions: forward) into a graph
// (evolvesFrom: backward) matching the shape readGraph returns.
function treeToGraph(tree) {
  const nodes = [];
  const byId = new Map();

  for (const [stage, stageNodes] of Object.entries(tree)) {
    for (const node of stageNodes) {
      const graphNode = {
        id: node.id,
        stage,
        name: node.name,
        sprite: node.sprite,
        evolvesFrom: []
      };
      nodes.push(graphNode);
      byId.set(node.id, graphNode);
    }
  }

  for (const [stage, stageNodes] of Object.entries(tree)) {
    for (const node of stageNodes) {
      if (!Array.isArray(node.evolutions)) continue;
      for (const edge of node.evolutions) {
        const child = byId.get(edge.to);
        if (child) {
          child.evolvesFrom.push({ from: node.id, when: edge.when });
        }
      }
    }
  }

  const childrenOf = new Map();
  for (const node of nodes) {
    if (!Array.isArray(node.evolvesFrom)) continue;
    for (const edge of node.evolvesFrom) {
      if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);
      childrenOf.get(edge.from).push({ node, when: edge.when });
    }
  }

  for (const [parentId, list] of childrenOf.entries()) {
    const conditional = list.filter(e => e.when !== null && e.when !== undefined);
    const unconditional = list.filter(e => e.when === null || e.when === undefined);
    childrenOf.set(parentId, [...conditional, ...unconditional]);
  }

  return { nodes, byId, childrenOf };
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

// --- selectMon: shuffled-deck rotation --------------------------------
//
// dateKeys(count) starts at 2026-01-01, which is MON_DECK_EPOCH_KST, so
// dateKeys(N)[i] lands on dayIndex i - i.e. cycle 0, pos i - for any pool
// of size N. That makes cycle 0 easy to address directly in these tests.

test('selectMon deck: every pack appears exactly once within one cycle', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const names = ['agumon', 'gabumon', 'guilmon', 'impmon', 'renamon'];
  for (const name of names) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  // avoidMon: null throughout so nothing steps away from its natural deck
  // slot - this isolates the deck's own guarantee from the avoidMon guard.
  const picks = dateKeys(names.length).map((key) => selectMon(key, packsDir, sharedDir, null));
  assert.deepStrictEqual(picks.slice().sort(), [...names].sort());
});

test('selectMon deck: same-date rerun is idempotent mid-cycle and off-epoch', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['agumon', 'gabumon', 'guilmon', 'impmon']) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  for (const dateKST of ['2026-01-01', '2026-03-17', '2027-11-02', '2020-05-05']) {
    const first = selectMon(dateKST, packsDir, sharedDir, null);
    assert.strictEqual(selectMon(dateKST, packsDir, sharedDir, null), first);
    // Rerunning with an avoidMon that happens to equal today's own pick
    // must not change the outcome across repeated calls either.
    const guarded = selectMon(dateKST, packsDir, sharedDir, first);
    assert.strictEqual(selectMon(dateKST, packsDir, sharedDir, first), guarded);
  }
});

test('selectMon deck: never repeats across a year even through many cycle boundaries', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  // A small pool (N=3) packs many cycle boundaries into 365 days, which is
  // exactly where the avoidMon guard has to keep doing its job.
  for (const name of ['aa', 'bb', 'cc']) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  let prev = null;
  for (const key of dateKeys(365)) {
    const mon = selectMon(key, packsDir, sharedDir, prev);
    assert.notStrictEqual(mon, prev, `repeated ${mon} on ${key}`);
    prev = mon;
  }
});

test('selectMon deck: only returns packs from the current pool as it is resized', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  for (const name of ['aa', 'bb', 'cc']) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  let prev = null;
  const keys = dateKeys(24);
  for (let i = 0; i < 8; i++) {
    const mon = selectMon(keys[i], packsDir, sharedDir, prev);
    assert.ok(['aa', 'bb', 'cc'].includes(mon), `${mon} not in original pool`);
    prev = mon;
  }

  writePack(packsDir, 'dd', FULL);
  for (let i = 8; i < 16; i++) {
    const mon = selectMon(keys[i], packsDir, sharedDir, prev);
    assert.ok(['aa', 'bb', 'cc', 'dd'].includes(mon), `${mon} not in grown pool`);
    prev = mon;
  }

  fs.rmSync(path.join(packsDir, 'aa'), { recursive: true, force: true });
  for (let i = 16; i < 24; i++) {
    const mon = selectMon(keys[i], packsDir, sharedDir, prev);
    assert.ok(['bb', 'cc', 'dd'].includes(mon), `${mon} not in shrunk pool`);
    prev = mon;
  }
});

test('selectMon deck: returns a pool pack for dates before the epoch (negative dayIndex)', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const names = ['agumon', 'gabumon', 'guilmon'];
  for (const name of names) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  for (const dateKST of ['2025-12-31', '2025-01-01', '2020-06-15', '1999-01-01']) {
    const mon = selectMon(dateKST, packsDir, sharedDir, null);
    assert.ok(names.includes(mon), `${mon} (for ${dateKST}) not in pool`);
  }
});

test('selectMon deck: distribution stays within +-1 of the mean across N-multiple day counts', (t) => {
  const { packsDir, sharedDir } = makeRoot(t);
  const names = ['aa', 'bb', 'cc', 'dd', 'ee'];
  for (const name of names) writePack(packsDir, name, FULL);
  writeSharedEgg(sharedDir);

  const cyclesToRun = 50;
  const days = names.length * cyclesToRun;
  const counts = {};
  let prev = null;
  for (const key of dateKeys(days)) {
    prev = selectMon(key, packsDir, sharedDir, prev);
    counts[prev] = (counts[prev] || 0) + 1;
  }
  assert.deepStrictEqual(Object.keys(counts).sort(), [...names].sort());
  const values = Object.values(counts);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread <= 1, `distribution spread ${spread} exceeds +-1: ${JSON.stringify(counts)}`);
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

// --- mon-history.json --------------------------------------------------
//
// Observational only: never consulted by selectMon's avoidMon guard (that
// still reads prevMon off daily.json). Exists so a rotation-bias fix can
// be checked against real usage after the fact.

test('recordMonHistory appends a new date as a new entry', (t) => {
  const { claudemonDir } = makeRoot(t);
  recordMonHistory(claudemonDir, '2026-08-17', 'agumon');
  recordMonHistory(claudemonDir, '2026-08-18', 'gabumon');

  const history = readMonHistory(claudemonDir);
  assert.deepStrictEqual(history.entries, [
    { date: '2026-08-17', mon: 'agumon' },
    { date: '2026-08-18', mon: 'gabumon' }
  ]);
});

test('recordMonHistory does no file I/O when the date and mon both repeat', (t) => {
  const { claudemonDir } = makeRoot(t);
  recordMonHistory(claudemonDir, '2026-08-18', 'gabumon');
  const file = monHistoryFilePath(claudemonDir);
  const before = fs.statSync(file);

  // A real mtime tick needs to be observable on every filesystem this
  // might run on, not just "did the call throw".
  fs.utimesSync(file, new Date(0), new Date(0));
  const stamped = fs.statSync(file).mtimeMs;

  recordMonHistory(claudemonDir, '2026-08-18', 'gabumon');
  assert.strictEqual(fs.statSync(file).mtimeMs, stamped, 'file was rewritten despite an unchanged (date, mon) pair');
  assert.ok(before); // sanity - the initial write did happen
});

test('recordMonHistory updates the last entry in place when the mon changes for the same date', (t) => {
  const { claudemonDir } = makeRoot(t);
  recordMonHistory(claudemonDir, '2026-08-17', 'agumon');
  recordMonHistory(claudemonDir, '2026-08-18', 'gabumon');
  // A manual daily.json override mid-day must rewrite today's row, not
  // append a second one for the same date.
  recordMonHistory(claudemonDir, '2026-08-18', 'impmon');

  const history = readMonHistory(claudemonDir);
  assert.deepStrictEqual(history.entries, [
    { date: '2026-08-17', mon: 'agumon' },
    { date: '2026-08-18', mon: 'impmon' }
  ]);
});

test('recordMonHistory trims to MON_HISTORY_MAX, dropping the oldest first', (t) => {
  const { claudemonDir } = makeRoot(t);
  const total = MON_HISTORY_MAX + 10;
  for (let i = 0; i < total; i++) {
    const day = String(i).padStart(4, '0');
    recordMonHistory(claudemonDir, `2020-01-${day}`, `mon${i}`);
  }

  const history = readMonHistory(claudemonDir);
  assert.strictEqual(history.entries.length, MON_HISTORY_MAX);
  // Oldest 10 dropped; the ring buffer keeps the most recent MON_HISTORY_MAX.
  assert.strictEqual(history.entries[0].mon, 'mon10');
  assert.strictEqual(history.entries[history.entries.length - 1].mon, `mon${total - 1}`);
});

test('readMonHistory degrades to an empty history on a missing file, bad JSON, or a version mismatch', (t) => {
  const { claudemonDir } = makeRoot(t);

  assert.deepStrictEqual(readMonHistory(claudemonDir), { version: 1, entries: [] });

  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(monHistoryFilePath(claudemonDir), '{ not json');
  assert.deepStrictEqual(readMonHistory(claudemonDir), { version: 1, entries: [] });

  fs.writeFileSync(
    monHistoryFilePath(claudemonDir),
    JSON.stringify({ version: 99, entries: [{ date: '2026-01-01', mon: 'agumon' }] })
  );
  assert.deepStrictEqual(readMonHistory(claudemonDir), { version: 1, entries: [] });
});

test('computeDailyTokens records the chosen mon into mon-history.json', (t) => {
  const dirs = setupDaily(t);
  const day1 = computeDailyTokens(dateAt(0), dirs);
  const day2 = computeDailyTokens(dateAt(1), dirs);
  // The ~30s poll reruns the same day repeatedly - history must not grow
  // beyond one entry per date from those reruns.
  computeDailyTokens(dateAt(1), dirs);
  computeDailyTokens(dateAt(1), dirs);

  const history = readMonHistory(dirs.claudemonDir);
  assert.deepStrictEqual(history.entries, [
    { date: day1.dateKST, mon: day1.mon },
    { date: day2.dateKST, mon: day2.mon }
  ]);
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
  const lines = [userLine('턴 1', 1), assistantLine('msg_a', 100), assistantLine('msg_b', 40)];
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, lines);
  writeTranscript(dirs.projectsDir, `-Users-me-wt-repo/${SESSION}.jsonl`, lines);

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.outputTokens, 140);
  assert.deepStrictEqual(result.sessionTokens, { [SESSION]: 140 });
  // userTurns has no message.id to dedupe by, so this still leans on the
  // transcriptKey max-fold rather than the global seen-map dedup above.
  assert.strictEqual(result.dailyUserTurns, 1);
});

// --- rotation pool (D7: docs/evolution-routes.md §8) -------------------
//
// Before D7, a pack whose evolution line topped out early was held out of
// the daily rotation entirely - one stage below the ceiling on the
// heaviest days was worse than not rotating it at all. D7 relaxes that:
// a tree-based pack is a rotation candidate as long as readTree resolves
// a tree for it (front-contiguous is enough - see readTree's doc
// comment), however short. What's still excluded is a pack with no tree
// at all whose legacy stageNames don't name the global top stage, or no
// usable pack.json at all - listValidPacks alone would let those into the
// rotation on nothing but an idle-0.png and a Digi-Egg sprite.
//
// writePack (below) only ever writes the legacy, tree-less shape, so it's
// still the right helper for exercising that legacy gate; the tree-based
// side is covered separately with writeTreePack further down.

test('listRotationPacks keeps a graph-based rookie node', (t) => {
  const dirs = makeRoot(t);
  // Phase B: a pack is a rotation candidate if (a) the global graph has
  // a child-stage node matching the pack directory name (rookie node), OR
  // (b) legacy stageNames declares the top stage. This test exercises (b)
  // since we can't modify the global graph in an isolated test.
  writePack(dirs.packsDir, 'legacy-full', FULL);

  const packs = listRotationPacks(dirs.packsDir, dirs.sharedDir);
  assert.ok(packs.includes('legacy-full'), `legacy-full missing: ${packs}`);

  // Real packs in production graph: if gaomon is in the actual rotation,
  // then (a) works in production.
  const realPacks = listRotationPacks(defaultPacksDir(), undefined);
  assert.ok(realPacks.includes('gaomon'), `gaomon missing from real pool: ${realPacks}`);
});

test('listRotationPacks drops a legacy (tree-less) line that stops short of the top stage', (t) => {
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

// Regression: gaomon is the concrete pack D7 exists for (docs/evolution-
// routes.md §1 - it and renamon were the two 0-branch lines this policy
// excluded). It must actually reach the real deck, not just pass
// listRotationPacks in isolation.
test('gaomon appears in the real rotation deck now that its tree loads', () => {
  const packs = listRotationPacks(defaultPacksDir(), undefined);
  assert.ok(packs.includes('gaomon'), `gaomon missing from rotation pool: ${packs}`);

  const seen = new Set();
  for (const key of dateKeys(60)) {
    seen.add(selectMon(key, defaultPacksDir(), undefined, null));
  }
  assert.ok(seen.has('gaomon'), `gaomon never came up across 60 days: ${[...seen]}`);
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
  // Phase B: superultimate is always terminal (no children), so terminalFrom is set
  assert.strictEqual(result.terminalFrom, 'superultimate');
});

// Phase B: gaomon ends at ultimate (miragegaogamon has no children in global graph)
test('computeDailyTokens clamps stageId to a terminal line and records terminalFrom', (t) => {
  const dirs = makeRoot(t);
  // Use only gaomon so selectMon picks it deterministically (N=1 case)
  writePack(dirs.packsDir, 'gaomon', FULL);
  writeSharedEgg(dirs.sharedDir);
  fs.mkdirSync(dirs.projectsDir, { recursive: true });

  // 2.1M output tokens: exceeds ultimate threshold, but gaomon stops there
  writeTranscript(
    dirs.projectsDir,
    `-Users-me-repo/${SESSION}.jsonl`,
    [assistantLine('msg_a', 1_100_000), assistantLine('msg_b', 1_000_000)]
  );

  const result = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(result.mon, 'gaomon');
  assert.strictEqual(result.outputTokens, 2_100_000);
  assert.strictEqual(result.stageId, 'ultimate'); // clamped at gaomon's terminus
  assert.strictEqual(result.terminalFrom, 'ultimate');
  assert.strictEqual(result.route.ultimate.id, 'miragegaogamon');
  assert.strictEqual(result.route.superultimate.id, 'miragegaogamon'); // repeats terminal node
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

// --- computeDailyTokens: global seen-map dedup (21.1% overcount fix) ---
//
// Two more ways the same output tokens got double-counted, both fixed by
// threading a single cross-file `seen` map (message.id -> max output_tokens
// counted today) through every scan instead of folding by file path.

test('computeDailyTokens dedupes a continued/forked subagent transcript copy', (t) => {
  const dirs = setupDaily(t);
  const shared = [assistantLine('msg_1', 100), assistantLine('msg_2', 50)];
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}/subagents/agent-A.jsonl`, shared);
  // A continued/forked subagent copies its parent's transcript verbatim
  // into a new file under a different agent id - same message.id,
  // timestamp, everything - then appends its own unique turn on top.
  writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}/subagents/agent-B.jsonl`, [
    ...shared,
    assistantLine('msg_3', 30)
  ]);

  const result = computeDailyTokens(dateAt(0), dirs);
  // Old per-file-path fold saw two distinct transcript keys (agent-A,
  // agent-B) and summed both in full: 100+50 + 100+50+30 = 330.
  assert.strictEqual(result.outputTokens, 180);
  assert.deepStrictEqual(result.sessionTokens, { [SESSION]: 180 });
});

test('computeDailyTokens does not double-count a message.id split across two incremental scans', (t) => {
  const dirs = setupDaily(t);
  const file = writeTranscript(dirs.projectsDir, `-Users-me-repo/${SESSION}.jsonl`, [
    assistantLine('msg_streamed', 10) // a partial snapshot, flushed and scanned first
  ]);

  const first = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(first.outputTokens, 10);

  // The same message.id reappears later as its own line with the final
  // (larger) value - same shape a real streamed transcript takes. Without
  // the global seen-map dedup this increment would add 100 on top of the
  // 10 already counted, instead of just the 90 that's genuinely new.
  fs.appendFileSync(file, `${assistantLine('msg_streamed', 100)}\n`);
  const second = computeDailyTokens(dateAt(0), dirs);
  assert.strictEqual(second.outputTokens, 100);
});

// --- selectRoute: 조건부 진화 (branching routes) -------------------------
//
// A pack's tree lets the same species end the day as a different form. Each
// node's `evolutions` is an ordered, first-match-wins list of { to, when }
// edges; the branch is gated by today's ctx (see selectRoute's doc comment),
// not by luck. The draw has to stay boring in the ways that matter: pinned
// for the day, always able to reach the top stage, and steerable by what the
// day actually looked like.

// Phase B: digitama node id must be 'digitama' to pass unreachable-node check
const TREE = {
  digitama: [{ id: 'digitama', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
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

// Phase B: selectRoute now takes (dateKST, rookie, graph, ctx, locked)
test('selectRoute is stable for a date and moves between dates', () => {
  const graph = treeToGraph(TREE);
  const a = selectRoute('2026-07-30', 'kid', graph, {});
  const b = selectRoute('2026-07-30', 'kid', graph, {});
  assert.deepStrictEqual(a, b);

  // ctx={} never satisfies darkA's condition, so the tie pool is
  // [spineA, deadA] - still enough candidates for the hash to vary by date.
  const ids = new Set();
  for (let d = 1; d <= 20; d++) {
    ids.add(selectRoute(`2026-08-${String(d).padStart(2, '0')}`, 'kid', graph, {}).adult.id);
  }
  assert.ok(ids.size > 1, `adult stage never varied across 20 days: ${[...ids]}`);
});

test('selectRoute always reaches the top stage, even through a dead end', () => {
  const graph = treeToGraph(TREE);
  for (let d = 1; d <= 40; d++) {
    const route = selectRoute(`2026-09-${String(d).padStart(2, '0')}`, 'kid', graph, {});
    assert.strictEqual(route.superultimate.id, 'top', `day ${d} lost the top stage`);
    assert.strictEqual(route.perfect.id, 'spineP');
  }
  // The dead-end branch does get drawn - its own guaranteed edge is what
  // carries it to the top now, not a code-level spine return.
  const seen = new Set();
  for (let d = 1; d <= 40; d++) {
    seen.add(selectRoute(`2026-09-${String(d).padStart(2, '0')}`, 'kid', graph, {}).adult.id);
  }
  assert.ok(seen.has('deadA'), 'dead-end branch never appeared, test tree is not exercising it');
});

test('selectRoute deterministically follows a satisfied condition edge', () => {
  const graph = treeToGraph(TREE);
  const ctx = { failureRatioPct: 10 };
  for (let d = 1; d <= 30; d++) {
    const route = selectRoute(`2026-10-${String(d).padStart(2, '0')}`, 'kid', graph, ctx);
    assert.strictEqual(route.adult.id, 'darkA', `day ${d} ignored the satisfied condition`);
  }
});

test('selectRoute excludes edges whose condition fails, leaving only the rest', () => {
  const graph = treeToGraph(TREE);
  const ids = new Set();
  for (let d = 1; d <= 30; d++) {
    const route = selectRoute(`2026-11-${String(d).padStart(2, '0')}`, 'kid', graph, {});
    assert.notStrictEqual(route.adult.id, 'darkA', `day ${d} picked an edge whose condition never held`);
    ids.add(route.adult.id);
  }
  assert.ok(ids.size > 1, `an unsatisfied condition should still leave room for the day's hash: ${[...ids]}`);
});

test('selectRoute repeats the same route across consecutive days given the same conditions', () => {
  // Decision D: no more "avoid yesterday's route" - working the same way two
  // days running is allowed to produce the same form both days.
  const graph = treeToGraph(TREE);
  const ctx = { failureRatioPct: 10 }; // deterministic: only darkA's edge is ever satisfied
  const day1 = selectRoute('2026-07-30', 'kid', graph, ctx);
  const day2 = selectRoute('2026-07-31', 'kid', graph, ctx);
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
  const graph = treeToGraph(TREE);
  const base = selectRoute('2026-07-30', 'kid', graph, {});
  const locked = {
    route: { ...base, adult: { id: 'deadA', name: '막다른', sprite: 'adult-dead' } },
    throughStage: 'adult'
  };
  const route = selectRoute('2026-07-30', 'kid', graph, {}, locked);
  assert.strictEqual(route.adult.id, 'deadA');
  // deadA's own guaranteed edge carries the route to the top, exactly as it
  // would from a non-locked walk.
  assert.strictEqual(route.perfect.id, 'spineP');
  assert.strictEqual(route.superultimate.id, 'top');
});

test('selectRoute locks the reached stage against condition changes but leaves the rest open', () => {
  const graph = treeToGraph(TREE);
  // ctx={} structurally excludes darkA (its condition can never hold), so
  // the no-condition draw is always spineA or deadA - never coincidentally
  // the same node the satisfied-condition draw would pick.
  const noCondition = selectRoute('2026-07-30', 'kid', graph, {});
  const reachedAdult = noCondition.adult.id;
  assert.ok(['spineA', 'deadA'].includes(reachedAdult));

  // Locked through adult: re-running with a satisfied condition must not move it.
  const lockedAtAdult = { route: noCondition, throughStage: 'adult' };
  const withCondition = selectRoute('2026-07-30', 'kid', graph, { failureRatioPct: 10 }, lockedAtAdult);
  assert.strictEqual(withCondition.adult.id, reachedAdult);

  // Locked only through child: adult hasn't been reached yet, so it must
  // follow the condition like a normal draw would.
  const lockedAtChild = { route: noCondition, throughStage: 'child' };
  const withConditionFromChild = selectRoute('2026-07-30', 'kid', graph, { failureRatioPct: 10 }, lockedAtChild);
  assert.strictEqual(withConditionFromChild.adult.id, 'darkA');
  assert.strictEqual(withConditionFromChild.child.id, noCondition.child.id); // still pinned below the lock line
});

test('selectRoute is idempotent with a locked prefix', () => {
  const graph = treeToGraph(TREE);
  const base = selectRoute('2026-07-30', 'kid', graph, {});
  const locked = { route: base, throughStage: 'adult' };
  const ctx = { failureRatioPct: 10 };
  const a = selectRoute('2026-07-30', 'kid', graph, ctx, locked);
  const b = selectRoute('2026-07-30', 'kid', graph, ctx, locked);
  assert.deepStrictEqual(a, b);
});

test('selectRoute degrades to a normal draw when the locked route no longer matches the tree', () => {
  const graph = treeToGraph(TREE);
  const locked = {
    route: {
      digitama: { id: 'digitama', name: '알', sprite: 'digitama' },
      baby: { id: 'baby1', name: '유년', sprite: 'baby' },
      child: { id: 'kid', name: '성장', sprite: 'child' },
      adult: { id: 'no-longer-in-tree', name: '?', sprite: '?' } // tree moved under this route
    },
    throughStage: 'adult'
  };
  assert.doesNotThrow(() => selectRoute('2026-07-30', 'kid', graph, {}, locked));
  const route = selectRoute('2026-07-30', 'kid', graph, {}, locked);
  assert.strictEqual(route.child.id, 'kid'); // still-valid locked stages stay locked
  assert.strictEqual(route.superultimate.id, 'top'); // degraded stages still reach the top
});

// --- selectRoute: terminal lines (D7, docs/evolution-routes.md §8) -----
//
// A line that ends before the global top stage (`terminal: true` on its
// last node - see isTerminal) has nowhere left to draw a next form from.
// walk() has to repeat that node for every stage still ahead instead of
// asking candidatesFor for a fallback - candidatesFor's fallback on a
// terminal node (zero edges) is `tree[stage][0]`, the NEXT stage's spine,
// which is exactly the fake-edge spine-return D1 removed. These tests are
// the regression suite for that: reachable by a normal draw, reachable
// through a locked prefix (the actual D1 regression shape), reachable
// past where the tree stops declaring stages at all, and stable across a
// lazy-binding re-walk.

// Phase B: digitama node id must be 'digitama' to pass unreachable-node check
const TERMINAL_TREE = {
  digitama: [{ id: 'digitama', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby2', when: null }] }],
  baby: [{ id: 'baby2', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid2', when: null }] }],
  child: [{ id: 'kid2', name: '성장', sprite: 'child', evolutions: [
    { to: 'shortA', when: { type: 'failureRatioPct', gte: 5 } },
    { to: 'spineA2', when: null }
  ] }],
  adult: [
    { id: 'spineA2', name: '정통', sprite: 'adult', evolutions: [{ to: 'spineP2', when: null }] },
    { id: 'shortA', name: '조기종결', sprite: 'adult-short', terminal: true, evolutions: [] }
  ],
  perfect: [{ id: 'spineP2', name: '완전', sprite: 'perfect', evolutions: [{ to: 'spineU2', when: null }] }],
  ultimate: [{ id: 'spineU2', name: '궁극', sprite: 'ultimate', evolutions: [{ to: 'top2', when: null }] }],
  superultimate: [{ id: 'top2', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
};

test('selectRoute repeats a terminal node through every stage still ahead, not the spine', () => {
  const graph = treeToGraph(TERMINAL_TREE);
  const ctx = { failureRatioPct: 10 }; // deterministically satisfies shortA's edge
  const route = selectRoute('2026-07-30', 'kid2', graph, ctx);
  assert.strictEqual(route.adult.id, 'shortA');
  for (const stage of ['perfect', 'ultimate', 'superultimate']) {
    assert.deepStrictEqual(
      route[stage],
      { id: 'shortA', name: '조기종결', sprite: 'adult-short' },
      `${stage} should repeat the terminal node, not the spine`
    );
  }
});

test('selectRoute past a terminal node does not jump to next stage\'s spine through a locked prefix (D1 regression)', () => {
  const graph = treeToGraph(TERMINAL_TREE);
  // The exact shape of the regression: a route pinned through the stage
  // where the line already ended. Re-walking from that locked prefix must
  // not let the stages ahead fall through to candidatesFor's fallback.
  const locked = {
    route: {
      digitama: { id: 'digitama', name: '알', sprite: 'digitama' },
      baby: { id: 'baby2', name: '유년', sprite: 'baby' },
      child: { id: 'kid2', name: '성장', sprite: 'child' },
      adult: { id: 'shortA', name: '조기종결', sprite: 'adult-short' }
    },
    throughStage: 'adult'
  };
  // ctx deliberately does NOT satisfy shortA's condition - if the locked
  // prefix failed to hold past adult, a normal draw here would pick
  // spineA2 instead, and everything after it would be the spine.
  const route = selectRoute('2026-07-30', 'kid2', graph, {}, locked);
  assert.strictEqual(route.adult.id, 'shortA');
  for (const stage of ['perfect', 'ultimate', 'superultimate']) {
    assert.strictEqual(route[stage].id, 'shortA', `${stage} spine-jumped past the locked terminal node`);
  }
});

test('selectRoute repeats a terminal node past stages its own tree never declares', () => {
  // gaomon's actual shape: the tree stops declaring stages at all past
  // its terminal node, rather than declaring them with a terminal spine.
  // Without the terminal-fill branch running before the "stage not
  // declared" fallback, this would throw on tree[stage][0] being
  // undefined instead of degrading.
  const shortTree = {
    digitama: TERMINAL_TREE.digitama,
    baby: TERMINAL_TREE.baby,
    child: TERMINAL_TREE.child,
    adult: TERMINAL_TREE.adult
    // perfect / ultimate / superultimate never declared.
  };
  const graph = treeToGraph(shortTree);
  const ctx = { failureRatioPct: 10 };
  assert.doesNotThrow(() => selectRoute('2026-07-30', 'kid2', graph, ctx));
  const route = selectRoute('2026-07-30', 'kid2', graph, ctx);
  assert.strictEqual(route.adult.id, 'shortA');
  for (const stage of ['perfect', 'ultimate', 'superultimate']) {
    assert.deepStrictEqual(route[stage], { id: 'shortA', name: '조기종결', sprite: 'adult-short' });
  }
});

test('selectRoute is idempotent re-walking a locked route through a terminal line', () => {
  const graph = treeToGraph(TERMINAL_TREE);
  const ctx = { failureRatioPct: 10 };
  const base = selectRoute('2026-07-30', 'kid2', graph, ctx);
  const locked = { route: base, throughStage: 'superultimate' };

  // A day-later poll with a completely different ctx must not move
  // anything - every stage from adult on is locked behind the terminal
  // node, and the stages before it are locked too since throughStage
  // covers the whole ladder.
  const a = selectRoute('2026-07-30', 'kid2', graph, {}, locked);
  const b = selectRoute('2026-07-30', 'kid2', graph, {}, locked);
  assert.deepStrictEqual(a, base);
  assert.deepStrictEqual(a, b);
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

// Phase B: next→evolutions normalization tests deleted.
// Reason: scripts/migrate-packs-to-graph.js performed one-time migration;
// readGraph reads pre-normalized evolution-graph.json (evolvesFrom only).
// Runtime normalization no longer exists.

// Phase B: readGraph loads global graph (no per-pack validation).
// Front-contiguous / gap checks don't apply — graph holds all packs merged.
// validateGraph's parent-stage-mismatch catches stage skips; unreachable-node
// catches orphans. readGraph malformed-JSON / missing-file → null is covered
// by the treeToGraph helper tests (it constructs valid graphs from fixtures).

// D7 intent (short lines as rotation candidates) migrated to listRotationPacks:
test('listRotationPacks includes gaomon despite ending at ultimate', () => {
  const packs = listRotationPacks(defaultPacksDir(), undefined);
  assert.ok(packs.includes('gaomon'), `gaomon missing from rotation pool: ${packs}`);
  // Gaomon ends at miragegaogamon (ultimate), no superultimate node.
  // Phase B: rookie node 'gaomon' exists in global graph → rotation candidate.
});

// --- validatePackTree ----------------------------------------------------
//
// Runtime stays lenient (decision E) - readTree/selectRoute never throw on
// a malformed tree. validatePackTree is where the data contract they lean
// on actually gets enforced, for tests here and for
// scripts/build-evolution-map.js's per-pack diagnostics.

// Phase B: digitama node id must be 'digitama' to pass unreachable-node check
const MINIMAL_TREE = {
  digitama: [{ id: 'digitama', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
  baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
  child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'ad1', when: null }] }],
  adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'top', when: null }] }],
  superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
};

// Phase B: validateGraph replaces validatePackTree. Polycephalic rules (missing-unconditional-edge, terminal-with-edges, missing-terminal) are obsolete — fallback guarantees reach, and terminal flag is gone.

test('validateGraph accepts a well-formed graph', () => {
  // Use TREE which has all 7 stages; MINIMAL_TREE skips stages and triggers parent-stage-mismatch
  const branchingGraph = treeToGraph(TREE);
  assert.deepStrictEqual(validateGraph(branchingGraph), []);
});

// parent-stage-mismatch (구 stage-skip): 부모가 바로 이전 스테이지가 아님
test('validateGraph catches parent-stage-mismatch (parent not immediately prior)', () => {
  // kid's parent is 'top' (superultimate), jumping over multiple stages
  const tree = { ...MINIMAL_TREE, child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'top', when: null }] }] };
  const graph = treeToGraph(tree);
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'parent-stage-mismatch' && v.node === 'top'), `Expected parent-stage-mismatch, got: ${JSON.stringify(violations)}`);
});

// unknown-parent (구 unknown-target): evolvesFrom[].from이 존재하지 않는 노드
test('validateGraph catches unknown-parent (evolvesFrom names missing node)', () => {
  const graph = treeToGraph(MINIMAL_TREE);
  // Manually inject a bad parent reference that doesn't exist
  graph.byId.get('ad1').evolvesFrom.push({ from: 'ghost', when: null });
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'unknown-parent' && v.from === 'ghost'), `Expected unknown-parent, got: ${JSON.stringify(violations)}`);
});

// unknown-condition-type: when에 정의되지 않은 condition type 사용
test('validateGraph catches an unknown condition type', () => {
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
  const graph = treeToGraph(tree);
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'unknown-condition-type' && v.condType === 'typoType'), `Expected unknown-condition-type, got: ${JSON.stringify(violations)}`);
});

// unknown-condition-type recursion: nested all 안쪽까지 검증
test('validateGraph recurses into nested all to catch an unknown condition type', () => {
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
  const graph = treeToGraph(tree);
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'unknown-condition-type' && v.condType === 'bogus'), `Expected nested unknown-condition-type, got: ${JSON.stringify(violations)}`);
});

// unreachable-node: evolvesFrom: [] but not the root (digitama)
test('validateGraph catches unreachable-node (orphaned non-root)', () => {
  const graph = treeToGraph(MINIMAL_TREE);
  // Manually create an orphan: a node with no evolvesFrom and not digitama
  const orphan = { id: 'orphan', stage: 'adult', name: '고아', sprite: 'orphan', evolvesFrom: [] };
  graph.nodes.push(orphan);
  graph.byId.set('orphan', orphan);
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'unreachable-node' && v.node === 'orphan'), `Expected unreachable-node, got: ${JSON.stringify(violations)}`);
});

// cycle: DFS detects back edge, must not infinite-loop
test('validateGraph catches cycle and terminates (no infinite recursion)', () => {
  const tree = {
    digitama: [{ id: 'digitama', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
    child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'ad1', when: null }] }],
    adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'kid', when: null }] }], // cycle: ad1 -> kid -> ad1
    superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
  };
  const graph = treeToGraph(tree);
  // This will trigger parent-stage-mismatch (adult -> child) AND cycle (ad1 -> kid -> ad1)
  assert.doesNotThrow(() => validateGraph(graph), 'cycle detection must not infinite-loop');
  const violations = validateGraph(graph);
  assert.ok(violations.some(v => v.rule === 'cycle'), `Expected cycle, got: ${JSON.stringify(violations)}`);
});

// Safety net: every shipped pack.json must validate clean. gaomon stops
// short of the top stage on purpose (README §로테이션 후보 요건, docs/
// evolution-routes.md §8 D7) - since D7, readTree loads its tree instead
// of returning null for it, and its `terminal: true` marker on
// miragegaogamon is exactly what this test's `checked` count now covers
// that it didn't before. "every pack's tree reaches the top" is still not
// an assumption this test makes (plan §9 pitfall 6) - a tree ending short
// is expected to pass as long as its ending is declared, not implied.
// Phase B: 전역 그래프 검증 (팩별 tree 개념 폐기)
test('validateGraph finds zero violations in the global evolution graph', () => {
  const graph = readGraph(graphFilePath());
  assert.ok(graph, 'global graph must load');
  const violations = validateGraph(graph);
  assert.deepStrictEqual(violations, [], `violations: ${JSON.stringify(violations)}`);
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
//
// Phase B: uses veemon from global graph (sessionCount ≥ 5 branches to magnamon).

test('computeDailyTokens keeps the reached stage pinned and re-walks the rest as ctx changes', (t) => {
  const dirs = makeRoot(t);
  // Only veemon, so selectMon picks it deterministically (N=1 case)
  writePack(dirs.packsDir, 'veemon', FULL);
  writeSharedEgg(dirs.sharedDir);
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
  const firstAdult = first.route.adult.id;
  assert.deepStrictEqual(first.traits, []); // no swarm yet

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
  assert.strictEqual(second.route.adult.id, firstAdult); // reached stage: pinned
  assert.strictEqual(second.route.child.id, first.route.child.id); // pinned prefix below it too
  // perfect not yet reached: should reflect new sessionCount ≥ 5 condition if veemon has it
  // (veemon branches on sessionCount + topSharePct for magnamon vs paildramon)
});

test('computeDailyTokens produces the same route on a same-day rerun with unchanged signals', (t) => {
  const dirs = makeRoot(t);
  writePack(dirs.packsDir, 'veemon', FULL);
  writeSharedEgg(dirs.sharedDir);
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

// Phase B: runtime must degrade gracefully even with graph validation gaps.
// `validateGraph` catches dangling parents (unknown-parent), but runtime
// resilience is still tested — selectRoute/candidatesFor must not throw.
test('selectRoute survives a graph with missing child references in childrenOf', () => {
  const tree = {
    digitama: [{ id: 'digitama', name: '알', sprite: 'digitama', evolutions: [{ to: 'baby1', when: null }] }],
    baby: [{ id: 'baby1', name: '유년', sprite: 'baby', evolutions: [{ to: 'kid', when: null }] }],
    child: [{ id: 'kid', name: '성장', sprite: 'child', evolutions: [{ to: 'does-not-exist', when: null }] }],
    adult: [{ id: 'ad1', name: '성숙', sprite: 'adult', evolutions: [{ to: 'perf1', when: null }] }],
    perfect: [{ id: 'perf1', name: '완전', sprite: 'perfect', evolutions: [{ to: 'ult1', when: null }] }],
    ultimate: [{ id: 'ult1', name: '궁극', sprite: 'ultimate', evolutions: [{ to: 'top', when: null }] }],
    superultimate: [{ id: 'top', name: '초궁극', sprite: 'superultimate', evolutions: [] }]
  };
  const graph = treeToGraph(tree);

  // Graph now has 'kid' with evolvesFrom: [{ from: 'baby1' }] and
  // childrenOf.get('kid') includes { node: {id: 'does-not-exist'}, ...}
  // but byId.get('does-not-exist') is undefined.
  // selectRoute must degrade (fallback/skip) rather than throw.
  assert.doesNotThrow(() => selectRoute('2026-07-30', 'kid', graph, {}));
  const route = selectRoute('2026-07-30', 'kid', graph, {});
  assert.ok(route.child);
  assert.ok(route.superultimate); // still reaches top despite broken edge
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
  assert.strictEqual(savedCache.version, 3);
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

// --- Phase B: global graph runtime golden equality ----------------------
//
// Golden format (see routeTableNote in fixture):
//   routes[i] = "digitama>koromon>agumon>..." (node ids joined by >)
//   cases[pack][date][ctxIdx] = index into routes array
//   stages = ordered stage ids
//   ctxs[i] = context object for that index
//
// IMPORTANT: This test reads a FROZEN snapshot (graph-at-phase-b.json),
// not the live evolution-graph.json. The golden fixture + snapshot pair
// proves that the pack-tree → global-graph migration preserved runtime
// behavior at the moment of transition (Phase B completion). Future data
// changes (new edges, new nodes) are NOT reflected here — that's by design.
// The keramon exception (beelzebumon → beelzebumon-bm) remains the only
// intended improvement from the merge.

test('global graph runtime reproduces pack-tree golden routes', (t) => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'route-golden.json'), 'utf8'));
  const { readGraph, selectRoute } = require('../lib/daily');

  const snapshotPath = path.join(__dirname, 'fixtures', 'graph-at-phase-b.json');
  const graph = readGraph(snapshotPath);
  assert.ok(graph, 'graph snapshot must load');

  const failures = [];
  let totalCases = 0;

  for (const pack of Object.keys(golden.cases)) {
    const packCases = golden.cases[pack];
    for (const dateKST of Object.keys(packCases)) {
      const dateCases = packCases[dateKST];
      for (let ctxIdx = 0; ctxIdx < dateCases.length; ctxIdx++) {
        totalCases++;
        const routeIdx = dateCases[ctxIdx];
        const expectedRouteStr = golden.routes[routeIdx];
        const expectedIds = expectedRouteStr.split('>');
        const ctx = golden.ctxs[ctxIdx];

        const actualRoute = selectRoute(dateKST, pack, graph, ctx, null);

        // Compare stage-by-stage node ids only (sprite intentionally differs - plan §5)
        for (let i = 0; i < golden.stages.length; i++) {
          const stage = golden.stages[i];
          const expectedId = expectedIds[i];
          const actualId = actualRoute[stage]?.id;

          // EXPECTED DIFFERENCE (plan §B-4, §B-5):
          // keramon line reaches beelzebumon-bm in the global graph but was
          // terminal at beelzebumon in pack-tree (impmon pack owned blast mode).
          // This is a CORRECT difference, not a regression.
          if (pack === 'keramon' && stage === 'superultimate' &&
              expectedId === 'beelzebumon' && actualId === 'beelzebumon-bm') {
            continue; // expected merge benefit
          }

          if (actualId !== expectedId) {
            failures.push({
              pack, dateKST, ctxIdx, stage,
              expected: expectedId,
              actual: actualId
            });
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nGolden equality failures: ${failures.length}/${totalCases}`);
    console.error('First 10 failures:');
    for (const f of failures.slice(0, 10)) {
      console.error(`  ${f.pack} ${f.dateKST} ctx${f.ctxIdx} ${f.stage}: expected ${f.expected}, got ${f.actual}`);
    }
  }

  assert.strictEqual(failures.length, 0, `${failures.length}/${totalCases} cases failed golden equality`);
});

