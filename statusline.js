#!/usr/bin/env node
// Wire into ~/.claude/settings.json:
// { "statusLine": { "type": "command", "command": "node /path/to/statusline.js", "padding": 0 } }

const { load, save, loadSession, saveSession } = require('./lib/state');
const { stageById, applyRegression, getWarning } = require('./lib/evolve');
const { summarize, formatPace, modeLabel } = require('./lib/quota');

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

// 쿼터 모드별 색. 여유는 "태워도 된다" 는 적극 신호라 초록으로 눈에 띄게 두고,
// 적정은 평소 상태라 나머지 statusline 과 같은 dim 으로 묻어둔다.
const MODE_COLOR = { surplus: GREEN, normal: DIM, tight: YELLOW, deficit: RED };

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
  // context_window.used_percentage is what current versions actually send —
  // the token-pair fields below are older/other shapes kept as fallbacks.
  const pct = session?.context_window?.used_percentage;
  if (typeof pct === 'number') return Math.round(pct);
  const used = session?.context?.used_tokens ?? session?.tokens?.used;
  const total = session?.context?.max_tokens ?? session?.tokens?.max;
  if (typeof used === 'number' && typeof total === 'number' && total > 0) {
    return Math.round((used / total) * 100);
  }
  return 0;
}

// 지배 버킷(주간)의 잔여·페이스를 한 조각으로. 5h 가 위험할 때만 뒤에 덧붙인다 —
// 주간이 여유여도 5h 벽에 막히면 당장 대기가 걸리기 때문이다.
function quotaBit(session, nowSec) {
  const summary = summarize(session?.rate_limits, nowSec);
  if (!summary) return null;

  const g = summary.governing;
  const color = MODE_COLOR[summary.mode] || DIM;
  let text = `${g.label} ${Math.round(g.headroom)}%·${formatPace(g.pace)} ${modeLabel(summary.mode)}`;
  if (summary.hourlyRisk.length) {
    const worst = summary.hourlyRisk.reduce((lo, b) => (b.pace < lo.pace ? b : lo));
    text += ` ${worst.label} ${Math.round(worst.headroom)}%!`;
  }
  return `${color}${text}${RESET}`;
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
  const quota = quotaBit(session, Date.now() / 1000);
  if (quota) {
    bits.push(quota);
  }

  process.stdout.write(bits.join('  '));
}

main();
