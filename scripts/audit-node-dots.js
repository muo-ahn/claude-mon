#!/usr/bin/env node
// 그래프의 모든 노드에 sprites/nodes/<sprite>-0.png 가 있는지 검사한다.
// 종을 그래프에 편입하면서 도트 수집을 빠뜨리면 메뉴바가 이전 단계 도트를 대신 보여 준다.
//
// 실행: node scripts/audit-node-dots.js
// 누락이 있으면 목록을 출력하고 종료 코드 1 로 끝난다.
// digitama 처럼 공용 도트를 쓰는 단계는 sprites/shared/ 를 본다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');
const SHARED_DIR = path.join(ROOT, 'sprites', 'shared');
const SHARED_STAGES = new Set(['digitama']);

function findNodesWithoutDot(graphPath = GRAPH_PATH, nodesDir = NODES_DIR, sharedDir = SHARED_DIR) {
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  return graph.nodes
    .filter((node) => {
      const dir = SHARED_STAGES.has(node.stage) ? sharedDir : nodesDir;
      return !fs.existsSync(path.join(dir, `${node.sprite}-0.png`));
    })
    .map((node) => node.id);
}

// 누락이 있으면 목록을 출력하고 false 를 돌려준다.
function auditNodeDots() {
  const missing = findNodesWithoutDot();
  if (missing.length === 0) return true;
  console.error(`도트(sprites/nodes/<sprite>-0.png) 누락 ${missing.length}종: ${missing.join(', ')}`);
  console.error('python3 scripts/fetch-wikimon-dots.py 로 도트를 받은 뒤 다시 실행하라.');
  return false;
}

if (require.main === module) {
  process.exit(auditNodeDots() ? 0 : 1);
}

module.exports = { findNodesWithoutDot, auditNodeDots };
