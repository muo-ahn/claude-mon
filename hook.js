#!/usr/bin/env node
// Usage: node hook.js <event>
// event: tool-success | tool-failure | pr-merged | turn-start | turn-end | session-start |
//        notification | session-end
// Intended to be wired into .claude/settings.json hooks, e.g.:
//   "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js tool-success" }] }]
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js turn-start" }] }]
//   "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js turn-end" }] }]
//
// Claude Code hooks pass a JSON payload on stdin (session_id, cwd, tool_name, ...).
// When session_id is present, state is tracked per-session under
// ~/.claude/claudemon/sessions/<session_id>.json so multiple concurrent
// sessions each grow their own mascot. Without a session_id (e.g. manual
// invocation), falls back to the single global state file.
const fs = require('fs');

const { load, save, loadSession, saveSession, loadGlobal, saveGlobal, pruneSessions } = require('./lib/state');
const { applyEvolution, applyRegression } = require('./lib/evolve');

function todayMarker(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function readStdinPayload() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function main() {
  const event = process.argv[2];
  const now = new Date();
  const payload = readStdinPayload();
  const sessionId = payload.session_id;
  const state = sessionId ? loadSession(sessionId) : load();
  const global = loadGlobal();

  if (sessionId) {
    state.sessionId = sessionId;
    state.pid = process.ppid;
    if (payload.cwd) state.cwd = payload.cwd;
  }

  // Regression check happens first, based on time since last activity.
  applyRegression(state, now);

  switch (event) {
    case 'tool-success':
      state.toolSuccessCount += 1;
      global.toolSuccessCount += 1;
      state.working = true;
      state.awaitingUserSince = null; // work resumed
      break;
    case 'tool-failure':
      state.toolFailureCount += 1;
      global.toolFailureCount += 1;
      state.working = true;
      state.awaitingUserSince = null; // work resumed
      break;
    case 'pr-merged':
      state.milestones.prMergedCount = (state.milestones.prMergedCount || 0) + 1;
      break;
    case 'turn-start':
      state.working = true;
      state.awaitingUserSince = null; // user responded
      state.endedAt = null;
      break;
    case 'turn-end':
      state.working = false;
      state.lastTurnEndAt = now.toISOString();
      // Safe to clear here: Stop only fires once the turn actually ends,
      // and a turn is blocked (Stop withheld) while a permission prompt is
      // pending, so this never clobbers a live wait. Two cases:
      // - idle-60s wait: turn-end fires (no-op, nothing was pending) and
      //   Notification follows it, (re)setting awaitingUserSince as usual.
      // - permission denied mid-turn: the turn ends without ever reaching
      //   tool-success/tool-failure, so this is the only place that clears
      //   the stale "waiting" state left by the earlier Notification call.
      // endedAt is intentionally untouched: turn end != session end.
      state.awaitingUserSince = null;
      break;
    case 'session-start':
      state.working = false;
      state.awaitingUserSince = null;
      state.endedAt = null;
      break;
    case 'notification':
      // Permission wait or idle-input notification. Only set the timestamp
      // on the first notification so it reflects when waiting began, not
      // the most recent nudge.
      if (!state.awaitingUserSince) state.awaitingUserSince = now.toISOString();
      break;
    case 'session-end':
      state.endedAt = now.toISOString();
      break;
    default:
      // Unknown event: still touch activity timestamp, no counter change.
      break;
  }

  // Consecutive-day tracking: bump only once per new calendar day, reset
  // the streak if more than one day was skipped.
  const marker = todayMarker(now);
  if (state.lastDayMarker !== marker) {
    if (state.lastDayMarker) {
      const prev = new Date(state.lastDayMarker);
      const gapDays = Math.round((now - prev) / 86400000);
      state.consecutiveDaysActive = gapDays === 1 ? state.consecutiveDaysActive + 1 : 1;
    } else {
      state.consecutiveDaysActive = 1;
    }
    state.lastDayMarker = marker;
  }

  state.lastActiveAt = now.toISOString();

  const evolved = applyEvolution(state, global);
  if (sessionId) {
    saveSession(state);
  } else {
    save(state);
  }
  saveGlobal(global);

  // GC only on session-end, not the hot per-tool-call path, to avoid
  // extra readdir/stat I/O on every hook invocation.
  if (event === 'session-end') {
    pruneSessions(now, undefined, sessionId);
  }

  if (evolved) {
    // stdout here is only visible in hook debug logs, not the statusline itself.
    console.log(`[claudemon] evolved to: ${state.stageId}`);
  }
}

main();
