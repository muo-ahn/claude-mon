#!/usr/bin/env node
// 역방향 편입된 17종의 evolvesFrom을 채운다 (고아 노드 해소).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const CANON_PATH = path.join(ROOT, 'docs', 'dot-candidates-canon.json');

const STAGES = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];
const stageIdx = Object.fromEntries(STAGES.map((s, i) => [s, i]));

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadCanonData() {
  return JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
}

function saveGraph(graph) {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
}

function main() {
  const graph = loadGraph();
  const canonData = loadCanonData();

  const nodeMap = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const nodeStage = Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage]));
  const canonByTitle = Object.fromEntries(canonData.map((sp) => [sp.title, sp]));

  const orphans = graph.nodes.filter((n) => n.evolvesFrom.length === 0);

  console.log('=== 고아 노드 부모 연결 ===');
  console.log('고아 노드:', orphans.length);
  console.log('');

  let fixedCount = 0;

  for (const node of orphans) {
    // canonData에서 이 노드의 스펙 찾기
    let canonSpec = null;
    for (const sp of canonData) {
      const spriteId = sp.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (spriteId === node.id) {
        canonSpec = sp;
        break;
      }
    }

    if (!canonSpec) {
      console.log(`[스킵] ${node.id}: canonData에 없음`);
      continue;
    }

    // allowed=true이고 그래프에 있으며 스테이지 인접한 부모 찾기
    const validParents = [];
    for (const edge of canonSpec.evolvesFrom) {
      if (!edge.allowed) continue;
      if (!edge.parentInGraph) continue;

      const parentNode = nodeMap[edge.parentId];
      if (!parentNode) continue;

      const currentIdx = stageIdx[node.stage];
      const parentIdx = stageIdx[parentNode.stage];

      if (parentIdx + 1 === currentIdx) {
        // 중복 체크
        if (!node.evolvesFrom.some((e) => e.from === edge.parentId)) {
          validParents.push(edge.parentId);
        }
      }
    }

    if (validParents.length > 0) {
      node.evolvesFrom.push(...validParents.map((pid) => ({ from: pid, when: null })));
      fixedCount++;
      console.log(
        `[수정] ${node.id} (${node.stage}) — 부모 ${validParents.length}명: ${validParents.slice(0, 3).join(', ')}${validParents.length > 3 ? '...' : ''}`
      );
    } else {
      console.log(`[보류] ${node.id} (${node.stage}) — 그래프에 있는 스테이지 인접 부모 없음`);
    }
  }

  console.log('');
  console.log('=== 수정 완료 ===');
  console.log('수정:', fixedCount);
  console.log('보류:', orphans.length - fixedCount);

  saveGraph(graph);
  console.log('');
  console.log('저장:', GRAPH_PATH);
}

main();
