#!/usr/bin/env node
// Usage: node hook.js <event>
// event: tool-success | tool-failure | pr-merged | turn-start | turn-end | session-start
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

const { load, save, loadSession, saveSession, loadGlobal, saveGlobal } = require('./lib/state');
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
      break;
    case 'tool-failure':
      state.toolFailureCount += 1;
      global.toolFailureCount += 1;
      state.working = true;
      break;
    case 'pr-merged':
      state.milestones.prMergedCount = (state.milestones.prMergedCount || 0) + 1;
      break;
    case 'turn-start':
      state.working = true;
      break;
    case 'turn-end':
      state.working = false;
      state.lastTurnEndAt = now.toISOString();
      break;
    case 'session-start':
      state.working = false;
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

  if (evolved) {
    // stdout here is only visible in hook debug logs, not the statusline itself.
    console.log(`[claudemon] evolved to: ${state.stageId}`);
  }
}

main();
