#!/usr/bin/env node
// Usage: node daily-tokens.js
//
// Aggregates today's (KST, midnight-reset) output token usage across all
// Claude Code transcripts under ~/.claude/projects (or $CLAUDEMON_PROJECTS_DIR),
// maps the total to an evolution-tree.json stage, and writes the result to
// $CLAUDEMON_DIR/daily.json:
//   { "dateKST": "YYYY-MM-DD", "outputTokens": <int>, "stageId": "<stage>", "updatedAt": "<ISO>" }
//
// Scans incrementally via $CLAUDEMON_DIR/token-scan-cache.json (per-file byte
// offset + running contribution), so repeated invocations (e.g. every 30s
// from the menubar app) stay fast. Intended to be polled, not scheduled.
const { computeDailyTokens } = require('./lib/daily');

function main() {
  const result = computeDailyTokens(new Date());
  console.log(
    `[claudemon] ${result.dateKST} outputTokens=${result.outputTokens} stage=${result.stageId}`
  );
}

main();
