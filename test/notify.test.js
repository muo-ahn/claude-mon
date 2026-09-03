// Run: node --test test/
//
// Regression tests for notification title extraction. These exist because
// Claude Code's default pane title "Claude Code" was incorrectly treated as
// a session identifier, making banners from multiple concurrent sessions
// indistinguishable.
//
// compose() is not tested here - it calls tmuxContext() internally, which
// queries the actual tmux server, making tests environment-dependent. Testing
// it would require either stubbing (fragile) or running tmux in CI (overkill).
// sessionTitle() is the core logic and is a pure function, so we test that.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/notify.js resolves the queue and heartbeat paths from CLAUDEMON_DIR at
// require time, so the override has to be in place BEFORE the require below.
// Everything the app-path tests touch then lives under a throwaway directory
// instead of the real ~/.claude/claudemon.
const TEST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemon-notify-test-'));
process.env.CLAUDEMON_DIR = TEST_STATE_DIR;

const {
  sessionTitle,
  resolveTarget,
  claudemonReady,
  deliverViaApp,
  NOTIFY_QUEUE_DIR,
  HEARTBEAT_FILE
} = require('../lib/notify.js');

function writeHeartbeat(fields) {
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(fields));
}

test('sessionTitle strips leading glyphs from valid titles', () => {
  assert.strictEqual(
    sessionTitle({ title: '◑ Kitty 알림 구현 방식 검토' }),
    'Kitty 알림 구현 방식 검토'
  );
  assert.strictEqual(
    sessionTitle({ title: '✳ Fix banner mirroring bug' }),
    'Fix banner mirroring bug'
  );
});

test('sessionTitle rejects "Claude Code" regardless of glyph or case', () => {
  assert.strictEqual(sessionTitle({ title: '✳ Claude Code' }), null);
  assert.strictEqual(sessionTitle({ title: 'Claude Code' }), null);
  assert.strictEqual(sessionTitle({ title: 'claude code' }), null);
  assert.strictEqual(sessionTitle({ title: 'CLAUDE CODE' }), null);
  assert.strictEqual(sessionTitle({ title: '◑ claude code' }), null);
});

test('sessionTitle rejects empty or missing titles', () => {
  assert.strictEqual(sessionTitle({ title: '' }), null);
  assert.strictEqual(sessionTitle({ title: '   ' }), null);
  assert.strictEqual(sessionTitle({ title: null }), null);
  assert.strictEqual(sessionTitle({ title: undefined }), null);
  assert.strictEqual(sessionTitle({}), null);
  assert.strictEqual(sessionTitle(null), null);
  assert.strictEqual(sessionTitle(undefined), null);
});

test('sessionTitle rejects generic process names', () => {
  assert.strictEqual(sessionTitle({ title: 'zsh' }), null);
  assert.strictEqual(sessionTitle({ title: 'node' }), null);
  assert.strictEqual(sessionTitle({ title: 'bash' }), null);
  assert.strictEqual(sessionTitle({ title: 'fish' }), null);
  assert.strictEqual(sessionTitle({ title: 'tmux' }), null);
  // Case-insensitive
  assert.strictEqual(sessionTitle({ title: 'ZSH' }), null);
  assert.strictEqual(sessionTitle({ title: 'Node' }), null);
});

test('sessionTitle rejects titles over 80 characters', () => {
  const long = 'a'.repeat(81);
  assert.strictEqual(sessionTitle({ title: long }), null);
  const exactly80 = 'a'.repeat(80);
  assert.strictEqual(sessionTitle({ title: exactly80 }), exactly80);
});

test('sessionTitle accepts valid session titles', () => {
  assert.strictEqual(
    sessionTitle({ title: 'Fix tmux Ctrl+b' }),
    'Fix tmux Ctrl+b'
  );
  assert.strictEqual(
    sessionTitle({ title: '한글 세션 제목' }),
    '한글 세션 제목'
  );
  assert.strictEqual(
    sessionTitle({ title: 'Add notify tests' }),
    'Add notify tests'
  );
});

// resolveTarget decides whether a banner is even possible. It used to say yes
// inside tmux regardless of allow-passthrough, so tmux silently ate the escape
// while notify() reported success and skipped the sound - a session with the
// right terminal got no banner and no sound at all. The tmux branch is pure,
// so the gate is tested directly.

test('resolveTarget allows the banner path when passthrough is on', () => {
  assert.deepStrictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001', passthrough: 'on' }),
    { tty: '/dev/ttys001', wrap: true }
  );
});

test('resolveTarget accepts passthrough "all" as well as "on"', () => {
  assert.deepStrictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001', passthrough: 'all' }),
    { tty: '/dev/ttys001', wrap: true }
  );
});

test('resolveTarget refuses the banner path when tmux would swallow the escape', () => {
  // off: the reported failure - tmux drops the DCS envelope, write still succeeds.
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001', passthrough: 'off' }),
    null
  );
  // empty / literal format string: tmux too old to know the option. Treated as
  // "not on" so the caller falls back to sound rather than going silent.
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001', passthrough: '' }),
    null
  );
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001', passthrough: '#{allow-passthrough}' }),
    null
  );
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '/dev/ttys001' }),
    null
  );
});

test('resolveTarget still rejects non-kitty clients and missing ttys', () => {
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-256color', tty: '/dev/ttys001', passthrough: 'on' }),
    null
  );
  assert.strictEqual(
    resolveTarget({ termname: 'xterm-kitty', tty: '', passthrough: 'on' }),
    null
  );
});

test('resolveTarget outside tmux keys off the kitty environment', () => {
  const saved = { TERM: process.env.TERM, KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID };
  try {
    process.env.TERM = 'xterm-kitty';
    delete process.env.KITTY_WINDOW_ID;
    assert.deepStrictEqual(resolveTarget(null), { tty: '/dev/tty', wrap: false });

    process.env.TERM = 'xterm-256color';
    process.env.KITTY_WINDOW_ID = '1';
    assert.deepStrictEqual(resolveTarget(null), { tty: '/dev/tty', wrap: false });

    delete process.env.KITTY_WINDOW_ID;
    assert.strictEqual(resolveTarget(null), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// The app path is preferred over the escape code, so claudemonReady is what
// decides whether a notification carries Claudemon's identity or kitty's. It
// has to be conservative in both directions: a stale heartbeat means the app
// is gone and the caller must fall through, and a live app with permission
// denied would accept the queue file and silently drop it - the exact silent
// failure this whole path exists to remove.

test('claudemonReady is false with no heartbeat at all', () => {
  fs.rmSync(HEARTBEAT_FILE, { force: true });
  assert.strictEqual(claudemonReady(), false);
});

test('claudemonReady is true for a fresh, authorized heartbeat', () => {
  const now = Date.now();
  writeHeartbeat({ pid: 123, at: now / 1000, authorized: true, auth: '허용됨' });
  assert.strictEqual(claudemonReady(now), true);
});

test('claudemonReady is false when the app is running but not authorized', () => {
  const now = Date.now();
  writeHeartbeat({ pid: 123, at: now / 1000, authorized: false, auth: '거부됨' });
  assert.strictEqual(claudemonReady(now), false);
});

test('claudemonReady is false once the heartbeat goes stale', () => {
  const now = Date.now();
  // The app rewrites this every 2s; 10s is the cutoff.
  writeHeartbeat({ pid: 123, at: (now - 9000) / 1000, authorized: true });
  assert.strictEqual(claudemonReady(now), true);
  writeHeartbeat({ pid: 123, at: (now - 11000) / 1000, authorized: true });
  assert.strictEqual(claudemonReady(now), false);
});

test('claudemonReady is false for a malformed or fieldless heartbeat', () => {
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, 'not json at all');
  assert.strictEqual(claudemonReady(), false);
  writeHeartbeat({ authorized: true });
  assert.strictEqual(claudemonReady(), false);
  writeHeartbeat({ authorized: true, at: 'nonsense' });
  assert.strictEqual(claudemonReady(), false);
});

test('deliverViaApp queues a parseable .json and leaves no .tmp behind', () => {
  fs.rmSync(NOTIFY_QUEUE_DIR, { recursive: true, force: true });
  const payload = { title: '세션', body: '입력 대기', urgency: 'critical', threadId: 'claude-mon' };
  assert.strictEqual(deliverViaApp(payload), true);

  const names = fs.readdirSync(NOTIFY_QUEUE_DIR);
  assert.strictEqual(names.length, 1);
  // The app only picks up *.json; a leftover .tmp would mean a half-written
  // file could be read mid-write.
  assert.ok(names[0].endsWith('.json'), `expected .json, got ${names[0]}`);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(NOTIFY_QUEUE_DIR, names[0]), 'utf8')),
    payload
  );
});

test('deliverViaApp names queue files so a sort gives arrival order', () => {
  fs.rmSync(NOTIFY_QUEUE_DIR, { recursive: true, force: true });
  for (let i = 0; i < 5; i++) deliverViaApp({ title: 't', body: String(i) });

  const names = fs.readdirSync(NOTIFY_QUEUE_DIR).sort();
  const bodies = names.map(
    (n) => JSON.parse(fs.readFileSync(path.join(NOTIFY_QUEUE_DIR, n), 'utf8')).body
  );
  assert.deepStrictEqual(bodies, ['0', '1', '2', '3', '4']);
});

test('cleanup: the test state dir is removed', () => {
  fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(TEST_STATE_DIR), false);
});
