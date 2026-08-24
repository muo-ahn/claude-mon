#!/usr/bin/env node
// sprites/nodes/ → sprites/packs/*/  도트 구체화(materialize).
//
// docs/global-graph-plan.md §B-2 도트 분리의 두 번째 단계다. evolution-graph.json
// + sprites/nodes/ 만 입력으로, 각 팩이 필요한 노드의 도트를 그 팩 디렉터리로
// 복사한다. 메뉴바가 <팩 디렉터리>/<노드 id>-N.png 를 읽으므로, 구형
// 바이너리까지 무손상이다.
//
// 팩이 필요한 노드 = 그 팩의 로키 노드(디렉터리명 = child 스테이지 노드 id)의
// 조상 + 모든 후손. 후손은 evolvesFrom 역인덱스로 파생한다 — 전역이 되면
// 라인이 팩 경계를 넘는다(예: 케라몬 라인이 임프몬 팩의 베르제브몬 블래스트
// 모드에 닿는다).
//
// 실행: node scripts/materialize-sprites.js [--write]
//   --write 없이는 dry run (무엇을 몇 장 복사할지만 출력).
//
// 멱등하다. 이미 있고 내용이 같으면 건너뛴다. 다르면 덮어쓴다 —
// sprites/nodes/ 가 정본이다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'sprites', 'packs');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function listPacks() {
  return fs
    .readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(PACKS_DIR, name, 'pack.json')))
    .sort();
}

// 전역 그래프를 로드하고 역인덱스(부모 id → 자식 노드 배열)를 구성한다.
function loadGraph() {
  const raw = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const nodes = raw.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();

  for (const node of nodes) {
    for (const link of node.evolvesFrom) {
      if (!childrenOf.has(link.from)) childrenOf.set(link.from, []);
      childrenOf.get(link.from).push(node);
    }
  }

  return { nodes, byId, childrenOf };
}

// 노드의 모든 조상을 재귀로 수집한다.
function ancestors(nodeId, byId, acc = new Set()) {
  if (acc.has(nodeId)) return acc;
  acc.add(nodeId);
  const node = byId.get(nodeId);
  if (!node) return acc;
  for (const link of node.evolvesFrom) {
    ancestors(link.from, byId, acc);
  }
  return acc;
}

// 노드의 모든 후손을 재귀로 수집한다.
function descendants(nodeId, childrenOf, acc = new Set()) {
  if (acc.has(nodeId)) return acc;
  acc.add(nodeId);
  const kids = childrenOf.get(nodeId) || [];
  for (const kid of kids) {
    descendants(kid.id, childrenOf, acc);
  }
  return acc;
}

// 팩이 필요한 노드 집합 = 로키의 조상 + 모든 후손.
function nodesForPack(pack, byId, childrenOf) {
  // 디렉터리명이 로키(child 스테이지) 노드 id 와 일치한다.
  const rookie = byId.get(pack);
  if (!rookie || rookie.stage !== 'child') {
    return { error: `로키 노드를 찾을 수 없다: ${pack} (디렉터리명이 child 스테이지 노드 id 여야 한다)` };
  }

  const needed = new Set();
  // 조상 (로키 포함)
  for (const id of ancestors(pack, byId)) needed.add(id);
  // 후손 (로키 포함이므로 중복이지만 Set 가 걸러낸다)
  for (const id of descendants(pack, childrenOf)) needed.add(id);

  return { rookie, needed: Array.from(needed).sort() };
}

// 노드 하나의 프레임 파일을 팩 디렉터리로 복사한다. 멱등 — 이미 있고 내용이
// 같으면 건너뛴다. 다르면 덮어쓴다.
function materializeNode(pack, nodeId, write) {
  const packDir = path.join(PACKS_DIR, pack);
  const actions = [];

  for (let i = 0; i <= 1; i++) {
    for (const kind of ['sprite', 'portrait']) {
      const srcName = kind === 'portrait' ? `portrait-${nodeId}-${i}.png` : `${nodeId}-${i}.png`;
      const srcPath = path.join(NODES_DIR, srcName);
      if (!fs.existsSync(srcPath)) continue;

      const dstPath = path.join(packDir, srcName);
      let action = 'copy';
      if (fs.existsSync(dstPath)) {
        const srcHash = hashFile(srcPath);
        const dstHash = hashFile(dstPath);
        if (srcHash === dstHash) {
          action = 'skip';
        } else {
          action = 'overwrite';
        }
      }

      if (action !== 'skip' && write) {
        fs.copyFileSync(srcPath, dstPath);
      }
      actions.push({ nodeId, frame: i, kind, action, srcPath, dstPath });
    }
  }
  return actions;
}

function main() {
  const write = process.argv.includes('--write');
  const packs = listPacks();
  const { byId, childrenOf } = loadGraph();

  console.log(`sprites/nodes/ → sprites/packs/*/  도트 구체화\n`);

  const allActions = [];
  const errors = [];
  for (const pack of packs) {
    const result = nodesForPack(pack, byId, childrenOf);
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    console.log(`${pack}: 로키 ${result.rookie.name}, 필요 노드 ${result.needed.length}개`);

    for (const nodeId of result.needed) {
      const actions = materializeNode(pack, nodeId, write);
      allActions.push(...actions);
    }
  }

  if (errors.length > 0) {
    console.log('\n오류:');
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }

  const copy = allActions.filter((a) => a.action === 'copy').length;
  const overwrite = allActions.filter((a) => a.action === 'overwrite').length;
  const skip = allActions.filter((a) => a.action === 'skip').length;

  console.log(`\n결과:`);
  console.log(`  복사:     ${copy}`);
  console.log(`  덮어쓰기: ${overwrite} (sprites/nodes/ 가 정본)`);
  console.log(`  건너뜀:   ${skip} (이미 있고 내용 같음)`);

  if (!write) {
    console.log('\ndry run (--write 로 실제 복사)');
  } else {
    console.log(`\n작성: sprites/packs/*/ (파일 ${copy + overwrite})`);
  }
}

main();
