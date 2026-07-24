const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyEvolution, TREE } = require('./evolve');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultClaudemonDir() {
  return process.env.CLAUDEMON_DIR || path.join(os.homedir(), '.claude', 'claudemon');
}

function defaultProjectsDir() {
  return process.env.CLAUDEMON_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

function defaultPacksDir() {
  return path.join(__dirname, '..', 'sprites', 'packs');
}

function cacheFilePath(claudemonDir) {
  return path.join(claudemonDir, 'token-scan-cache.json');
}

function dailyFilePath(claudemonDir) {
  return path.join(claudemonDir, 'daily.json');
}

// A pack is valid only if it ships a digitama-0.png (the contract every
// stage/frame file name is checked against by the menubar app). Sorted so
// the hash-based index in selectMon is stable regardless of directory
// listing order.
function listValidPacks(packsDir) {
  if (!fs.existsSync(packsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(packsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(packsDir, entry.name, 'digitama-0.png'))) {
      packs.push(entry.name);
    }
  }
  return packs.sort();
}

// Simple deterministic string hash (no Math.random - the daily mon pick
// must be idempotent for repeated runs on the same KST date).
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Picks today's mon pack: a rotation keyed off dateKST so it's the same
// all day (idempotent) but changes as the date rolls over. Falls back to
// "guilmon" when no valid pack is found on disk.
function selectMon(dateKST, packsDir) {
  const packs = listValidPacks(packsDir);
  if (packs.length === 0) return 'guilmon';
  return packs[hashString(dateKST) % packs.length];
}

// Reads daily.json and returns its parsed contents only if it already
// belongs to today's KST date - used to keep the chosen mon fixed for the
// rest of the day even if new packs appear on disk in the meantime.
function readTodaysDaily(claudemonDir, dateKST) {
  const file = dailyFilePath(claudemonDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.dateKST === dateKST ? parsed : null;
  } catch (e) {
    return null;
  }
}

// KST has no DST, so a fixed +9h offset is always correct.
function dateKSTString(date) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

// UTC instant of 00:00:00 KST for the given YYYY-MM-DD date string.
function startOfDayKSTUtcMs(dateKST) {
  return new Date(`${dateKST}T00:00:00+09:00`).getTime();
}

function loadCache(claudemonDir) {
  const file = cacheFilePath(claudemonDir);
  if (!fs.existsSync(file)) {
    return { dateKST: null, files: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { dateKST: parsed.dateKST || null, files: parsed.files || {} };
  } catch (e) {
    // Corrupt cache - start fresh rather than crash the 30s poll loop.
    return { dateKST: null, files: {} };
  }
}

function saveCache(claudemonDir, cache) {
  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(cacheFilePath(claudemonDir), JSON.stringify(cache, null, 2));
}

function listJsonlFiles(projectsDir) {
  const results = [];
  if (!fs.existsSync(projectsDir)) return results;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        results.push(path.join(dir, f));
      }
    }
  }
  return results;
}

// Reads only the newly-appended bytes of `file` (from `fromOffset` onward),
// sums output_tokens of assistant entries whose top-level timestamp falls
// in [dayStartMs, dayEndMs), and returns how far the offset advanced.
//
// Assistant lines can appear duplicated (same message.id repeated across
// several transcript lines) - dedupe by message.id, keeping the max
// output_tokens seen for that id so a partial/streamed snapshot never
// suppresses the final value.
function scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs) {
  const stat = fs.statSync(file);
  if (stat.size <= fromOffset) {
    return { increment: 0, newOffset: fromOffset };
  }

  const length = stat.size - fromOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, fromOffset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line landed yet - don't advance the offset past a
    // partially-written line.
    return { increment: 0, newOffset: fromOffset };
  }
  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1; // + the newline itself
  const lines = complete.split('\n');

  const maxByMessageId = new Map();
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue; // malformed line - skip defensively
    }
    const message = entry && entry.message;
    if (!message || message.role !== 'assistant') continue;
    const outputTokens = message.usage && message.usage.output_tokens;
    if (typeof outputTokens !== 'number') continue;
    const ts = entry.timestamp;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs < dayStartMs || tsMs >= dayEndMs) continue;

    const key = message.id || entry.uuid;
    const prev = maxByMessageId.get(key) || 0;
    if (outputTokens > prev) maxByMessageId.set(key, outputTokens);
  }

  let increment = 0;
  for (const v of maxByMessageId.values()) increment += v;

  return { increment, newOffset: fromOffset + consumedBytes };
}

// Scans every transcript under `projectsDir`, incrementally (via the
// on-disk cache under `claudemonDir`), and returns today's (KST) total
// output token count plus the evolution stage it maps to.
function computeDailyTokens(now = new Date(), options = {}) {
  const claudemonDir = options.claudemonDir || defaultClaudemonDir();
  const projectsDir = options.projectsDir || defaultProjectsDir();
  const packsDir = options.packsDir || defaultPacksDir();

  const dateKST = dateKSTString(now);
  const dayStartMs = startOfDayKSTUtcMs(dateKST);
  const dayEndMs = dayStartMs + DAY_MS;

  const cache = loadCache(claudemonDir);
  if (cache.dateKST !== dateKST) {
    // Rolled over to a new KST day (or first run ever): the daily total
    // resets to 0, but file offsets are kept so already-read bytes are
    // never re-parsed.
    for (const key of Object.keys(cache.files)) {
      cache.files[key].contribution = 0;
    }
    cache.dateKST = dateKST;
  }

  const files = listJsonlFiles(projectsDir);
  const seenFiles = new Set();

  for (const file of files) {
    seenFiles.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      continue; // race with deletion - ignore this run
    }
    const existing = cache.files[file];

    // A file untouched since before today's KST start can't contain any
    // of today's entries. Skip the read entirely; just remember the
    // offset so we never rescan it (until it's modified again).
    if (stat.mtimeMs < dayStartMs) {
      const offset = existing ? Math.max(existing.offset, 0) : stat.size;
      cache.files[file] = {
        offset: Math.min(offset, stat.size),
        contribution: existing ? existing.contribution || 0 : 0,
        mtimeMs: stat.mtimeMs
      };
      continue;
    }

    const fromOffset = existing ? existing.offset : 0;
    try {
      const { increment, newOffset } = scanFileIncrement(file, fromOffset, dayStartMs, dayEndMs);
      cache.files[file] = {
        offset: newOffset,
        contribution: (existing ? existing.contribution || 0 : 0) + increment,
        mtimeMs: stat.mtimeMs
      };
    } catch (e) {
      // Unreadable this run (permissions, race) - keep prior cache entry.
      cache.files[file] = existing || { offset: 0, contribution: 0, mtimeMs: stat.mtimeMs };
    }
  }

  // Prune files that no longer exist on disk.
  for (const key of Object.keys(cache.files)) {
    if (!seenFiles.has(key)) delete cache.files[key];
  }

  const outputTokens = Object.values(cache.files).reduce((sum, f) => sum + (f.contribution || 0), 0);

  saveCache(claudemonDir, cache);

  const stageState = { stageId: TREE.stages[0].id, dailyOutputTokens: outputTokens };
  applyEvolution(stageState, {});

  const todaysDaily = readTodaysDaily(claudemonDir, dateKST);
  const mon = (todaysDaily && todaysDaily.mon) || selectMon(dateKST, packsDir);

  const result = {
    dateKST,
    outputTokens,
    stageId: stageState.stageId,
    mon,
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(claudemonDir, { recursive: true });
  fs.writeFileSync(dailyFilePath(claudemonDir), JSON.stringify(result, null, 2));

  return result;
}

module.exports = {
  computeDailyTokens,
  defaultClaudemonDir,
  defaultProjectsDir,
  defaultPacksDir,
  cacheFilePath,
  dailyFilePath,
  dateKSTString,
  startOfDayKSTUtcMs,
  listJsonlFiles,
  scanFileIncrement,
  listValidPacks,
  hashString,
  selectMon
};
