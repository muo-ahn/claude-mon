#!/usr/bin/env node
// 케어미스 엣지에 조건 상속 적용 (신규 엣지만)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadMainGraph() {
  // main 브랜치의 그래프 읽기
  try {
    const mainGraphJson = execSync('git show main:evolution-graph.json', {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(mainGraphJson);
  } catch (err) {
    console.error('main 그래프 로드 실패:', err.message);
    return null;
  }
}

function saveGraph(graph) {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
}

function main() {
  const graph = loadGraph();
  const mainGraph = loadMainGraph();

  if (!mainGraph) {
    console.error('main 그래프를 읽을 수 없어 중단');
    return;
  }

  console.log('=== 조건 상속 규칙 적용 (신규 엣지만) ===');
  console.log('');

  // main의 (from, to) 쌍 인덱스
  const mainEdges = new Set();
  for (const node of mainGraph.nodes) {
    for (const edge of node.evolvesFrom) {
      mainEdges.add(`${edge.from}→${node.id}`);
    }
  }

  console.log('main 엣지 수:', mainEdges.size);
  console.log('');

  // R13: 신규 엣지만 조건 상속
  // 편입 대상 노드로 들어오는 기존 엣지들이 모두 동일한 when을 갖고 있으면,
  // 신규 엣지도 그 조건을 상속해야 한다.

  let fixedCount = 0;
  const fixLog = [];

  for (const node of graph.nodes) {
    const edges = node.evolvesFrom;
    if (edges.length === 0) continue;

    // 신규 엣지와 기존 엣지 분리
    const newEdges = edges.filter((e) => !mainEdges.has(`${e.from}→${node.id}`));
    const existingEdges = edges.filter((e) => mainEdges.has(`${e.from}→${node.id}`));

    if (newEdges.length === 0) continue; // 신규 엣지 없음

    // 기존 엣지의 조건이 모두 동일한지 확인
    if (existingEdges.length > 0) {
      const conditionGroups = {};
      for (const edge of existingEdges) {
        const key = JSON.stringify(edge.when);
        if (!conditionGroups[key]) conditionGroups[key] = [];
        conditionGroups[key].push(edge);
      }

      // 기존 엣지가 모두 동일한 조건을 가지면 신규 엣지에 상속
      if (Object.keys(conditionGroups).length === 1) {
        const dominantKey = Object.keys(conditionGroups)[0];
        const dominantCondition = JSON.parse(dominantKey);

        // null이 아닌 조건만 상속
        if (dominantCondition !== null) {
          const nullNewEdges = newEdges.filter((e) => e.when === null);

          if (nullNewEdges.length > 0) {
            console.log(`[${node.id}] 조건 상속 적용:`);
            console.log(`  기존 엣지 ${existingEdges.length}개: ${dominantKey}`);
            console.log(`  신규 엣지 ${nullNewEdges.length}개: null → 조건 상속`);

            for (const edge of nullNewEdges) {
              edge.when = dominantCondition;
              fixedCount++;
              fixLog.push(
                `  ${edge.from} → ${node.id}: null → ${JSON.stringify(dominantCondition)}`
              );
            }

            console.log('');
          }
        }
      }
    }
  }

  console.log('=== 수정 완료 ===');
  console.log('신규 엣지 조건 상속:', fixedCount);
  console.log('기존 엣지 변경: 0 (신규 엣지만 처리)');
  console.log('');

  if (fixLog.length > 0) {
    console.log('수정 내역:');
    for (const log of fixLog) {
      console.log(log);
    }
    console.log('');
  }

  saveGraph(graph);
  console.log('저장:', GRAPH_PATH);
}

main();
