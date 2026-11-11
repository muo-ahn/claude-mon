const fs = require('fs');
const os = require('os');
const path = require('path');

function roots(options) {
  if (options.codexDirs) return options.codexDirs;
  const home = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [process.env.CLAUDEMON_CODEX_SESSIONS_DIR || path.join(home, 'sessions'),
    process.env.CLAUDEMON_CODEX_ARCHIVED_DIR || path.join(home, 'archived_sessions')];
}

function collect(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.add(file);
  }
}

function readCache(file, date) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache.version === 2 && cache.date === date && cache.files) return cache;
  } catch (_) { /* fresh cache */ }
  return { version: 2, date, files: {} };
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(v => v[1] > v[0]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function uncoveredLength(legacy, modern) {
  let result = 0;
  const covered = mergeIntervals(modern);
  for (const [start, end] of mergeIntervals(legacy)) {
    let cursor = start;
    for (const [left, right] of covered) {
      if (right <= cursor || left >= end) continue;
      result += Math.max(0, Math.min(left, end) - cursor);
      cursor = Math.max(cursor, right);
      if (cursor >= end) break;
    }
    result += Math.max(0, end - cursor);
  }
  return result;
}

function scanCodex(now, options, dayStart, dayEnd, date) {
  const cacheFile = path.join(options.claudemonDir, 'codex-scan-cache.json');
  const cache = readCache(cacheFile, date);
  const files = new Set();
  for (const root of roots(options)) collect(root, files);
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    let entry = cache.files[file];
    if (!entry && stat.mtimeMs < dayStart && stat.mtimeMs < now.getTime() - 86400000) continue;
    if (!entry || stat.size < entry.offset || entry.ino !== stat.ino || entry.dev !== stat.dev) entry = { offset: 0, total: null, contribution: 0, ino: stat.ino, dev: stat.dev };
    try {
      const fd = fs.openSync(file, 'r');
      let buffer;
      try {
        buffer = Buffer.alloc(stat.size - entry.offset);
        const size = fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
        buffer = buffer.subarray(0, size);
      } finally { fs.closeSync(fd); }
      const lastNewline = buffer.lastIndexOf(10);
      if (lastNewline >= 0) {
        const lines = buffer.subarray(0, lastNewline).toString('utf8').split('\n');
        entry.offset += lastNewline + 1;
        for (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch (_) { continue; }
          if (!row || typeof row !== 'object') continue;
          const ts = Date.parse(row.timestamp);
          const payload = row.payload || {};
          const metaId = payload.id || payload.session_id;
          if (row.type === 'session_meta' && typeof metaId === 'string' && /^[a-zA-Z0-9_-]+$/.test(metaId)) {
            entry.id = metaId;
            entry.isChild = Boolean(payload.parent_thread_id || (payload.source && typeof payload.source === 'object' && payload.source.subagent));
            entry.historyStart = Number.isInteger(payload.subagent_history_start_ordinal) ? payload.subagent_history_start_ordinal : null;
            if (typeof payload.cwd === 'string') entry.cwd = payload.cwd;
          }
          if (row.type === 'token_usage_record' && Number.isFinite(ts) && ts >= dayStart && ts < dayEnd) {
            const id = payload.session_id || entry.id;
            const response = payload.response_id;
            const count = payload.usage && payload.usage.output_tokens;
            if (typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && typeof response === 'string' && response && Number.isFinite(count) && count >= 0) {
              if (!entry.responses) entry.responses = {};
              const cumulative = payload.thread_token_usage && payload.thread_token_usage.output_tokens;
              entry.responses[`response:${response}`] = { id, count, cumulative };
              if (id === entry.id && entry.working && ts <= now.getTime()) entry.activityAt = row.timestamp;
            }
          }
          const knownInherited = entry.isChild && entry.historyStart !== null && Number.isInteger(row.ordinal) && row.ordinal < entry.historyStart;
          if (row.type !== 'event_msg' || knownInherited) continue;
          if (payload.session_id && payload.session_id !== entry.id) continue;
          if (payload.type === 'task_started' && !entry.isChild && entry.id && typeof payload.turn_id === 'string' && Number.isFinite(ts) && ts >= dayStart && ts < dayEnd) {
            if (!entry.turns) entry.turns = {};
            entry.turns[`turn:${entry.id}:${payload.turn_id}`] = true;
          }
          if (Number.isFinite(ts) && ts <= now.getTime() && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
            entry.activityAt = row.timestamp;
            entry.working = payload.type === 'task_started';
          }
          if (entry.working && Number.isFinite(ts) && ts <= now.getTime() && ['token_count', 'exec_command_begin', 'exec_command_end'].includes(payload.type)) entry.activityAt = row.timestamp;
          if (payload.type !== 'token_count' || (entry.isChild && (entry.historyStart === null || !Number.isInteger(row.ordinal)))) continue;
          const info = payload.info || {};
          const total = info.total_token_usage && info.total_token_usage.output_tokens;
          const last = info.last_token_usage && info.last_token_usage.output_tokens;
          if (!Number.isFinite(total) || total < 0) continue;
          const delta = entry.total === null ? (Number.isFinite(last) && last >= 0 ? Math.min(last, total) : 0) : Math.max(0, total - entry.total);
          entry.total = total;
          if (Number.isFinite(ts) && ts >= dayStart && ts < dayEnd && delta > 0) {
            if (!entry.legacyIntervals) entry.legacyIntervals = [];
            entry.legacyIntervals.push([total - delta, total]);
          }
        }
      }
      cache.files[file] = entry;
    } catch (_) { /* keep last good scan */ }
  }
  for (const file of Object.keys(cache.files)) if (!files.has(file)) delete cache.files[file];
  const sessions = {};
  for (const entry of Object.values(cache.files)) {
    if (!entry.id) continue;
    const key = `codex-${entry.id}`;
    const prev = sessions[key];
    if (!prev) sessions[key] = { ...entry };
    else {
      prev.legacyIntervals = (prev.legacyIntervals || []).concat(entry.legacyIntervals || []);
      if (entry.activityAt && (!prev.activityAt || Date.parse(entry.activityAt) > Date.parse(prev.activityAt))) {
        prev.activityAt = entry.activityAt;
        prev.working = entry.working;
        if (entry.cwd) prev.cwd = entry.cwd;
      }
    }
  }
  const tokens = {};
  const turns = new Set();
  for (const entry of Object.values(cache.files)) for (const turn of Object.keys(entry.turns || {})) turns.add(turn);
  const responses = new Map();
  for (const entry of Object.values(cache.files)) {
    for (const [response, usage] of Object.entries(entry.responses || {})) {
      const prior = responses.get(response);
      if (!prior || usage.count > prior.count) responses.set(response, usage);
    }
  }
  for (const usage of responses.values()) {
    const id = `codex-${usage.id}`;
    tokens[id] = (tokens[id] || 0) + usage.count;
  }
  const modernIntervals = {};
  const unknownModern = {};
  for (const usage of responses.values()) {
    const id = `codex-${usage.id}`;
    if (!Number.isFinite(usage.cumulative) || usage.cumulative < usage.count) {
      unknownModern[id] = (unknownModern[id] || 0) + usage.count;
      continue;
    }
    if (!modernIntervals[id]) modernIntervals[id] = [];
    modernIntervals[id].push([usage.cumulative - usage.count, usage.cumulative]);
  }
  for (const [id, entry] of Object.entries(sessions)) {
    const legacy = uncoveredLength(entry.legacyIntervals || [], modernIntervals[id] || []);
    const additional = Math.max(0, legacy - (unknownModern[id] || 0));
    if (additional) tokens[id] = (tokens[id] || 0) + additional;
    if (!entry.activityAt) continue;
    const dir = path.join(options.claudemonDir, 'sessions');
    const file = path.join(dir, `${id}.json`);
    const state = { sessionId: id, provider: 'codex', cwd: entry.cwd || '', working: entry.working, updatedAt: entry.activityAt };
    const contents = JSON.stringify(state);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let old = '';
      try { old = fs.readFileSync(file, 'utf8'); } catch (_) { /* new */ }
      if (old !== contents) {
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, contents);
        fs.renameSync(temp, file);
      }
    } catch (_) { /* state display is best effort */ }
  }
  try {
    fs.mkdirSync(options.claudemonDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch (_) { /* next run rescans */ }
  return { tokens, userTurns: turns.size };
}

module.exports = { scanCodex };
