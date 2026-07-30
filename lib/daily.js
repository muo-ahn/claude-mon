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

function defaultSharedDir() {
  return path.join(__dirname, '..', 'sprites', 'shared');
}

function cacheFilePath(claudemonDir) {
  return path.join(claudemonDir, 'token-scan-cache.json');
}

function dailyFilePath(claudemonDir) {
  return path.join(claudemonDir, 'daily.json');
}

// A directory under packsDir is a rotation candidate only if the menubar
// app could actually put it on screen:
//
//   - idle-0.png must exist. claudemon-menubar.swift refuses to switch to
//     a pack without one, so selecting such a "pack" silently leaves
//     yesterday's mon up instead of rotating.
//   - a Digi-Egg must be reachable: the pack's own digitama-0.png, or the
//     species-agnostic sprites/shared/digitama-0.png, mirroring the
//     menubar's sharedStages priority.
//
// Dot-directories are excluded outright -- sprites/packs/ is a plain
// directory and unrelated tooling drops state there (.omc/state did).
// Admitting a non-pack costs more than one wasted slot: it shifts the
// index of every name sorting after it, which is exactly the failure
// selectMon's hash finalizer also guards against.
//
// Sorted so the hash-based index in selectMon is stable regardless of
// directory listing order.
function listValidPacks(packsDir, sharedDir) {
  if (!fs.existsSync(packsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(packsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const hasSharedDigitama = fs.existsSync(path.join(sharedDir || defaultSharedDir(), 'digitama-0.png'));
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(packsDir, entry.name);
    if (!fs.existsSync(path.join(dir, 'idle-0.png'))) continue;
    if (!hasSharedDigitama && !fs.existsSync(path.join(dir, 'digitama-0.png'))) continue;
    packs.push(entry.name);
  }
  return packs.sort();
}

// The tree's last stage - what a mon has to be able to become to be worth
// putting into the rotation at all. Read off the tree rather than spelled
// out here, so adding a stage moves the bar with it.
function topStageId() {
  return TREE.stages[TREE.stages.length - 1].id;
}

// True when `<pack>/pack.json` names `stageId` in its evolution line.
// Absent pack.json, absent stageNames, or a blank name all read as "this
// line doesn't reach that stage".
function packDeclaresStage(packsDir, pack, stageId) {
  try {
    const raw = fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8');
    const names = JSON.parse(raw).stageNames;
    return Boolean(names && typeof names[stageId] === 'string' && names[stageId].trim());
  } catch (e) {
    return false; // missing or malformed pack.json - not a candidate
  }
}

// The daily rotation pool: valid packs whose evolution line actually
// reaches the top stage. A pack that tops out early would spend the
// heaviest days of the month stuck one stage below the ceiling, so it is
// held out of the rotation rather than shown with a stage it can't
// evolve into. Nothing else changes for it - it stays a valid pack, so an
// explicit selection or the guilmon fallback still renders it.
function listRotationPacks(packsDir, sharedDir) {
  const top = topStageId();
  return listValidPacks(packsDir, sharedDir).filter((pack) =>
    packDeclaresStage(packsDir, pack, top)
  );
}

// Deterministic string hash (no Math.random - the daily mon pick must be
// idempotent for repeated runs on the same KST date).
//
// The rolling h*31+c accumulation alone is not enough for date keys. Two
// dates one day apart differ by +1 in a single character, so their hashes
// differ by exactly +1 and `hash % packs.length` degenerates into walking
// the alphabetical pack list one step per day. That made the rotation
// brittle in a non-obvious way: introducing a candidate that sorts ahead
// of the rest shifts every index down by one, exactly cancelling the
// daily +1 and pinning the same mon across consecutive days (a stray
// sprites/packs/.omc did this, freezing two days on gabumon).
//
// The murmur3 fmix32 finalizer avalanches neighbouring inputs apart, so
// consecutive dates land on unrelated indices and the pick no longer
// depends on where a new pack happens to sort.
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

// Picks today's mon pack: a rotation keyed off dateKST so it's the same
// all day (idempotent) but changes as the date rolls over. Falls back to
// "guilmon" when no valid pack is found on disk.
//
// `avoidMon` is the pack the user last actually saw (see prevMon in
// computeDailyTokens). A well-mixed hash still lands on the same pack two
// days running about 1/N of the time, and from the outside a coincidental
// repeat is indistinguishable from the rotation being broken -- so when
// the draw collides we step to the next pack instead. Stepping (rather
// than re-hashing) keeps the pick deterministic and cheap, and stays
// idempotent because avoidMon is itself persisted rather than recomputed.
function selectMon(dateKST, packsDir, sharedDir, avoidMon) {
  const packs = listRotationPacks(packsDir, sharedDir);
  if (packs.length === 0) return 'guilmon';
  let index = hashString(dateKST) % packs.length;
  // With a single candidate there is nothing to step to; repeating it is
  // the only option.
  if (packs.length > 1 && packs[index] === avoidMon) {
    index = (index + 1) % packs.length;
  }
  return packs[index];
}

// Reads daily.json and returns its parsed contents, whatever date it
// carries, or null if absent/corrupt. The record left behind by the
// previous run serves two purposes: if its dateKST is today's it pins the
// already-chosen mon for the rest of the day (so a pack appearing on disk
// mid-day can't swap the sprite out underfoot), and if it is older its
// `mon` is the last pack the user actually saw -- what the repeat guard
// in selectMon steers away from.
function readDaily(claudemonDir) {
  const file = dailyFilePath(claudemonDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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

// Every .jsonl at any depth inside a project directory. A project holds
// `<session>.jsonl` for the main conversation plus
// `<session>/subagents/agent-<id>.jsonl` for each subagent it spawned;
// a subagent's turns appear only in its own nested file, so a one-level
// listing silently drops every token any subagent produced.
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
    collectJsonlFiles(path.join(projectsDir, entry.name), results);
  }
  return results;
}

// Recursive half of listJsonlFiles. isDirectory() is false for symlinks,
// so a link pointing back up the tree can't send this into a loop.
function collectJsonlFiles(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable subtree - skip it, not the whole scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
}

// Identifies a transcript independently of which project directory it
// was filed under, because one session can be recorded under two of them
// at once: the same repo reached through its real path and through a
// worktree or symlink path produces two `-Users-...` directories, and
// Claude Code writes the session into both. The copies repeat each
// other's messages verbatim, so counting per file counts them twice.
//
// Everything below the project directory is stable across those
// spellings, so it is what names one transcript. Returns null for a path
// that isn't inside a project directory (nothing to group it by).
function transcriptKey(projectsDir, file) {
  const rel = path.relative(projectsDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const withinProject = parts.slice(1);
  return {
    key: withinProject.join('/'),
    // `<session>.jsonl` for a main transcript, `<session>` for the
    // directory holding its subagent transcripts - either way the first
    // segment names the session whose work these tokens are.
    sessionId: withinProject[0].replace(/\.jsonl$/, '')
  };
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
  const sharedDir = options.sharedDir || defaultSharedDir();

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

  // The cache is keyed by file path, so a session recorded under two
  // project directories sits in it twice with the same messages counted
  // in both entries. Fold by transcript identity keeping the largest
  // copy: a duplicate is a prefix of - at worst equal to - the fullest
  // copy, since both are appended from the same stream of turns.
  const byTranscript = new Map();
  for (const [file, entry] of Object.entries(cache.files)) {
    const contribution = entry.contribution || 0;
    if (!contribution) continue;
    const identity = transcriptKey(projectsDir, file);
    if (!identity) continue;
    const previous = byTranscript.get(identity.key);
    if (!previous || contribution > previous.contribution) {
      byTranscript.set(identity.key, { contribution, sessionId: identity.sessionId });
    }
  }

  // Total and per-session breakdown both come off that same fold, so
  // they can't disagree. Only sessions that actually consumed tokens
  // today appear, so the map stays small - and a subagent's transcript
  // rolls up into the session that spawned it rather than showing up as
  // a session of its own.
  let outputTokens = 0;
  const sessionTokens = {};
  for (const { contribution, sessionId } of byTranscript.values()) {
    outputTokens += contribution;
    sessionTokens[sessionId] = (sessionTokens[sessionId] || 0) + contribution;
  }

  saveCache(claudemonDir, cache);

  const stageState = { stageId: TREE.stages[0].id, dailyOutputTokens: outputTokens };
  applyEvolution(stageState, {});

  // Today's pick, and the pack shown on whichever day ran last. Both are
  // persisted: prevMon has to survive the ~30s rewrites that happen all
  // day long, otherwise tomorrow's guard would compare against nothing.
  const previous = readDaily(claudemonDir);
  let mon;
  let prevMon;
  if (previous && previous.dateKST === dateKST && previous.mon) {
    mon = previous.mon;
    prevMon = previous.prevMon || null;
  } else {
    prevMon = (previous && previous.mon) || null;
    mon = selectMon(dateKST, packsDir, sharedDir, prevMon);
  }

  const result = {
    dateKST,
    outputTokens,
    stageId: stageState.stageId,
    mon,
    prevMon,
    sessionTokens,
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
  defaultSharedDir,
  cacheFilePath,
  dailyFilePath,
  dateKSTString,
  startOfDayKSTUtcMs,
  listJsonlFiles,
  transcriptKey,
  scanFileIncrement,
  listValidPacks,
  listRotationPacks,
  packDeclaresStage,
  topStageId,
  hashString,
  selectMon
};
