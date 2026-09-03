const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

// Desktop banners via kitty's OSC 99 notification protocol, with an audible
// fallback for everywhere else.
//
// This is deliberately the ONLY place claudemon touches an OS notification
// channel. The mascot's own state stays on the menu bar icon and the
// evolution cut-in overlay; banners exist purely to say "your turn" when
// the terminal isn't in front of you.
//
// Why the escape code is not just written to stdout:
// hook.js runs as a child of Claude Code with its stdout captured, so it
// has no controlling terminal - calling `kitten notify` directly fails with
// "open /dev/tty: device not configured". Instead we ask kitten for the raw
// escape sequence (--only-print-escape-code) and write it to a terminal
// device ourselves.
//
// Two delivery paths, because tmux eats escape sequences it doesn't know:
//   - inside tmux: resolve the pane's tty and wrap the payload in a DCS
//     passthrough envelope. Requires `allow-passthrough` on (or all); with it
//     off tmux swallows the sequence and nothing happens.
//   - outside tmux: write straight to /dev/tty.
//
// Delivery is best-effort but never silent by accident: writing the escape
// only proves the bytes left this process, so every condition that can be
// checked BEFORE the write is checked (kitty client, pane tty, tmux
// passthrough), and every failure after it falls through to the sound. The
// one case that stays undetectable from here is macOS having notification
// permission switched off for kitty - the terminal accepts the sequence and
// drops it, and nothing observable comes back. That one needs System
// Settings > Notifications, not a code change.
//
// OSC 99 is a kitty extension, so the terminal is checked FIRST. A session
// running under Terminal.app, Ghostty, iTerm2 or a bare tty would at best
// ignore the sequence and at worst print it as garbage, so those get the
// sound instead. Note the kitty binary being installed proves nothing about
// what terminal the session is actually running in - `kitten` stays on PATH
// after a reboot even if kitty is never launched.
//
// Everything here is best-effort. A hook that throws is a hook that breaks
// the user's session, so every failure path returns false silently.

// kitten is not always on PATH in the environment hooks inherit, so fall
// back to the app bundle's copy before giving up.
const KITTEN_CANDIDATES = [
  'kitten',
  '/Applications/kitty.app/Contents/MacOS/kitten',
  '/opt/homebrew/bin/kitten',
  '/usr/local/bin/kitten'
];

// Turns shorter than this are ones you were almost certainly watching
// happen, so a banner would be noise. Permission/idle waits ignore this
// entirely - those are always worth surfacing.
const DEFAULT_MIN_TURN_MS = 30000;

const FALLBACK_SOUND_NORMAL = '/System/Library/Sounds/Glass.aiff';
const FALLBACK_SOUND_CRITICAL = '/System/Library/Sounds/Sosumi.aiff';

// pane_title values that are just the running process or an unset default
// carry no session identity, so they're dropped rather than shown.
// 'claude code' is the default pane title before Claude Code sets a session topic.
const GENERIC_PANE_TITLES = new Set(['zsh', 'bash', 'sh', 'fish', 'node', 'tmux', 'claude code', '']);
const MAX_TITLE_LEN = 80;

function notificationsEnabled() {
  return process.env.CLAUDEMON_NOTIFY !== '0';
}

function minTurnMs() {
  const raw = process.env.CLAUDEMON_NOTIFY_MIN_TURN_MS;
  if (!raw) return DEFAULT_MIN_TURN_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_TURN_MS;
}

function findKitten() {
  for (const candidate of KITTEN_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return candidate;
    } catch (e) {
      // Not this one - try the next candidate.
    }
  }
  return null;
}

// One tmux round-trip for everything we need from it. Returns null outside
// tmux or when the server/pane is gone.
//
// client_termname is the TERM of the client currently attached, not the one
// the session was created under - so detaching a tmux session from kitty and
// reattaching it from Terminal.app correctly stops reporting kitty.
//
// allow-passthrough rides along as a format variable rather than a second
// `show-options` call. On a tmux too old to know the option the field comes
// back empty or as the literal format string, which resolveTarget reads as
// "not on" - the safe direction, since an unwanted sound beats silence.
function tmuxContext() {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return null;
  try {
    const out = execFileSync(
      'tmux',
      [
        'display-message', '-p', '-t', pane,
        '#{client_termname}\n#{pane_tty}\n#{pane_title}\n#{allow-passthrough}'
      ],
      { encoding: 'utf8', timeout: 2000 }
    );
    const [termname = '', tty = '', title = '', passthrough = ''] = out.split('\n');
    return {
      termname: termname.trim(),
      tty: tty.trim(),
      title: title.trim(),
      passthrough: passthrough.trim()
    };
  } catch (e) {
    return null;
  }
}

// Where the escape sequence has to be written, and whether it needs the tmux
// passthrough envelope. Returns null when this session can't render OSC 99.
function resolveTarget(tmux) {
  if (tmux) {
    if (!tmux.termname.includes('kitty') || !tmux.tty) return null;
    // The DCS envelope only survives when passthrough is enabled. With it off
    // tmux eats the sequence while the write still reports success, so the
    // banner path has to be ruled out HERE - otherwise notify() would claim a
    // delivery that never happened and skip the sound. ('all' is the variant
    // that also passes through for panes in the alternate screen.)
    if (tmux.passthrough !== 'on' && tmux.passthrough !== 'all') return null;
    return { tty: tmux.tty, wrap: true };
  }
  const isKitty = process.env.TERM === 'xterm-kitty' || !!process.env.KITTY_WINDOW_ID;
  if (!isKitty) return null;
  return { tty: '/dev/tty', wrap: false };
}

// tmux only forwards escape sequences it doesn't understand when they
// arrive inside a DCS passthrough envelope, and every ESC in the payload
// has to be doubled so tmux hands the original through unchanged.
function wrapForTmux(payload) {
  const doubled = Buffer.from(
    payload.toString('binary').replace(/\x1b/g, '\x1b\x1b'),
    'binary'
  );
  return Buffer.concat([Buffer.from('\x1bPtmux;'), doubled, Buffer.from('\x1b\\')]);
}

// Claude Code writes the session's topic into the pane title, which is the
// only thing that distinguishes two sessions running in the same worktree.
// The leading status glyph it prepends ("◑ ") is stripped - it tracks live
// state and would just be stale by the time a banner is read.
function sessionTitle(tmux) {
  if (!tmux || !tmux.title) return null;
  const stripped = tmux.title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!stripped || stripped.length > MAX_TITLE_LEN) return null;
  if (GENERIC_PANE_TITLES.has(stripped.toLowerCase())) return null;
  return stripped;
}

// Detached so a hook never waits on audio playback.
function playSound(soundPath) {
  try {
    if (!fs.existsSync(soundPath)) return false;
    const child = spawn('/usr/bin/afplay', [soundPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

// Writes the OSC 99 payload to the resolved terminal. Every failure returns
// false rather than throwing, so the caller can always fall back to sound:
// a missing kitten binary, kitten refusing to emit an escape, and a tty that
// rejects the write are all "no banner", not "no notification".
function deliverBanner(target, { title, body, urgency }) {
  const kitten = findKitten();
  if (!kitten) return false;

  const args = ['notify', '--only-print-escape-code', '--app-name', 'claudemon'];
  if (urgency) args.push('--urgency', urgency);
  args.push(title, body);

  try {
    const escape = execFileSync(kitten, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    if (!escape || !escape.length) return false;
    fs.writeFileSync(target.tty, target.wrap ? wrapForTmux(escape) : escape);
    return true;
  } catch (e) {
    return false;
  }
}

// Returns 'banner' when a banner reached a kitty terminal, 'sound' when it
// fell back to audio, or false when nothing was delivered.
//
// The fallback is unconditional on purpose. Earlier versions returned false
// from the middle of the banner path, so a session that had the right
// terminal but a broken delivery got no banner AND no sound - the failure
// mode that is worst for the user is also the quietest, so it went unnoticed.
function notify({ title, body, urgency }) {
  if (!notificationsEnabled()) return false;

  const target = resolveTarget(tmuxContext());
  if (target && deliverBanner(target, { title, body, urgency })) return 'banner';

  const sound = urgency === 'critical' ? FALLBACK_SOUND_CRITICAL : FALLBACK_SOUND_NORMAL;
  return playSound(sound) ? 'sound' : false;
}

// Title identifies WHICH session, body says WHY it fired - nothing else.
// Duration and elapsed time were dropped deliberately: a banner is read in
// a glance, and neither changes what the user does next.
//
// The project name is only a fallback title, for sessions with no topic set
// (outside tmux, or before Claude Code has titled the pane).
function compose(subject, projectName) {
  return {
    title: sessionTitle(tmuxContext()) || projectName || 'claudemon',
    body: subject
  };
}

// A turn ended. Only worth a banner if it ran long enough that the user
// plausibly walked away. startedAt is an ISO string or null.
function notifyTurnEnd(startedAt, now, projectName) {
  if (!startedAt) return false;
  const elapsed = now.getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < minTurnMs()) return false;

  return notify({ ...compose('턴 종료', projectName), urgency: 'normal' });
}

// Claude is blocked on the user: a permission prompt or an idle-input
// nudge. Always banner-worthy, and 'critical' so macOS keeps it on screen
// until dismissed rather than letting it slide past unseen.
function notifyAwaitingUser(projectName) {
  return notify({ ...compose('입력 대기', projectName), urgency: 'critical' });
}

// A sub-agent finished. Only fired when the turn has already ended, so
// this signals work the user delegated is now complete.
function notifySubagentDone(projectName) {
  return notify({ ...compose('작업 완료', projectName), urgency: 'normal' });
}

module.exports = {
  notify,
  deliverBanner,
  notifyTurnEnd,
  notifyAwaitingUser,
  notifySubagentDone,
  tmuxContext,
  resolveTarget,
  sessionTitle,
  wrapForTmux,
  compose,
  minTurnMs,
  notificationsEnabled
};
