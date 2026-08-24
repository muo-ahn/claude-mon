#!/usr/bin/env node
// 팩별 도트 → 전역 sprites/nodes/ 일회성 마이그레이션.
//
// docs/global-graph-plan.md §B-2 도트 분리의 첫 단계다. pack.json 의 tree 에서
// (팩, 레거시 접두사) → 노드 id 매핑을 뽑아, 팩 디렉터리의 도트를 sprites/nodes/
// 로 복사한다. 원본은 그대로 남아 구형 daily.json 이 살아 있는 동안 화면이
// 깨지지 않는다.
//
// 실행: node scripts/collect-node-sprites.js [--write]
//   --write 없이는 dry run (무엇을 몇 장 복사할지만 출력).
//
// 멱등하다. 같은 파일이 이미 있으면 건너뛴다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'sprites', 'packs');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');
const TREE_PATH = path.join(ROOT, 'evolution-tree.json');

// 파일 바이트 해시. 같은 노드가 여러 팩에 있고 해시가 다르면 실패시킨다 —
// 어느 쪽이 정본인지 사람이 프레임을 봐야 한다.
function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function stageIds() {
  return JSON.parse(fs.readFileSync(TREE_PATH, 'utf8')).stages.map((s) => s.id);
}

function listPacks() {
  return fs
    .readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(PACKS_DIR, name, 'pack.json')))
    .sort();
}

// 팩별 노드에서 (노드 id, 프레임 번호, 파일 종류) → 소스 파일 경로 매핑 구성.
// 파일 종류는 'sprite' 또는 'portrait'. 같은 노드가 여러 팩에 있고 해시가
// 다르면 충돌로 기록한다.
function collectSources(packs, stages) {
  const sources = new Map(); // key: `${nodeId}|${frameNum}|${kind}` → [{ pack, path, hash }]
  const conflicts = [];
  let totalEntries = 0;
  const skipped = { digitama: 0 };
  const missing = [];

  for (const pack of packs) {
    const packDir = path.join(PACKS_DIR, pack);
    const raw = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
    const tree = raw.tree;
    if (!tree || typeof tree !== 'object') continue;

    for (const stage of stages) {
      for (const node of tree[stage] || []) {
        // digitama 는 sharedStages — sprites/shared/digitama-0.png 에서 읽는다.
        // sprites/nodes/ 로 복사하지 않는다.
        if (node.id === 'digitama') {
          skipped.digitama++;
          continue;
        }

        const prefix = node.sprite;
        // 프레임 0, 1 시도. 프레임 하나도 없는 노드는 missing 에 기록한다.
        let found = false;
        for (let i = 0; i <= 1; i++) {
          const spriteFile = path.join(packDir, `${prefix}-${i}.png`);
          if (fs.existsSync(spriteFile)) {
            const key = `${node.id}|${i}|sprite`;
            const hash = hashFile(spriteFile);
            if (!sources.has(key)) sources.set(key, []);
            sources.get(key).push({ pack, path: spriteFile, hash });
            totalEntries++;
            found = true;
          }

          // 초상은 일부 노드에만 있다. 없으면 조용히 건너뛴다.
          const portraitFile = path.join(packDir, `portrait-${prefix}-${i}.png`);
          if (fs.existsSync(portraitFile)) {
            const key = `${node.id}|${i}|portrait`;
            const hash = hashFile(portraitFile);
            if (!sources.has(key)) sources.set(key, []);
            sources.get(key).push({ pack, path: portraitFile, hash });
            totalEntries++;
            found = true;
          }
        }
        if (!found) {
          missing.push(`${node.id} (${pack}/${prefix})`);
        }
      }
    }
  }

  // 같은 키에 소스가 여러 개고 해시가 다르면 충돌.
  for (const [key, srcs] of sources.entries()) {
    if (srcs.length <= 1) continue;
    const hashes = new Set(srcs.map((s) => s.hash));
    if (hashes.size > 1) {
      conflicts.push({
        key,
        sources: srcs.map((s) => `${s.pack} (${s.hash}): ${s.path}`),
      });
    }
  }

  return { sources, conflicts, totalEntries, skipped, missing };
}

// 채택된 소스 하나를 sprites/nodes/ 로 복사한다. 멱등 — 대상이 이미 있고
// 내용이 같으면 건너뛴다.
function copyToNodes(nodeId, frameNum, kind, sourcePath, write) {
  const fileName = kind === 'portrait' ? `portrait-${nodeId}-${frameNum}.png` : `${nodeId}-${frameNum}.png`;
  const destPath = path.join(NODES_DIR, fileName);

  if (fs.existsSync(destPath)) {
    const srcHash = hashFile(sourcePath);
    const dstHash = hashFile(destPath);
    if (srcHash === dstHash) return { action: 'skip', destPath };
  }

  if (write) {
    fs.mkdirSync(NODES_DIR, { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  }
  return { action: 'copy', destPath };
}

function main() {
  const write = process.argv.includes('--write');
  const stages = stageIds();
  const packs = listPacks();
  const { sources, conflicts, totalEntries, skipped, missing } = collectSources(packs, stages);

  console.log(`팩 ${packs.length}개 → sprites/nodes/ 도트 수집\n`);
  console.log(`  팩별 엔트리:   ${totalEntries}`);
  console.log(`  고유 키:       ${sources.size}`);
  console.log(`  건너뜀:        digitama ${skipped.digitama}개 (sharedStages)`);
  if (missing.length > 0) {
    console.log(`  누락 노드:     ${missing.length}개 (프레임 0장)`);
    for (const m of missing.slice(0, 5)) console.log(`    ${m}`);
    if (missing.length > 5) console.log(`    ... 외 ${missing.length - 5}개`);
  }

  if (conflicts.length > 0) {
    console.log('\n치명적 해시 충돌 — 어느 쪽이 정본인지 사람이 프레임을 봐야 한다:');
    for (const c of conflicts) {
      console.log(`  ${c.key}:`);
      for (const s of c.sources) console.log(`    ${s}`);
    }
    console.error('\n해시가 다른 파일이 있다. 실패.');
    process.exit(1);
  }

  // 각 키에서 첫 소스를 채택한다 (해시가 같으므로 어느 것이든 무방).
  const actions = [];
  for (const [key, srcs] of sources.entries()) {
    const [nodeId, frameNum, kind] = key.split('|');
    const result = copyToNodes(nodeId, parseInt(frameNum, 10), kind, srcs[0].path, write);
    actions.push({ ...result, key });
  }

  const copied = actions.filter((a) => a.action === 'copy').length;
  const skippedFiles = actions.filter((a) => a.action === 'skip').length;

  console.log(`\n결과:`);
  console.log(`  복사:   ${copied}`);
  console.log(`  건너뜀: ${skippedFiles} (이미 있고 내용 같음)`);

  if (!write) {
    console.log('\ndry run (--write 로 실제 복사)');
  } else {
    console.log(`\n작성: ${path.relative(ROOT, NODES_DIR)}/ (파일 ${copied + skippedFiles})`);
  }
}

main();
