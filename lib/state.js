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
  // Set when a Notification hook fires (permission wait / idle input) and
  // cleared once the user resumes activity. hook.js only records facts here;
  // deriving waiting_user/stalled/dead from this is the menubar's job.
  awaitingUserSince: null,
  // Set on session-end so a consumer can tell the session finished cleanly
  // rather than just going quiet.
  endedAt: null,
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

function sessionFile(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
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
  writeFileAtomic(sessionFile(state.sessionId), JSON.stringify(state, null, 2));
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
  const maxAgeMs = maxAgeDays * 86400000;
  for (const file of files) {
    if (excludeSessionId && file === `${excludeSessionId}.json`) continue;
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
  load,
  save,
  loadSession,
  saveSession,
  loadGlobal,
  saveGlobal,
  pruneSessions,
  STATE_FILE,
  SESSIONS_DIR,
  GLOBAL_FILE,
  DEFAULT_STATE,
  DEFAULT_GLOBAL
};
