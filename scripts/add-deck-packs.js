#!/usr/bin/env node
// 성장기 덱 신규 팩 생성(C5, D-6). scripts/audit-deck-candidates.js 의 후보 중
// sprites/packs/<id>/ 가 아직 없는 것마다 팩 디렉터리를 만든다.
//
//   idle-0.png, idle-1.png: sprites/nodes/<id>-0.png, -1.png 의 복사(기본안: child 도트).
//     -1 도트가 없으면 -0 을 복사하고 idle1Fallback 으로 보고한다.
//   pack.json: { name, stageNames: { child } } 최소형. 레거시 tree 는 넣지 않는다.
//     디렉터리명이 그래프 노드 id 라서 listRotationPacks 의 graph.byId 경로로 덱에 든다.
//
// 이미 있고 내용이 같으면 건너뛴다(skip). 내용이 다르면 덮어쓰지 않고 conflict 로 보고하며
// 종료 코드 1 로 끝난다.
//
// 실행: node scripts/add-deck-packs.js          (dry run, 무엇을 만들지만 출력)
//       node scripts/add-deck-packs.js --write  (실제 생성)
// 만든 idle-*.png 는 .gitignore 대상이라 git add -f 가 필요하다. 커밋은 사람 몫이다.

const fs = require('fs');
const path = require('path');

const { graphFilePath, defaultPacksDir, readNodeDenylist } = require('../lib/daily');
const { indexGraph, listDeckCandidates, packDirNames, NODES_DIR } = require('./audit-deck-candidates');

// 노드 하나의 팩 파일 내용을 계획한다. idle1Fallback 은 -1 도트가 없어 -0 을 썼다는 뜻이다.
function packPlan(node, nodesDir) {
  const frame0 = fs.readFileSync(path.join(nodesDir, `${node.sprite}-0.png`));
  const frame1Path = path.join(nodesDir, `${node.sprite}-1.png`);
  const hasFrame1 = fs.existsSync(frame1Path);
  const frame1 = hasFrame1 ? fs.readFileSync(frame1Path) : frame0;
  const packJson = `${JSON.stringify({ name: node.name, stageNames: { child: node.name } }, null, 2)}\n`;
  return {
    idle1Fallback: !hasFrame1,
    files: {
      'idle-0.png': frame0,
      'idle-1.png': frame1,
      'pack.json': Buffer.from(packJson, 'utf8')
    }
  };
}

function fileEquals(filePath, buf) {
  return fs.existsSync(filePath) && fs.readFileSync(filePath).equals(buf);
}

// create: 디렉터리가 없거나 비었다. skip: 계획한 파일이 모두 같다. conflict: 다른 내용이 있다.
function packAction(dir, files) {
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) return 'create';
  const same = Object.entries(files).every(([name, buf]) => fileEquals(path.join(dir, name), buf));
  return same ? 'skip' : 'conflict';
}

function writePackFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
}

// ids 각각을 처리해 [{ id, action, idle1Fallback }] 를 돌려준다. write 가 false 면 파일을 쓰지 않는다.
function writeDeckPacks({ ids, graph, nodesDir = NODES_DIR, packsDir, write }) {
  return ids.map((id) => {
    const plan = packPlan(graph.byId.get(id), nodesDir);
    const dir = path.join(packsDir, id);
    const action = packAction(dir, plan.files);
    if (action === 'create' && write) writePackFiles(dir, plan.files);
    return { id, action, idle1Fallback: action === 'create' && plan.idle1Fallback };
  });
}

function main() {
  const write = process.argv.includes('--write');
  const graph = indexGraph(JSON.parse(fs.readFileSync(graphFilePath(), 'utf8')).nodes);
  const candidates = listDeckCandidates({ graph, nodesDir: NODES_DIR, denylist: readNodeDenylist() });
  const existing = new Set(packDirNames(defaultPacksDir()));
  const ids = candidates.filter((id) => !existing.has(id));
  const results = writeDeckPacks({ ids, graph, nodesDir: NODES_DIR, packsDir: defaultPacksDir(), write });

  process.stdout.write(write ? 'sprites/packs 신규 팩 생성\n' : 'dry run (--write 로 실제 생성)\n');
  for (const r of results) {
    const note = r.idle1Fallback ? '  (idle-1 도트 없음: -0 복사)' : '';
    process.stdout.write(`  ${r.id}\t${r.action}${note}\n`);
  }
  const counts = { create: 0, skip: 0, conflict: 0 };
  for (const r of results) counts[r.action] += 1;
  process.stdout.write(`생성 ${counts.create} / 건너뜀 ${counts.skip} / 충돌 ${counts.conflict}\n`);
  if (write) process.stdout.write('idle-*.png 는 git add -f 가 필요하다. git add 는 하지 않는다.\n');
  process.exit(counts.conflict > 0 ? 1 : 0);
}

if (require.main === module) main();

module.exports = { writeDeckPacks, packPlan };
