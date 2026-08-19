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
const { sessionTitle } = require('../lib/notify.js');

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
