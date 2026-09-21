#!/usr/bin/env node
// 역방향 인덱스로 발굴한 후보들을 evolution-graph.json에 편입한다.
// 역방향 방식: 새 노드(예: Palmon)를 추가하고, 그 자식들(이미 그래프에 있는 노드들)의 evolvesFrom에 새 노드를 추가한다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const CANDIDATES_PATH = path.join(ROOT, 'docs', 'reverse-index-candidates.json');
const CANON_PATH = path.join(ROOT, 'docs', 'dot-candidates-canon.json');

const STAGES = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];
const stageIdx = Object.fromEntries(STAGES.map((s, i) => [s, i]));

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadCandidates() {
  return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
}

function loadCanonData() {
  return JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
}

function saveGraph(graph) {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
}

function main() {
  const graph = loadGraph();
  const candidatesData = loadCandidates();
  const canonData = loadCanonData();

  const graphIds = new Set(graph.nodes.map((n) => n.id));
  const nodeStage = Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage]));
  const nodeMap = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));

  // canonData를 title로 인덱싱
  const canonByTitle = Object.fromEntries(canonData.map((sp) => [sp.title, sp]));

  console.log('=== 편입 시작 ===');
  console.log('현재 노드:', graph.nodes.length);
  console.log('후보:', candidatesData.withDots.length);
  console.log('');

  let addedCount = 0;
  let skippedCount = 0;
  const skippedReasons = [];

  for (const candidate of candidatesData.withDots) {
    const { title, stage, koName, children } = candidate;
    const spriteId = title.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 중복 체크
    if (graphIds.has(spriteId)) {
      skippedCount++;
      skippedReasons.push(`${title}: 이미 그래프에 있음 (${spriteId})`);
      continue;
    }

    // 도트 확인
    const dotPath = path.join('/Users/saladlab/Dev/claude-mon/sprites/nodes', `${spriteId}-0.png`);
    if (!fs.existsSync(dotPath)) {
      skippedCount++;
      skippedReasons.push(`${title}: 도트 없음 (${spriteId}-0.png)`);
      continue;
    }

    // 스테이지 인접한 자식 확인
    const adjacentChildren = children.filter((childId) => {
      const childStage = nodeStage[childId];
      if (!childStage) return false;

      const parentIdx = stageIdx[stage];
      const childIdx = stageIdx[childStage];

      return childIdx === parentIdx + 1;
    });

    if (adjacentChildren.length === 0) {
      skippedCount++;
      skippedReasons.push(`${title}: 스테이지 인접 자식 없음 (R9 위반)`);
      continue;
    }

    // 이 노드의 부모 중 그래프에 이미 있고 스테이지 인접한 것 찾기
    const canonSpec = canonByTitle[title];
    const validParents = [];

    if (canonSpec && canonSpec.evolvesFrom) {
      for (const edge of canonSpec.evolvesFrom) {
        if (!edge.allowed) continue;
        if (!edge.parentInGraph) continue;

        const parentStage = nodeStage[edge.parentId];
        if (!parentStage) continue;

        const currentIdx = stageIdx[stage];
        const parentIdx = stageIdx[parentStage];

        if (parentIdx + 1 === currentIdx) {
          validParents.push(edge.parentId);
        }
      }
    }

    // 새 노드 추가
    const newNode = {
      id: spriteId,
      name: koName || title,
      stage: stage,
      sprite: spriteId,
      evolvesFrom: validParents.map((pid) => ({ from: pid, when: null })),
    };

    graph.nodes.push(newNode);
    graphIds.add(spriteId);
    nodeStage[spriteId] = stage;
    nodeMap[spriteId] = newNode;

    // 자식들의 evolvesFrom에 이 노드 추가
    let edgeCount = 0;
    for (const childId of adjacentChildren) {
      const childNode = nodeMap[childId];
      if (!childNode) continue;

      // 중복 엣지 체크
      if (childNode.evolvesFrom.some((e) => e.from === spriteId)) continue;

      childNode.evolvesFrom.push({ from: spriteId, when: null });
      edgeCount++;
    }

    addedCount++;
    console.log(
      `[편입] ${title} (${stage}) — 자식 ${edgeCount}명: ${adjacentChildren.slice(0, 5).join(', ')}${adjacentChildren.length > 5 ? '...' : ''}`
    );
  }

  console.log('');
  console.log('=== 편입 완료 ===');
  console.log('추가:', addedCount);
  console.log('제외:', skippedCount);
  console.log('최종 노드:', graph.nodes.length);

  if (skippedReasons.length > 0) {
    console.log('');
    console.log('제외 사유:');
    for (const reason of skippedReasons) {
      console.log('  ' + reason);
    }
  }

  saveGraph(graph);
  console.log('');
  console.log('저장:', GRAPH_PATH);
}

main();
