#!/usr/bin/env node
// Wire into ~/.claude/settings.json:
// { "statusLine": { "type": "command", "command": "node /path/to/statusline.js", "padding": 0 } }

const { load, save, loadSession, saveSession } = require('./lib/state');
const { stageById, applyRegression, getWarning } = require('./lib/evolve');

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

function readStdinJson() {
  try {
    const raw = require('fs').readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function extractContextUsagePct(session) {
  // Claude Code's statusline payload shape varies by version; this reads the
  // common fields defensively and falls back to 0 rather than guessing.
  const used = session?.context?.used_tokens ?? session?.tokens?.used;
  const total = session?.context?.max_tokens ?? session?.tokens?.max;
  if (typeof used === 'number' && typeof total === 'number' && total > 0) {
    return Math.round((used / total) * 100);
  }
  return 0;
}

function frame(sprite) {
  // Alternate frames based on wall-clock second so it "animates" across
  // successive statusline redraws (Claude Code redraws at most every 300ms).
  const idx = new Date().getSeconds() % sprite.length;
  return sprite[idx];
}

function main() {
  const session = readStdinJson();
  const sessionId = session.session_id;
  const state = sessionId ? loadSession(sessionId) : load();

  state.contextUsagePct = extractContextUsagePct(session);
  const regressed = applyRegression(state);
  if (regressed) {
    if (sessionId) {
      saveSession(state);
    } else {
      save(state);
    }
  }

  const stage = stageById(state.stageId);
  const warn = getWarning(state);
  const sprite = frame(stage.sprite);
  const colored = warn === 'red' ? `${RED}${sprite}${RESET}` : sprite;

  const bits = [
    colored,
    stage.label,
    `${DIM}(성공 ${state.toolSuccessCount} / 실패 ${state.toolFailureCount})${RESET}`
  ];
  if (state.contextUsagePct) {
    bits.push(`${DIM}ctx ${state.contextUsagePct}%${RESET}`);
  }

  process.stdout.write(bits.join('  '));
}

main();
