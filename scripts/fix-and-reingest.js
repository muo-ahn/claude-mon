#!/usr/bin/env node
// 잘못 편입된 17종을 제거하고 올바르게 재편입한다.
// ① tunomon 중복 제거, ② 한글명 필터, ③ baby → digitama, ④ 고아 0 보장

const fs = require('fs');
const path = require('path');

const { auditNodeDots } = require('./audit-node-dots');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const CANON_PATH = path.join(ROOT, 'docs', 'dot-candidates-canon.json');
const CANDIDATES_PATH = path.join(ROOT, 'docs', 'reverse-index-candidates.json');

const STAGES = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];
const stageIdx = Object.fromEntries(STAGES.map((s, i) => [s, i]));

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadCanonData() {
  return JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
}

function loadCandidates() {
  return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
}

function saveGraph(graph) {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
}

// 편집거리 (Levenshtein)
function editDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function main() {
  const graph = loadGraph();
  const canonData = loadCanonData();
  const candidatesData = loadCandidates();

  console.log('=== 1단계: 잘못 편입된 17종 제거 ===');
  console.log('현재 노드:', graph.nodes.length);

  // 제거할 ID 목록
  const removeIds = new Set([
    'penmon',
    'wormmon',
    'tanemon',
    'floramon',
    'palmon',
    'ancientbeatmon',
    'caprimon',
    'pagumon',
    'dracumon',
    'tunomon', // 중복
    'hyokomon',
    'strikedramon',
    'kotemon',
    'lopmon',
    'butenmon',
    'buraimon',
    'otamamon',
  ]);

  // 노드 제거
  const originalNodeCount = graph.nodes.length;
  graph.nodes = graph.nodes.filter((n) => !removeIds.has(n.id));
  console.log('제거:', originalNodeCount - graph.nodes.length);

  // 자식 노드의 evolvesFrom에서 제거된 부모 제거
  let removedEdges = 0;
  for (const node of graph.nodes) {
    const beforeCount = node.evolvesFrom.length;
    node.evolvesFrom = node.evolvesFrom.filter((e) => !removeIds.has(e.from));
    removedEdges += beforeCount - node.evolvesFrom.length;
  }
  console.log('엣지 제거:', removedEdges);
  console.log('');

  console.log('=== 2단계: 중복 가드 강화 (편집거리) ===');
  const graphIds = new Set(graph.nodes.map((n) => n.id));
  const graphNames = new Set(graph.nodes.map((n) => n.name).filter((n) => n));

  function isDuplicateEnhanced(title, spriteId) {
    // 기존 중복 체크
    if (graphIds.has(spriteId)) {
      return { dup: true, reason: `ID 중복: ${spriteId}` };
    }

    // 편집거리 기반 유사도 (tunomon/tsunomon 같은 오타성 중복만 검출)
    for (const existingId of graphIds) {
      const dist = editDistance(spriteId, existingId);
      const lengthDiff = Math.abs(spriteId.length - existingId.length);

      // 길이가 같고 편집거리 1 (oov → oon 같은 오타)
      // 또는 길이 차이 1이고 편집거리 1 (tunomon → tsunomon 같은 탈락/추가)
      if (dist === 1 && lengthDiff <= 1 && spriteId.length >= 5) {
        return {
          dup: true,
          reason: `유사 ID (편집거리 ${dist}, 길이차 ${lengthDiff}): ${spriteId} ≈ ${existingId}`,
        };
      }
    }

    return { dup: false };
  }

  console.log('편집거리 테스트:');
  console.log('  tunomon vs tsunomon:', editDistance('tunomon', 'tsunomon'));
  console.log('  palmon vs palmon:', editDistance('palmon', 'palmon'));
  console.log('');

  console.log('=== 3단계: 한글명 있는 종만 필터링 ===');
  const canonByTitle = Object.fromEntries(canonData.map((sp) => [sp.title, sp]));

  const validCandidates = [];
  const skipped = [];

  for (const cand of candidatesData.withDots) {
    const { title, stage } = cand;
    const spriteId = title.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 중복 체크
    const dupCheck = isDuplicateEnhanced(title, spriteId);
    if (dupCheck.dup) {
      skipped.push({ title, reason: dupCheck.reason });
      continue;
    }

    // 한글명 체크
    const canonSpec = canonByTitle[title];
    if (!canonSpec || !canonSpec.koName) {
      skipped.push({ title, reason: '한글명 없음' });
      continue;
    }

    // 도트 확인
    const dotPath = path.join('/Users/saladlab/Dev/claude-mon/sprites/nodes', `${spriteId}-0.png`);
    if (!fs.existsSync(dotPath)) {
      skipped.push({ title, reason: '도트 없음' });
      continue;
    }

    validCandidates.push({ ...cand, spriteId, koName: canonSpec.koName, canonSpec });
  }

  console.log('유효 후보:', validCandidates.length);
  console.log('제외:', skipped.length);
  for (const s of skipped) {
    console.log(`  ${s.title}: ${s.reason}`);
  }
  console.log('');

  console.log('=== 4단계: 재편입 (스테이지 순서대로) ===');
  const nodeMap = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const nodeStage = Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage]));

  // 스테이지 순서대로 정렬 (baby → child → adult → perfect → ultimate)
  validCandidates.sort((a, b) => stageIdx[a.stage] - stageIdx[b.stage]);

  let addedCount = 0;

  for (const cand of validCandidates) {
    const { title, stage, spriteId, koName, canonSpec, children } = cand;

    // 스테이지 인접한 자식 확인
    const adjacentChildren = children.filter((childId) => {
      const childStage = nodeStage[childId];
      if (!childStage) return false;
      const parentIdx = stageIdx[stage];
      const childIdx = stageIdx[childStage];
      return childIdx === parentIdx + 1;
    });

    if (adjacentChildren.length === 0) {
      console.log(`[스킵] ${title}: 스테이지 인접 자식 없음`);
      continue;
    }

    // 부모 결정
    const evolvesFrom = [];

    if (stage === 'baby') {
      // baby는 digitama 부모
      evolvesFrom.push({ from: 'digitama', when: null });
    } else {
      // 성장기 이상: canonSpec에서 그래프에 있는 인접 부모 찾기
      for (const edge of canonSpec.evolvesFrom) {
        if (!edge.allowed) continue;

        // 실시간 그래프 확인 (parentInGraph는 harvest 시점 스냅샷이므로 사용 안 함)
        const parentStage = nodeStage[edge.parentId];
        if (!parentStage) continue; // 그래프에 없음

        const currentIdx = stageIdx[stage];
        const parentIdx = stageIdx[parentStage];

        if (parentIdx + 1 === currentIdx) {
          evolvesFrom.push({ from: edge.parentId, when: null });
        }
      }

      if (evolvesFrom.length === 0) {
        console.log(`[스킵] ${title}: 그래프에 있는 인접 부모 없음`);
        continue;
      }
    }

    // 새 노드 추가
    const newNode = {
      id: spriteId,
      name: koName,
      stage: stage,
      sprite: spriteId,
      evolvesFrom: evolvesFrom,
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
      if (childNode.evolvesFrom.some((e) => e.from === spriteId)) continue;

      childNode.evolvesFrom.push({ from: spriteId, when: null });
      edgeCount++;
    }

    addedCount++;
    console.log(
      `[편입] ${title} (${koName}, ${stage}) — 부모 ${evolvesFrom.length}명, 자식 ${edgeCount}명`
    );
  }

  console.log('');
  console.log('=== 편입 완료 ===');
  console.log('추가:', addedCount);
  console.log('최종 노드:', graph.nodes.length);

  saveGraph(graph);
  console.log('');
  console.log('저장:', GRAPH_PATH);

  // 편입한 종의 도트가 없으면 비정상 종료해 수집 누락을 놓치지 않는다.
  if (!auditNodeDots()) process.exitCode = 1;
}

main();
