#!/usr/bin/env node
// Usage: node scripts/tree-status.js [--verbose]
//
// What the evolution trees currently look like on THIS machine, and why
// each pack is or isn't in the daily rotation.
//
// This exists because the interesting state is invisible from git: dots are
// gitignored (see .gitignore), so a node's name lands in pack.json long
// before its sprite lands on disk, and pruneTree silently drops the
// difference. Without this script "why did 임프몬 never show up" is a
// question you answer by reading code.
//
// Columns:
//   ROTATION - in the daily draw (listRotationPacks), or the reason it isn't
//   CEILING  - the pack's top stage: its own "topStage" or the tree's last
//   ROUTES   - distinct walks from egg to ceiling that survive pruning
//
// Under --verbose each pack also lists the nodes pruning removed and why,
// which is the work-list for filling a line in (docs/evolution-routes.md §6).

const fs = require('fs');
const path = require('path');

const {
  listValidPacks,
  listRotationPacks,
  packTopStage,
  defaultPacksDir,
  defaultSharedDir,
  minCeilingId,
  readTree
} = require('../lib/daily');
const { TREE } = require('../lib/evolve');

const verbose = process.argv.includes('--verbose');
const packsDir = defaultPacksDir();
const sharedDir = defaultSharedDir();
const STAGES = TREE.stages.map((s) => s.id);

function hasDot(pack, sprite) {
  if (!sprite) return false;
  return (
    fs.existsSync(path.join(packsDir, pack, `${sprite}-0.png`)) ||
    fs.existsSync(path.join(sharedDir, `${sprite}-0.png`))
  );
}

function readRawTree(pack) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packsDir, pack, 'pack.json'), 'utf8')).tree || null;
  } catch (e) {
    return null;
  }
}

// Every egg-to-ceiling walk the pruned tree allows. Counting these rather
// than multiplying branch factors keeps the number honest when a branch
// rejoins the spine (오메가몬 is reached from two different 궁극체).
function countRoutes(tree, stages) {
  // A route ends wherever `next` runs out, which under the minimum-ceiling
  // rule may be before the last stage the pack has. Counting only paths that
  // reach the final stage would undercount every short line.
  const minIdx = STAGES.indexOf(minCeilingId());
  const stageOf = new Map();
  const byId = new Map();
  for (const stage of stages) {
    for (const node of tree[stage] || []) {
      stageOf.set(node.id, STAGES.indexOf(stage));
      byId.set(node.id, node);
    }
  }
  let count = 0;
  const walk = (id) => {
    const next = (byId.get(id).next || []).filter((x) => byId.has(x));
    if (next.length === 0) {
      if (stageOf.get(id) >= minIdx) count += 1;
      return;
    }
    for (const to of next) walk(to);
  };
  for (const node of tree[stages[0]] || []) walk(node.id);
  return count;
}

// Why a node didn't make it: no dots of its own, or nothing left to become.
function explainPruned(pack, raw, pruned, stages) {
  const kept = new Set();
  for (const stage of stages) for (const n of (pruned || {})[stage] || []) kept.add(n.id);
  const notes = [];
  for (const stage of stages) {
    for (const node of raw[stage] || []) {
      if (kept.has(node.id)) continue;
      const why = !hasDot(pack, node.sprite)
        ? `도트 없음 (${node.sprite}-0.png)`
        : stage === stages[stages.length - 1]
          ? '천장인데 제외됨'
          : (node.next || []).length === 0
            ? '후속 없음 (막다른 분기)'
            : '경로가 천장까지 못 이어짐';
      notes.push(`      - ${stage}/${node.id} (${node.name}): ${why}`);
    }
  }
  return notes;
}

const rotation = new Set(listRotationPacks(packsDir, sharedDir));
const rows = [];
let totalRoutes = 0;

for (const pack of listValidPacks(packsDir, sharedDir)) {
  const ceiling = packTopStage(packsDir, pack);
  const stages = STAGES.slice(0, STAGES.indexOf(ceiling) + 1);
  const raw = readRawTree(pack);
  const pruned = raw ? readTree(packsDir, pack, sharedDir) : null;
  const routes = pruned ? countRoutes(pruned, stages) : 0;
  if (rotation.has(pack)) totalRoutes += routes;

  const status = rotation.has(pack) ? '있음' : `없음 (${ceiling} 미선언)`;

  rows.push({
    pack,
    status,
    ceiling,
    // No tree at all is not a defect: the pack renders its stageNames line
    // straight through, which is the R7 fallback and what most packs do.
    routes: !raw ? '— (stageNames 고정선)' : pruned ? String(routes) : '0 (경로 없음)',
    notes: raw ? explainPruned(pack, raw, pruned, stages) : []
  });
}

const w = Math.max(...rows.map((r) => r.pack.length), 4);
console.log(`${'PACK'.padEnd(w)}  ${'ROTATION'.padEnd(22)}  ${'CEILING'.padEnd(14)}  ROUTES`);
console.log('-'.repeat(w + 52));
for (const r of rows) {
  console.log(`${r.pack.padEnd(w)}  ${r.status.padEnd(22)}  ${r.ceiling.padEnd(14)}  ${r.routes}`);
  if (verbose && r.notes.length > 0) {
    console.log('    추첨에서 빠진 노드:');
    for (const n of r.notes) console.log(n);
  }
}
console.log('-'.repeat(w + 52));
console.log(`로테이션 ${rotation.size}팩 / 유효 ${rows.length}팩, 하루 루트 합계 ${totalRoutes}개`);
