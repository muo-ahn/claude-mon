const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanCodex } = require('../lib/codex');

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload }) + '\n';
}
function usage(timestamp, total, last) {
  return line(timestamp, 'event_msg', { type: 'token_count', info: {
    total_token_usage: { output_tokens: total, reasoning_output_tokens: 20 },
    last_token_usage: { output_tokens: last, reasoning_output_tokens: 10 }
  } });
}
function scan(dir, date = '2026-11-09') {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  return scanCodex(new Date(start + 3600000), { claudemonDir: path.join(dir, 'state'), codexDirs: [path.join(dir, 'logs')] }, start, start + 86400000, date).tokens;
}

test('Codex cumulative deltas, prior-day baseline, copies and partial lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const file = path.join(logs, 'rollout.jsonl');
  const content = line('2026-11-08T14:00:00Z', 'session_meta', { id: 'abc', cwd: '/work/project' }) +
    usage('2026-11-08T14:30:00Z', 100, 100) +
    line('2026-11-08T15:01:00Z', 'event_msg', { type: 'task_started' }) +
    usage('2026-11-08T15:02:00Z', 150, 50);
  fs.writeFileSync(file, 'null\nnot-json\n' + content);
  fs.writeFileSync(path.join(logs, 'copy.jsonl'), content);
  assert.deepEqual(scan(dir), { 'codex-abc': 50 });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state/sessions/codex-abc.json')));
  assert.equal(state.provider, 'codex'); assert.equal(state.cwd, '/work/project'); assert.equal(state.working, true);
  const next = usage('2026-11-08T15:03:00Z', 180, 30);
  fs.appendFileSync(file, next.slice(0, -1));
  assert.deepEqual(scan(dir), { 'codex-abc': 50 });
  fs.appendFileSync(file, '\n');
  assert.deepEqual(scan(dir), { 'codex-abc': 80 });
  assert.deepEqual(scan(dir), { 'codex-abc': 80 });
  fs.appendFileSync(file, line('2026-11-08T15:04:00Z', 'event_msg', { type: 'task_complete' }));
  scan(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state/sessions/codex-abc.json'))).working, false);
  fs.appendFileSync(file, usage('2026-11-09T15:01:00Z', 190, 10));
  assert.deepEqual(scan(dir, '2026-11-10'), { 'codex-abc': 10 });
});

test('Codex first cumulative snapshot excludes inherited tokens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'child.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { id: 'child' }) + usage('2026-11-08T15:01:00Z', 1000, 25));
  assert.deepEqual(scan(dir), { 'codex-child': 25 });
});

test('response records deduplicate inherited copies by response ID', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const record = line('2026-11-08T15:02:00Z', 'token_usage_record', {
    session_id: 'parent', response_id: 'response-1', usage: { output_tokens: 70, reasoning_output_tokens: 30 },
    thread_token_usage: { output_tokens: 1000 }
  });
  fs.writeFileSync(path.join(logs, 'parent.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { session_id: 'parent' }) + record);
  fs.writeFileSync(path.join(logs, 'child.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { session_id: 'child' }) + record + line('2026-11-08T15:03:00Z', 'token_usage_record', { session_id: 'child', response_id: 'response-2', usage: { output_tokens: 20 } }));
  assert.deepEqual(scan(dir), { 'codex-parent': 70, 'codex-child': 20 });
});

test('legacy usage before modern response survives format transition', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'one.jsonl'), line('2026-11-08T14:00:00Z', 'session_meta', { id: 'abc' }) + usage('2026-11-08T14:30:00Z', 100, 100) + usage('2026-11-08T15:01:00Z', 150, 50) + line('2026-11-08T15:02:00Z', 'token_usage_record', { session_id: 'abc', response_id: 'r1', usage: { output_tokens: 20 }, thread_token_usage: { output_tokens: 170 } }) + usage('2026-11-08T15:02:01Z', 170, 20));
  assert.deepEqual(scan(dir), { 'codex-abc': 70 });
});

test('replacing a rollout invalidates its cached identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const file = path.join(logs, 'one.jsonl');
  fs.writeFileSync(file, line('2026-11-08T15:00:00Z', 'session_meta', { id: 'old' }) + usage('2026-11-08T15:01:00Z', 20, 20));
  assert.deepEqual(scan(dir), { 'codex-old': 20 });
  const replacement = path.join(logs, 'replacement');
  fs.writeFileSync(replacement, line('2026-11-08T15:00:00Z', 'session_meta', { id: 'new' }) + usage('2026-11-08T15:01:00Z', 30, 30));
  fs.renameSync(replacement, file);
  assert.deepEqual(scan(dir), { 'codex-new': 30 });
});

test('inherited parent snapshots do not add child tokens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const legacy = usage('2026-11-08T15:01:00Z', 50, 50);
  const modern = line('2026-11-08T15:02:00Z', 'token_usage_record', { session_id: 'parent', response_id: 'p', usage: { output_tokens: 20 }, thread_token_usage: { output_tokens: 70 } });
  fs.writeFileSync(path.join(logs, 'parent.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { id: 'parent' }) + legacy + modern);
  fs.writeFileSync(path.join(logs, 'child.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { id: 'child', parent_thread_id: 'parent' }) + legacy + modern + line('2026-11-08T15:03:00Z', 'token_usage_record', { session_id: 'child', response_id: 'c', usage: { output_tokens: 10 }, thread_token_usage: { output_tokens: 10 } }));
  assert.deepEqual(scan(dir), { 'codex-parent': 70, 'codex-child': 10 });
});

test('legacy snapshots after modern records add uncovered output', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'one.jsonl'), line('2026-11-08T14:00:00Z', 'session_meta', { id: 'abc' }) + usage('2026-11-08T14:30:00Z', 100, 100) + line('2026-11-08T15:01:00Z', 'token_usage_record', { session_id: 'abc', response_id: 'r', usage: { output_tokens: 20 }, thread_token_usage: { output_tokens: 120 } }) + usage('2026-11-08T15:02:00Z', 150, 30));
  assert.deepEqual(scan(dir), { 'codex-abc': 50 });
});

test('token records refresh activity while a turn is working', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'one.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { id: 'abc' }) + line('2026-11-08T15:01:00Z', 'event_msg', { type: 'task_started', turn_id: 'turn' }) + line('2026-11-08T15:15:00Z', 'token_usage_record', { session_id: 'abc', response_id: 'r', usage: { output_tokens: 20 }, thread_token_usage: { output_tokens: 20 } }));
  scan(dir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state/sessions/codex-abc.json')));
  assert.equal(state.updatedAt, '2026-11-08T15:15:00Z');
});

test('missing cumulative response avoids counting mirrored legacy twice', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'one.jsonl'), line('2026-11-08T15:00:00Z', 'session_meta', { id: 'abc' }) + line('2026-11-08T15:01:00Z', 'token_usage_record', { session_id: 'abc', response_id: 'r', usage: { output_tokens: 20 } }) + usage('2026-11-08T15:02:00Z', 20, 20));
  assert.deepEqual(scan(dir), { 'codex-abc': 20 });
});

test('child lifecycle without inherited history boundary remains visible', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const file = path.join(logs, 'child.jsonl');
  fs.writeFileSync(file, line('2026-11-08T15:00:00Z', 'session_meta', { id: 'child', parent_thread_id: 'parent' }) + line('2026-11-08T15:01:00Z', 'event_msg', { type: 'task_started', turn_id: 't' }));
  scan(dir);
  const stateFile = path.join(dir, 'state/sessions/codex-child.json');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).working, true);
  fs.appendFileSync(file, line('2026-11-08T15:02:00Z', 'event_msg', { type: 'task_complete', turn_id: 't' }));
  scan(dir);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).working, false);
});
