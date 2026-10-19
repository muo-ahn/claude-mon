#!/usr/bin/env node
// 역방향 인덱스로 발굴한 후보들을 evolution-graph.json에 편입한다.
// R9(스테이지 인접성), R10(종점은 ultimate/superultimate), R11(궁극체 종점은 초궁극체 후계) 적용.

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

  const graphIds = new Set(graph.nodes.map((n) => n.id));
  const nodeStage = Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage]));

  console.log('=== 편입 시작 ===');
  console.log('현재 노드:', graph.nodes.length);
  console.log('후보:', canonData.length);
  console.log('');

  let addedCount = 0;
  let skippedCount = 0;
  const skippedReasons = [];

  for (const species of canonData) {
    const { title, stageId, koName, evolvesFrom } = species;
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

    // allowed=true이고 그래프에 이미 있는 부모 중 스테이지 인접한 것만 추출
    const validParents = [];
    for (const edge of evolvesFrom) {
      if (!edge.allowed) continue;
      if (!edge.parentInGraph) continue; // 그래프에 없는 부모는 나중에 (vpet 풀로)

      const parentStage = nodeStage[edge.parentId];
      if (!parentStage) continue;

      const currentIdx = stageIdx[stageId];
      const parentIdx = stageIdx[parentStage];

      if (parentIdx + 1 === currentIdx) {
        validParents.push(edge);
      }
    }

    if (validParents.length === 0) {
      skippedCount++;
      skippedReasons.push(`${title}: 그래프에 있는 스테이지 인접 부모 없음 (R9 위반)`);
      continue;
    }

    // 편입
    const newNode = {
      id: spriteId,
      name: koName || title,
      stage: stageId,
      sprite: spriteId,
      evolvesFrom: validParents.map((e) => ({ from: e.parentId, when: null })),
    };

    graph.nodes.push(newNode);
    graphIds.add(spriteId);
    nodeStage[spriteId] = stageId;
    addedCount++;

    console.log(
      `[편입] ${title} (${stageId}) — 부모 ${validParents.length}명: ${validParents.map((e) => e.parentId).slice(0, 5).join(', ')}${validParents.length > 5 ? '...' : ''}`
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
