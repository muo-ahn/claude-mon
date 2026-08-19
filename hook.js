#!/usr/bin/env node
// Usage: node hook.js <event>
// event: tool-success | tool-failure | pr-merged | turn-start | turn-end | session-start |
//        notification | session-end | subagent-end | notify-awaiting | notify-agent-done
// Intended to be wired into .claude/settings.json hooks, e.g.:
//   "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js tool-success" }] }]
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js turn-start" }] }]
//   "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js turn-end" }] }]
//   "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js subagent-end" }] }]
//   "Notification" (permission_prompt|agent_needs_input): [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js notify-awaiting" }] }]
//   "Notification" (agent_completed): [{ "hooks": [{ "type": "command", "command": "node /path/to/hook.js notify-agent-done" }] }]
//
// Claude Code hooks pass a JSON payload on stdin (session_id, cwd, tool_name, ...).
// When session_id is present, state is tracked per-session under
// ~/.claude/claudemon/sessions/<session_id>.json so multiple concurrent
// sessions each grow their own mascot. Without a session_id (e.g. manual
// invocation), falls back to the single global state file.
const fs = require('fs');

const path = require('path');

const { load, save, loadSession, saveSession, loadGlobal, saveGlobal, pruneSessions } = require('./lib/state');
const { applyEvolution, applyRegression } = require('./lib/evolve');
const { notifyTurnEnd, notifyAwaitingUser, notifySubagentDone } = require('./lib/notify');

function todayMarker(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Banner bodies name the project so a banner from a background session is
// identifiable without switching to it. cwd is absent on manual invocation.
function projectName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  return path.basename(cwd) || null;
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

// Detects sub-agent context using the same fields delegation_guard.py checks.
// Banners from sub-agents are noise - only host notifications matter.
function isSubagentContext(payload) {
  return !!(payload.agent_id || payload.agent_type || payload.subagent_type || payload.parent_session_id);
}

// Checks if a completion banner was fired within the last 5 seconds.
// Prevents duplicate banners when both subagent-end and agent_completed fire.
function shouldSuppressCompletionBanner(state, now) {
  if (!state.lastCompletionBannerAt) return false;
  const elapsed = now.getTime() - new Date(state.lastCompletionBannerAt).getTime();
  return Number.isFinite(elapsed) && elapsed < 5000;
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
      // Track whether the host launched a sub-agent this turn, so turn-end
      // can suppress its banner (the work continues in background).
      if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
        state.agentLaunchedThisTurn = true;
      }
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
      // Stamped so turn-end can tell a long-running turn (worth a banner)
      // from one the user sat and watched.
      state.turnStartedAt = now.toISOString();
      state.agentLaunchedThisTurn = false;
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
      // Suppress the banner if a sub-agent was launched - the actual work
      // hasn't finished yet. State cleanup still happens.
      if (!state.agentLaunchedThisTurn && !isSubagentContext(payload)) {
        notifyTurnEnd(state.turnStartedAt, now, projectName(payload.cwd));
      }
      state.turnStartedAt = null;
      break;
    case 'subagent-end':
      // A sub-agent finished. Only fire the banner when the turn has already
      // ended (working === false), signaling delegated work is complete.
      // Don't fire if the turn is still active - the user is watching.
      if (!state.working && !shouldSuppressCompletionBanner(state, now)) {
        notifySubagentDone(projectName(payload.cwd));
        state.lastCompletionBannerAt = now.toISOString();
      }
      // Reset the flag so subsequent turns can fire turn-end banners normally.
      state.agentLaunchedThisTurn = false;
      break;
    case 'session-start':
      state.working = false;
      state.awaitingUserSince = null;
      state.endedAt = null;
      break;
    case 'notification':
      // Permission wait or idle-input notification. Records the timestamp only
      // (banner firing is now handled by notify-awaiting).
      if (!state.awaitingUserSince) state.awaitingUserSince = now.toISOString();
      break;
    case 'notify-awaiting':
      // Banner-only path for permission_prompt|agent_needs_input notifications.
      // State recording stays in the notification case above.
      if (!isSubagentContext(payload)) {
        notifyAwaitingUser(projectName(payload.cwd));
      }
      break;
    case 'notify-agent-done':
      // Banner-only path for agent_completed notifications.
      // Suppressed if a completion banner already fired in the last 5s.
      if (!isSubagentContext(payload) && !shouldSuppressCompletionBanner(state, now)) {
        notifySubagentDone(projectName(payload.cwd));
        state.lastCompletionBannerAt = now.toISOString();
      }
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
