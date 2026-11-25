#!/usr/bin/env node
// C6: evolution-graph.json 에 질 지표 조건(toolCallsPerTurn, dailyCommitCount)을
// 결정적으로 배정한다 (D-10). 조건은 {type, gte: 'p50'} 이고 가중치(8 대 1)에만 쓴다.
//
// 사용법: node scripts/add-quality-conditions.js
//
// 멱등: 실행할 때마다 이전 실행이 붙인 질 지표 조건을 when:null 로 되돌린 뒤
// 같은 규칙으로 다시 배정한다. 같은 그래프에 두 번 돌려도 diff 가 비어야 한다.
//
// 규칙 (lib/quality-edges.js):
//   1) fan-out >= 4 인 부모 중 when:null 엣지가 있는 부모를 fan-out 내림차순,
//      같으면 부모 id 오름차순으로 세운다.
//   2) 앞에서 QUALITY_EDGE_CAP(111)개만 쓴다.
//   3) 순위가 짝수면 toolCallsPerTurn, 홀수면 dailyCommitCount.
//   4) 부모당 child id 가 가장 작은 when:null 엣지 하나에 조건을 붙인다.

const fs = require('fs');
const path = require('path');
const {
  QUALITY_EDGE_CAP,
  QUALITY_AXES,
  rankQualityParents
} = require('../lib/quality-edges');
const { isQualityCondition } = require('../lib/evolve');

const GRAPH_PATH = path.join(__dirname, '..', 'evolution-graph.json');

function compareIds(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function main() {
  const raw = fs.readFileSync(GRAPH_PATH, 'utf8');
  const graph = JSON.parse(raw);
  if (JSON.stringify(graph, null, 2) + '\n' !== raw) {
    console.error('evolution-graph.json 포맷이 JSON.stringify(g, null, 2) + "\\n" 과 다르다. 중단.');
    process.exit(1);
  }

  let reverted = 0;
  for (const node of graph.nodes) {
    for (const edge of node.evolvesFrom || []) {
      if (isQualityCondition(edge.when)) {
        edge.when = null;
        reverted += 1;
      }
    }
  }

  // Ranking reads fan-out from every edge, so it must run after the revert.
  const selected = rankQualityParents(graph).slice(0, QUALITY_EDGE_CAP);
  const unconditionalByParent = new Map();
  for (const node of graph.nodes) {
    for (const edge of node.evolvesFrom || []) {
      if (edge.when !== null) continue;
      if (!unconditionalByParent.has(edge.from)) unconditionalByParent.set(edge.from, []);
      unconditionalByParent.get(edge.from).push({ child: node.id, edge });
    }
  }

  const added = Object.fromEntries(QUALITY_AXES.map((axis) => [axis, 0]));
  selected.forEach((parent, rank) => {
    const axis = QUALITY_AXES[rank % 2];
    const [target] = unconditionalByParent.get(parent)
      .sort((a, b) => compareIds(a.child, b.child));
    target.edge.when = { type: axis, gte: 'p50' };
    added[axis] += 1;
  });

  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');

  const total = selected.length;
  console.log('=== C6 질 지표 조건 배정 ===');
  console.log(`되돌린 이전 배정: ${reverted}개`);
  console.log(`후보 부모(fan-out >= 4, when:null 보유): ${rankQualityParents(graph).length}개`);
  console.log(`배정 부모: ${total}개 (상한 ${QUALITY_EDGE_CAP})`);
  for (const axis of QUALITY_AXES) {
    console.log(`  ${axis}: ${added[axis]}개`);
  }
}

main();
