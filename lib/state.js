const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.CLAUDEMON_DIR || path.join(os.homedir(), '.claude', 'claudemon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const GLOBAL_FILE = path.join(STATE_DIR, 'global.json');

const DEFAULT_STATE = {
  stageId: 'digitama',
  toolSuccessCount: 0,
  toolFailureCount: 0,
  lastActiveAt: null,
  firstSeenAt: new Date().toISOString(),
  consecutiveDaysActive: 0,
  lastDayMarker: null,
  working: false,
  lastTurnEndAt: null,
  // Set on turn-start, cleared on turn-end. Only consumer is the turn-end
  // banner, which uses it to skip turns too short to be worth interrupting
  // the user over.
  turnStartedAt: null,
  // Set when a Notification hook fires (permission wait / idle input) and
  // cleared once the user resumes activity. hook.js only records facts here;
  // deriving waiting_user/stalled/dead from this is the menubar's job.
  awaitingUserSince: null,
  // Set on session-end so a consumer can tell the session finished cleanly
  // rather than just going quiet.
  endedAt: null,
  // Set on tool-success when the tool is Agent or Task. Suppresses turn-end
  // banner noise (the work continues in background). Cleared on subagent-end
  // so subsequent turns can fire normally.
  agentLaunchedThisTurn: false,
  // Timestamp of the last completion banner (ISO string). Used to suppress
  // duplicate banners when both subagent-end and agent_completed fire.
  lastCompletionBannerAt: null,
  milestones: {
    prMergedCount: 0
  }
};

const DEFAULT_GLOBAL = {
  toolSuccessCount: 0,
  toolFailureCount: 0,
  updatedAt: null
};

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const SESSION_ID_MAX_LEN = 200;

// hook.js reads session_id straight off the JSON payload on stdin, so it's
// untrusted input - it must never reach path.join/fs calls unsanitized
// (a session_id like "../../../../tmp/x" would otherwise write outside
// SESSIONS_DIR). path.basename() strips any directory components first
// (so traversal segments collapse away and the result always stays inside
// SESSIONS_DIR); the charset/length checks then reject the degenerate
// leftovers ("", ".", "..") that would otherwise resolve to SESSIONS_DIR
// itself or its parent. Returns null when there's nothing safe to use.
function sanitizeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const base = path.basename(sessionId);
  if (!base || base === '.' || base === '..') return null;
  if (base.length > SESSION_ID_MAX_LEN) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return base;
}

// Returns null when sessionId can't be safely turned into a filename -
// callers fall back to the global state file rather than writing anywhere
// unsafe or crashing the hook.
function sessionFile(sessionId) {
  const safe = sanitizeSessionId(sessionId);
  return safe ? path.join(SESSIONS_DIR, `${safe}.json`) : null;
}

// Write via a temp file + rename so the Swift menubar (which polls these
// files every ~2s) never observes a partially-written (torn) read.
function writeFileAtomic(filePath, data) {
  const tmpFile = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, data);
  fs.renameSync(tmpFile, filePath);
}

function load() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    save(DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (e) {
    // Corrupt state file - don't crash the statusline, just reset.
    return { ...DEFAULT_STATE };
  }
}

function save(state) {
  ensureDir();
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadSession(sessionId) {
  ensureSessionsDir();
  const file = sessionFile(sessionId);
  if (!file) {
    // Unsafe/invalid sessionId - track this invocation via the global
    // state file instead of skipping tracking or touching the filesystem
    // with an unsanitized path.
    return { ...load(), sessionId };
  }
  if (!fs.existsSync(file)) {
    const initial = { ...DEFAULT_STATE, sessionId };
    saveSession(initial);
    return { ...initial };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw), sessionId };
  } catch (e) {
    // Corrupt session file - don't crash, just reset this session.
    return { ...DEFAULT_STATE, sessionId };
  }
}

function saveSession(state) {
  if (!state.sessionId) {
    throw new Error('saveSession requires state.sessionId');
  }
  ensureSessionsDir();
  state.updatedAt = new Date().toISOString();
  const file = sessionFile(state.sessionId);
  if (!file) {
    // Same invalid-sessionId fallback as loadSession: persist to the
    // global state file rather than refusing to save or crashing the hook.
    save(state);
    return;
  }
  writeFileAtomic(file, JSON.stringify(state, null, 2));
}

// Session files accumulate under sessions/ forever otherwise. Deletes
// session files untouched for maxAgeDays, skipping excludeSessionId (the
// caller's own session) so an in-progress session is never removed. Only
// called from the session-end event, not the hot per-tool-call path.
function pruneSessions(now, maxAgeDays = 7, excludeSessionId) {
  ensureSessionsDir();
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch (e) {
    return;
  }
  // Normalize the same way sessionFile() does, so a raw excludeSessionId
  // that differs from the sanitized name actually used on disk still
  // protects the right file.
  const safeExclude = sanitizeSessionId(excludeSessionId);
  const maxAgeMs = maxAgeDays * 86400000;
  for (const file of files) {
    if (safeExclude && file === `${safeExclude}.json`) continue;
    const filePath = path.join(SESSIONS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtime > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      // Ignore races/permission errors - GC must never crash the hook.
    }
  }
}

// Global counters accumulate across every session (unlike the per-session
// counters in state.json/sessions/*.json), used for the later evolution
// stages (perfect/ultimate) so they reflect total usage of the tool rather
// than a single session's activity.
function loadGlobal() {
  ensureDir();
  if (!fs.existsSync(GLOBAL_FILE)) {
    saveGlobal(DEFAULT_GLOBAL);
    return { ...DEFAULT_GLOBAL };
  }
  try {
    const raw = fs.readFileSync(GLOBAL_FILE, 'utf8');
    return { ...DEFAULT_GLOBAL, ...JSON.parse(raw) };
  } catch (e) {
    // Corrupt global file - don't crash, just reset it.
    return { ...DEFAULT_GLOBAL };
  }
}

function saveGlobal(global) {
  ensureDir();
  global.updatedAt = new Date().toISOString();
  writeFileAtomic(GLOBAL_FILE, JSON.stringify(global, null, 2));
}

module.exports = {
  STATE_DIR,
  load,
  save,
  loadSession,
  saveSession,
  loadGlobal,
  saveGlobal,
  pruneSessions,
  sanitizeSessionId,
  STATE_FILE,
  SESSIONS_DIR,
  GLOBAL_FILE,
  DEFAULT_STATE,
  DEFAULT_GLOBAL
};
