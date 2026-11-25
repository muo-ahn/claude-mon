#!/usr/bin/env node
// 성장기 덱 후보 판정(C5, D-6). 성장기 덱에 넣을 child 노드를 규칙대로 고른다.
//
// 후보 규칙: child 노드마다 아래 네 가지를 모두 만족해야 한다.
//   (a) 도트: sprites/nodes/<sprite>-0.png 가 있다.
//   (b) 최상위 도달: 도트 있고 제외 목록에 없는 자식만 따라가 superultimate 에 닿는다.
//       lib/daily.js 의 linksWithDots 와 같은 기준이지만 엄격하다. 도트 없는 자식만
//       남는 경우에 빈 자리를 채우는 fallback 을 쓰지 않는다.
//   (c) 제외 목록(sprites/nodes-denylist.json)에 없다.
//   (d) 원문 R11: 도트 있고 제외 목록에 없는 baby 부모(evolvesFrom)가 1개 이상 있다.
// 탈락 사유는 이 순서대로 하나만 고른다: 도트 없음, 제외 목록, 최상위 미도달, baby 부모 없음.
//
// 실행: node scripts/audit-deck-candidates.js
// 후보 수, 기존 팩 수, 신규 목록, 탈락 사유를 stdout 에 낸다.
// sprites/packs 의 팩 디렉터리 집합과 후보 집합이 다르면 종료 코드 1 이다.
// 규칙에서 탈락한 기존 팩은 경고만 내고 지우지 않는다(D-4). 신규 팩 생성은 add-deck-packs.js 몫이다.

const fs = require('fs');
const path = require('path');

const { TREE } = require('../lib/evolve');
const { graphFilePath, defaultPacksDir, readNodeDenylist } = require('../lib/daily');

const ROOT = path.join(__dirname, '..');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');
const TOP_STAGE = TREE.stages[TREE.stages.length - 1].id;

// 도트 파일이 있는 노드인지. digitama 는 공용 도트(sprites/shared)를 쓰므로 항상 있다고 본다.
function hasDot(node, nodesDir) {
  if (node.stage === 'digitama') return true;
  return fs.existsSync(path.join(nodesDir, `${node.sprite}-0.png`));
}

// 그래프 배열에서 byId 와 childrenOf(부모 id -> [{ node, when }])를 만든다.
// lib/daily.js 의 readGraph 와 같은 역인덱스를 쓰되, 모듈 밖에서 쓰도록 여기서 만든다.
function indexGraph(nodes) {
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node);
  const childrenOf = new Map();
  for (const node of nodes) {
    for (const edge of node.evolvesFrom || []) {
      if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);
      childrenOf.get(edge.from).push({ node, when: edge.when });
    }
  }
  return { nodes, byId, childrenOf };
}

// 도트 있고 제외 목록에 없는 자식 노드만 돌려준다.
function usableChildren(graph, parentId, nodesDir, denylist) {
  const links = graph.childrenOf.get(parentId) || [];
  return links
    .map((link) => link.node)
    .filter((node) => !denylist.has(node.id) && hasDot(node, nodesDir));
}

// 시작 노드에서 usableChildren 만 따라 최상위 단계 노드에 닿는지 본다.
// 스택으로 돈다. 방문한 노드는 다시 넣지 않는다.
function reachesTop(graph, startId, nodesDir, denylist) {
  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    const node = graph.byId.get(id);
    if (node && node.stage === TOP_STAGE) return true;
    for (const child of usableChildren(graph, id, nodesDir, denylist)) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return false;
}

// 도트 있고 제외 목록에 없는 baby 부모가 하나라도 있는지(원문 R11).
function hasBabyParent(graph, node, nodesDir, denylist) {
  return (node.evolvesFrom || []).some((edge) => {
    const parent = graph.byId.get(edge.from);
    return Boolean(parent) && parent.stage === 'baby' && !denylist.has(parent.id) && hasDot(parent, nodesDir);
  });
}

// 노드 하나의 탈락 사유. 통과하면 null.
function deckRejection(graph, node, nodesDir, denylist) {
  if (!hasDot(node, nodesDir)) return '도트 없음';
  if (denylist.has(node.id)) return '제외 목록';
  if (!reachesTop(graph, node.id, nodesDir, denylist)) return '최상위 미도달';
  if (!hasBabyParent(graph, node, nodesDir, denylist)) return 'baby 부모 없음';
  return null;
}

// child 노드마다 { id, reason } 을 그래프 배열 순서대로 돌려준다. reason 이 null 이면 후보다.
function deckVerdicts({ graph, nodesDir = NODES_DIR, denylist = new Set() }) {
  return graph.nodes
    .filter((node) => node.stage === 'child')
    .map((node) => ({ id: node.id, reason: deckRejection(graph, node, nodesDir, denylist) }));
}

// 덱 후보 id 를 정렬해 돌려준다.
function listDeckCandidates({ graph, nodesDir = NODES_DIR, denylist = new Set() }) {
  return deckVerdicts({ graph, nodesDir, denylist })
    .filter((v) => v.reason === null)
    .map((v) => v.id)
    .sort();
}

// sprites/packs 의 팩 디렉터리 이름(점으로 시작하는 것은 뺌)을 정렬해 돌려준다.
function packDirNames(packsDir) {
  if (!fs.existsSync(packsDir)) return [];
  return fs
    .readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

// 후보와 실제 팩 디렉터리를 비교한다. newIds 는 후보인데 팩이 없는 것, extraPacks 는 팩인데 후보가 아닌 것.
function comparePacks(candidates, packNames) {
  const candidateSet = new Set(candidates);
  const packSet = new Set(packNames);
  return {
    newIds: candidates.filter((id) => !packSet.has(id)),
    extraPacks: packNames.filter((name) => !candidateSet.has(name))
  };
}

function printReport(verdicts, candidates, packNames, diff, denylistSize) {
  const dropped = verdicts.filter((v) => v.reason !== null);
  process.stdout.write('성장기 덱 후보 판정 (규칙 a~d, C5)\n');
  process.stdout.write(`제외 목록 ${denylistSize}건\n`);
  process.stdout.write(`후보 ${candidates.length}종 / 기존 팩 ${packNames.length}종 / 신규 ${diff.newIds.length}종\n`);
  process.stdout.write(`신규(sprites/packs 에 없는 후보): ${diff.newIds.join(', ') || '없음'}\n`);
  process.stdout.write('탈락:\n');
  for (const v of dropped) process.stdout.write(`  ${v.id}\t${v.reason}\n`);
  if (diff.extraPacks.length > 0) {
    process.stdout.write(`경고: 규칙에서 탈락한 기존 팩 ${diff.extraPacks.length}개(삭제하지 않는다, D-4): ${diff.extraPacks.join(', ')}\n`);
  }
  if (diff.newIds.length > 0) {
    process.stdout.write('불일치: 신규 후보의 팩이 아직 없다. node scripts/add-deck-packs.js --write 를 실행하라.\n');
  }
}

function main() {
  const graph = indexGraph(JSON.parse(fs.readFileSync(graphFilePath(), 'utf8')).nodes);
  const denylist = readNodeDenylist();
  const verdicts = deckVerdicts({ graph, nodesDir: NODES_DIR, denylist });
  const candidates = verdicts.filter((v) => v.reason === null).map((v) => v.id).sort();
  const packNames = packDirNames(defaultPacksDir());
  const diff = comparePacks(candidates, packNames);
  printReport(verdicts, candidates, packNames, diff, denylist.size);
  const mismatch = diff.newIds.length > 0 || diff.extraPacks.length > 0;
  process.exit(mismatch ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  indexGraph,
  deckVerdicts,
  listDeckCandidates,
  packDirNames,
  comparePacks,
  NODES_DIR
};
