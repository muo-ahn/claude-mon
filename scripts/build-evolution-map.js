#!/usr/bin/env node
// 진화 맵 HTML 렌더러. sprites/packs/*/pack.json 트리 + 32x32 도트(PNG를 base64로
// 인라인) + docs/*.yaml 카탈로그, 이 두 데이터 층을 저장소에서 그대로 읽어 단일
// 정적 HTML 페이지로 그린다. 화면 절반은 "지금 도는 트리"(팩 트리를 그래프로),
// 나머지 절반은 "계보 카탈로그"(namu.wiki 진화도 + 도트 확보 현황)다.
//
// 사용법: node scripts/build-evolution-map.js [출력경로]
//   출력경로 생략 시 docs/evolution-map.html 에 쓴다.
//
// 의존성: python3 + PyYAML (docs/*.yaml 파싱을 파이썬에 위임하고, 결과를 JSON으로
// stdout에 실어 node가 받는다 — 이 리포에 YAML 파서를 새로 들이지 않기 위함).
//
// 산출 HTML은 도트 PNG를 base64로 통째로 인라인하므로 수백 KB 이상이 나온다.
// 커밋 대상이 아니라 매번 재생성해서 보는 산출물이라 .gitignore 에 올린다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizeNode, validatePackTree } = require('../lib/daily');

const REPO = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(REPO, 'docs', 'evolution-map.html');
const PACKS = path.join(REPO, 'sprites/packs');
const SHARED = path.join(REPO, 'sprites/shared');

// docs/*.yaml are the second layer: the namu.wiki lineage catalogue and the
// dot-status scan over it. Dumped to JSON on stdout here so the rest of the
// build is plain node.
const CATALOG = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      `
import sys, yaml, json
lines = yaml.safe_load(open(sys.argv[1]))
status = yaml.safe_load(open(sys.argv[2]))
json.dump({'meta': lines['meta'], 'lines': lines['lines'], 'byLine': status['by_line'],
           'species': status['species'], 'summary': status['summary']},
          sys.stdout, ensure_ascii=False, default=str)
`,
      path.join(REPO, 'docs/digimon-evolution-lines.yaml'),
      path.join(REPO, 'docs/sprite-status.yaml'),
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
);

const TREE = JSON.parse(fs.readFileSync(path.join(REPO, 'evolution-tree.json'), 'utf8'));
const STAGES = TREE.stages;
const TOP = STAGES[STAGES.length - 1].id;

const GUTTER = 148;
const COL_W = 150;
const NODE_W = 134;
const SPRITE = 64;
const ROW = 108;
const PAD_TOP = 14;
const PAD_BOTTOM = 12;
const NARROW_SCALE = 0.8; // the stage ladder shrinks rather than getting wider on phones

function dataUri(file) {
  if (!file || !fs.existsSync(file)) return null;
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

function spriteFor(pack, node, stageId) {
  const own = path.join(PACKS, pack, `${node.sprite}-0.png`);
  if (fs.existsSync(own)) return dataUri(own);
  if (stageId === 'digitama') return dataUri(path.join(SHARED, 'digitama-0.png'));
  return null;
}

function readPacks() {
  return fs
    .readdirSync(PACKS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .map((dir) => {
      const j = JSON.parse(fs.readFileSync(path.join(PACKS, dir, 'pack.json'), 'utf8'));
      const rawTree = j.tree || {};
      // Same next-to-evolutions normalization lib/daily.js's readTree applies,
      // reused directly rather than re-derived so the two can't drift. Unlike
      // readTree this doesn't require every TREE.stages to be present - a
      // partial pack (가오몬) still needs a tree to render its lane.
      const tree = {};
      for (const stageId of Object.keys(rawTree)) {
        tree[stageId] = rawTree[stageId].map(normalizeNode);
      }
      const stages = STAGES.map((s) => s.id).filter((id) => Array.isArray(tree[id]) && tree[id].length);
      const nodes = new Map();
      for (const stageId of stages) {
        tree[stageId].forEach((n, i) => {
          nodes.set(n.id, {
            ...n,
            stageId,
            row: i,
            spine: i === 0,
            dot: spriteFor(dir, n, stageId),
            next: n.evolutions.map((e) => e.to),
          });
        });
      }
      const topDeclared = stages[stages.length - 1];
      const rotation = Boolean(
        j.stageNames && typeof j.stageNames[TOP] === 'string' && j.stageNames[TOP].trim()
      );
      const invalid = validatePackTree(tree);
      return { dir, name: j.name || dir, tree, stages, nodes, topDeclared, rotation, invalid };
    });
}

// A node counts as reachable only if an evolutions chain carries it to the
// pack's last declared stage AND every dot on that chain exists.
function markReachable(pack) {
  const order = [...pack.stages].reverse();
  for (const stageId of order) {
    for (const node of pack.tree[stageId].map((n) => pack.nodes.get(n.id))) {
      if (!node.dot) {
        node.reaches = false;
        continue;
      }
      if (stageId === pack.topDeclared) {
        node.reaches = true;
        continue;
      }
      node.reaches = node.next.some((id) => pack.nodes.get(id)?.reaches);
    }
  }
}

// A node with no incoming edge from anywhere in the pack can never be drawn
// (no path from the egg reaches it), even though it's declared and may have
// a dot. validatePackTree doesn't check this - it walks each node's own
// outgoing edges, not who points at it - so orphans are a map-only concern.
function markOrphans(pack) {
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const next of pack.nodes.get(id).next) if (pack.nodes.has(next)) visit(next);
  };
  visit(pack.tree[pack.stages[0]][0].id);
  for (const node of pack.nodes.values()) node.orphan = !seen.has(node.id);
}

// Every node's own evolutions list, flattened to {from, to, when} triples.
// No more synthetic edges here - decision C retired the spine-return
// fallback lib/daily.js used to synthesize for dead ends, so what a pack
// declares is exactly what the rotation walks.
function edgesFor(pack) {
  const edges = [];
  for (const stageId of pack.stages) {
    for (const n of pack.tree[stageId]) {
      for (const e of n.evolutions) {
        if (pack.nodes.get(e.to)) edges.push({ from: n.id, to: e.to, when: e.when });
      }
    }
  }
  return edges;
}

function countRoutes(pack) {
  const out = new Map();
  for (const e of edgesFor(pack)) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const memo = new Map();
  const walk = (id) => {
    if (memo.has(id)) return memo.get(id);
    const node = pack.nodes.get(id);
    let n;
    if (node.stageId === pack.topDeclared) n = 1;
    else n = (out.get(id) || []).reduce((sum, next) => sum + walk(next), 0);
    memo.set(id, n);
    return n;
  };
  return walk(pack.tree[pack.stages[0]][0].id);
}

// Short human label for an edge's `when`, for the map only - not a full
// restatement of conditionMet's semantics. `all`/`and` join with '·';
// unconditional edges render no label at all (edge() skips them).
const CONDITION_LABEL = {
  sessionCount: 'sessionCount',
  topSharePct: 'topShare%',
  failureRatioPct: 'failRatio%',
  dailyOutputTokens: 'tokens',
  toolSuccessCount: 'toolSuccess',
  globalToolSuccessCount: 'globalToolSuccess',
  errorRatePct: 'errRate%',
  consecutiveDaysActive: 'daysActive'
};

function conditionLabel(when) {
  if (when === null || when === undefined) return null;
  if (Array.isArray(when.all)) return when.all.map(conditionLabel).filter(Boolean).join(' · ');
  const parts = [];
  const base = CONDITION_LABEL[when.type] || when.type;
  if (when.gte !== undefined) parts.push(`${base}≥${when.gte}`);
  if (when.lte !== undefined) parts.push(`${base}≤${when.lte}`);
  if (parts.length === 0) parts.push(base);
  if (when.and) parts.push(conditionLabel(when.and));
  return parts.join(' · ');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Korean names run long ("황제드라몬 파이터 모드"); wrap on spaces, then hard-wrap.
function wrapName(name) {
  const lines = [];
  let line = '';
  for (const word of name.split(' ')) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= 10) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).map((l) => (l.length > 12 ? l.slice(0, 11) + '…' : l));
}

function colX(i) {
  return i * COL_W + (COL_W - NODE_W) / 2;
}

function nodeGeom(pack, node) {
  const i = pack.stages.indexOf(node.stageId);
  const x = colX(i);
  const y = PAD_TOP + node.row * ROW;
  return { x, y, cx: x + NODE_W / 2, cy: y + SPRITE / 2, left: x + (NODE_W - SPRITE) / 2, right: x + (NODE_W + SPRITE) / 2 };
}

function renderPack(pack) {
  markReachable(pack);
  markOrphans(pack);
  const edges = edgesFor(pack);
  const maxRow = Math.max(...[...pack.nodes.values()].map((n) => n.row));
  const height = PAD_TOP + maxRow * ROW + SPRITE + 30 + PAD_BOTTOM;
  const width = STAGES.length * COL_W;

  const edge = (e) => {
    const A = nodeGeom(pack, pack.nodes.get(e.from));
    const B = nodeGeom(pack, pack.nodes.get(e.to));
    const x1 = A.right + 5;
    const x2 = B.left - 5;
    const mid = x1 + (x2 - x1) / 2;
    const label = conditionLabel(e.when);
    const path = `<path class="${label ? 'e-cond' : 'e-real'}" d="M${x1} ${A.cy} C${mid} ${A.cy} ${mid} ${B.cy} ${x2} ${B.cy}" />`;
    const text = label ? `<text class="e-label" x="${mid}" y="${(A.cy + B.cy) / 2 - 4}">${esc(label)}</text>` : '';
    return path + text;
  };

  const nodeSvg = (node) => {
    const g = nodeGeom(pack, node);
    const cls = ['node', node.reaches ? 'reaches' : 'stalls', node.spine ? 'spine' : 'branch', node.orphan ? 'orphan' : ''].join(' ');
    const frame = node.dot
      ? `<rect class="cell" x="${g.left - 5}" y="${g.y - 5}" width="${SPRITE + 10}" height="${SPRITE + 10}" rx="3" />
         <image href="${node.dot}" x="${g.left}" y="${g.y}" width="${SPRITE}" height="${SPRITE}" />`
      : `<rect class="cell empty" x="${g.left - 5}" y="${g.y - 5}" width="${SPRITE + 10}" height="${SPRITE + 10}" rx="3" />
         <text class="nodot" x="${g.cx}" y="${g.y + SPRITE / 2 + 4}">도트 없음</text>`;
    const lines = wrapName(node.name)
      .map((l, i) => `<tspan x="${g.cx}" dy="${i === 0 ? 0 : 12}">${esc(l)}</tspan>`)
      .join('');
    return `<g class="${cls}">${frame}<text class="name" x="${g.cx}" y="${g.y + SPRITE + 15}">${lines}</text></g>`;
  };

  const nodes = [...pack.nodes.values()];
  const dotless = nodes.filter((n) => !n.dot).length;
  const orphans = nodes.filter((n) => n.orphan).length;
  const chips = [
    pack.rotation
      ? '<span class="chip on">로테이션 후보</span>'
      : `<span class="chip off">제외 · ${esc(STAGES.find((s) => s.id === pack.topDeclared).label.split(' (')[0])}까지</span>`,
    `<span class="chip q">루트 ${countRoutes(pack)}</span>`,
    pack.invalid.length ? `<span class="chip bad">INVALID ${pack.invalid.length}</span>` : '',
    dotless ? `<span class="chip warn">도트 ${dotless}개 미비</span>` : '',
    orphans ? `<span class="chip warn">부모 없음 ${orphans}</span>` : '',
  ].join('');

  return `<section class="lane">
    <div class="lane-head">
      <h3>${esc(pack.name)}</h3>
      <p class="slug">${esc(pack.dir)}</p>
      <div class="chips">${chips}</div>
    </div>
    <svg class="graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
         aria-label="${esc(pack.name)} 진화 트리">
      <g class="edges">${edges.map(edge).join('')}</g>
      ${nodes.map(nodeSvg).join('\n      ')}
    </svg>
</section>`;
}

const CAT_STAGES = [
  { key: 'baby1', ko: '유아기 1', en: 'baby I' },
  { key: 'baby2', ko: '유아기 2', en: 'baby II' },
  { key: 'child', ko: '성장기', en: 'child' },
  { key: 'adult', ko: '성숙기', en: 'adult' },
  { key: 'perfect', ko: '완전체', en: 'perfect' },
  { key: 'ultimate', ko: '궁극체', en: 'ultimate' },
  { key: 'superultimate', ko: '초궁극체', en: 'super ult.' },
];

// Every dot the repo has, keyed pack/sprite - the join between the catalogue
// (docs/*.yaml, names) and what a pack tree actually walks (sprite prefixes).
function treeSpriteIndex(packs) {
  const index = new Map();
  for (const pack of packs) {
    for (const node of pack.nodes.values()) index.set(`${pack.dir}/${node.sprite}`, node);
  }
  return index;
}

function speciesIndex() {
  const index = new Map();
  for (const sp of CATALOG.species) index.set(`${sp.line}|${sp.ko}`, sp);
  return index;
}

// One of: wired (in a pack tree), mismatch (wired but the art is the wrong
// species), sheet (DWDS sheet only), none (nothing yet), untracked (a form
// the status scanner doesn't cover - armour and jogress live outside stages).
function formState(lineId, name, species, treeSprites) {
  const sp = species.get(`${lineId}|${name}`);
  if (!sp) return 'untracked';
  const wired = sp.pack && sp.sprite && treeSprites.has(`${sp.pack}/${sp.sprite}`);
  if (sp.dot === 'mismatch') return wired ? 'mismatch' : 'none';
  if (wired) return 'wired';
  if (sp.dot === 'ready') return 'dot';
  if (sp.dot === 'source_only') return 'sheet';
  return 'none';
}

const STATE_TITLE = {
  wired: '팩 트리에 편입 · 화면에 나옴',
  mismatch: '도트는 있으나 그림이 다른 종',
  dot: '도트만 있음 · 트리 미편입',
  sheet: 'DWDS 시트만 확보',
  none: '아직 없음',
  untracked: '스캐너 대상 밖 (아머체·조그레스)',
};

function renderCatalog(packs) {
  const treeSprites = treeSpriteIndex(packs);
  const species = speciesIndex();
  const byLine = new Map(CATALOG.byLine.map((l) => [l.line, l]));

  const chip = (lineId, name) => {
    const state = formState(lineId, name, species, treeSprites);
    return `<span class="form ${state}" title="${esc(name)} — ${STATE_TITLE[state]}">${esc(name)}</span>`;
  };

  const head = `<div class="cat-row cat-head">
      <div class="cat-line-cell"><span class="rail-label-in">계보 · namu.wiki</span></div>
      ${CAT_STAGES.map(
        (s) => `<div class="cat-cell"><span class="rail-ko">${s.ko}</span><span class="rail-en">${s.en}</span></div>`
      ).join('')}
    </div>`;

  const rows = CATALOG.lines
    .map((line) => {
      const stats = byLine.get(line.id);
      const pct = stats ? stats.pct : 0;
      const extras = [
        line.armor ? ['아머체', line.armor] : null,
        line.jogress ? ['조그레스', [].concat(line.jogress)] : null,
        line.variants ? ['변종', [].concat(line.variants)] : null,
      ].filter(Boolean);
      const extraRow = extras.length
        ? `<div class="cat-extra">${extras
            .map(
              ([label, list]) =>
                `<span class="extra-label">${label}</span>${list.map((n) => chip(line.id, n)).join('')}`
            )
            .join('')}</div>`
        : '';
      return `<div class="cat-row${line.in_repo ? ' in-repo' : ''}">
      <div class="cat-line-cell">
        <div class="cat-line-top">
          <h4>${esc(line.ko)}</h4>
          ${line.in_repo ? '<span class="chip on">팩 있음</span>' : '<span class="chip off">팩 없음</span>'}
        </div>
        <p class="cat-meta">${line.rank ? `인기 ${line.rank}위 · ` : ''}${esc(line.series)}</p>
        <div class="bar" role="img" aria-label="도트 확보율 ${pct}%"><i style="width:${pct}%"></i></div>
        <p class="cat-pct">도트 ${stats ? stats.ready + stats.mismatch : 0}/${stats ? stats.total : 0} · ${pct}%</p>
      </div>
      ${CAT_STAGES.map((st) => {
        const forms = line.stages[st.key];
        if (!forms || !forms.length)
          return `<div class="cat-cell empty-cell"><span class="cell-label">${st.ko}</span><span class="none-mark">—</span></div>`;
        return `<div class="cat-cell"><span class="cell-label">${st.ko}</span>${forms
          .map((n) => chip(line.id, n))
          .join('')}</div>`;
      }).join('')}
      ${extraRow}
    </div>`;
    })
    .join('\n    ');

  return { html: `${head}\n    ${rows}`, treeSprites, species };
}

const packs = readPacks();
packs.forEach(markReachable);

const totalNodes = packs.reduce((n, p) => n + p.nodes.size, 0);
const dotless = packs.reduce((n, p) => n + [...p.nodes.values()].filter((x) => !x.dot).length, 0);
packs.forEach(markOrphans);
const orphanTotal = packs.reduce((n, p) => n + [...p.nodes.values()].filter((x) => x.orphan).length, 0);
const catalog = renderCatalog(packs);
const catalogued = new Set(CATALOG.species.filter((x) => x.pack && x.sprite).map((x) => `${x.pack}/${x.sprite}`));
const offCatalog = packs.flatMap((p) =>
  [...p.nodes.values()].filter((n) => n.stageId !== 'digitama' && !catalogued.has(`${p.dir}/${n.sprite}`))
);
const wiredSpecies = CATALOG.species.filter(
  (x) => x.pack && x.sprite && catalog.treeSprites.has(`${x.pack}/${x.sprite}`)
).length;
const rotationPacks = packs.filter((p) => p.rotation);
const totalRoutes = rotationPacks.reduce((n, p) => n + countRoutes(p), 0);
const invalidTotal = packs.reduce((n, p) => n + p.invalid.length, 0);
const orphanNodes = packs.flatMap((p) =>
  [...p.nodes.values()].filter((n) => n.orphan).map((n) => ({ pack: p.name, name: n.name }))
);

const railCols = STAGES.map((s, i) => {
  const [ko, en] = s.label.split(' (');
  const gte = s.condition && s.condition.gte;
  const th = s.condition.type === 'always' ? '기본' : gte >= 1000 ? `${(gte / 1000).toLocaleString('en-US')}K` : `${gte}`;
  return `<div class="rail-col">
    <span class="rail-idx">${i + 1}</span>
    <span class="rail-ko">${esc(ko)}</span>
    <span class="rail-en">${esc((en || '').replace(')', ''))}</span>
    <span class="rail-th">${th}</span>
  </div>`;
}).join('');

const html = `<title>claudemon 진화 맵</title>
<style>
  :root {
    --paper: #E3E7DD;
    --surface: #F0F2E9;
    --sunken: #D7DCD0;
    --ink: #161B18;
    --ink-2: #4A524C;
    --muted: #6F776D;
    --line: #C2C8B8;
    --line-soft: #D2D8C9;
    --accent: #1D6672;
    --accent-soft: #A8C4C6;
    --signal: #B65F16;
    --signal-soft: #E0C39A;
    --shadow: 0 1px 0 rgba(22, 27, 24, .06);
    --display: "Apple SD Gothic Neo", "Pretendard", system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #101412; --surface: #181D1A; --sunken: #0B0F0D;
      --ink: #DFE4DA; --ink-2: #A9B2A8; --muted: #838C82;
      --line: #2C3531; --line-soft: #232B27;
      --accent: #64B2BE; --accent-soft: #2E5A61;
      --signal: #DE9445; --signal-soft: #6A4A26;
      --shadow: 0 1px 0 rgba(0, 0, 0, .4);
    }
  }
  :root[data-theme="dark"] {
    --paper: #101412; --surface: #181D1A; --sunken: #0B0F0D;
    --ink: #DFE4DA; --ink-2: #A9B2A8; --muted: #838C82;
    --line: #2C3531; --line-soft: #232B27;
    --accent: #64B2BE; --accent-soft: #2E5A61;
    --signal: #DE9445; --signal-soft: #6A4A26;
    --shadow: 0 1px 0 rgba(0, 0, 0, .4);
  }
  :root[data-theme="light"] {
    --paper: #E3E7DD; --surface: #F0F2E9; --sunken: #D7DCD0;
    --ink: #161B18; --ink-2: #4A524C; --muted: #6F776D;
    --line: #C2C8B8; --line-soft: #D2D8C9;
    --accent: #1D6672; --accent-soft: #A8C4C6;
    --signal: #B65F16; --signal-soft: #E0C39A;
    --shadow: 0 1px 0 rgba(22, 27, 24, .06);
  }

  * { box-sizing: border-box; }

  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--display);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 40px 20px 72px; display: flex; flex-direction: column; gap: 28px; }
  .wrap > * { min-width: 0; max-width: 100%; }
  .lede code, .section-head code, .note code, .path { overflow-wrap: anywhere; }

  /* ---- masthead ---- */
  header { display: flex; flex-direction: column; gap: 14px; }
  .eyebrow {
    font-family: var(--mono); font-size: 11px; letter-spacing: .18em; text-transform: uppercase;
    color: var(--muted);
  }
  h1 { font-size: clamp(30px, 5vw, 46px); font-weight: 800; letter-spacing: -.02em; line-height: 1.04; text-wrap: balance; }
  header p.lede { max-width: 62ch; color: var(--ink-2); font-size: 15px; }
  header p.lede code { font-family: var(--mono); font-size: 13px; color: var(--ink); }

  .stats { display: flex; flex-wrap: wrap; gap: 1px; background: var(--line-soft); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .stat { flex: 1 1 150px; background: var(--surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
  .stat b { font-family: var(--mono); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .stat span { font-size: 11.5px; color: var(--muted); font-family: var(--mono); letter-spacing: .04em; }
  .stat.hi b { color: var(--signal); }

  /* ---- map ---- */
  .map { border: 1px solid var(--line); border-radius: 4px; background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
  .map-scroll { overflow-x: auto; }
  .rail { display: flex; background: var(--sunken); border-bottom: 1px solid var(--line); }
  .rail-label {
    position: sticky; left: 0; z-index: 4; flex: none; width: ${GUTTER}px;
    padding: 10px 14px; display: flex; align-items: flex-end;
    background: var(--sunken); box-shadow: 1px 0 0 var(--line);
  }
  .rail-label span { font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .rail-col {
    flex: none; width: ${COL_W}px; padding: 8px 10px 9px;
    display: flex; flex-direction: column; gap: 1px; border-left: 1px solid var(--line-soft);
  }
  .rail-idx { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .rail-ko { font-size: 13px; font-weight: 700; letter-spacing: -.01em; }
  .rail-en { font-family: var(--mono); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .rail-th { font-family: var(--mono); font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--accent); margin-top: 3px; }

  .lane { display: flex; align-items: stretch; }
  .lane + .lane { border-top: 1px solid var(--line-soft); }
  .graph { display: block; flex: none; }

  .lane-head {
    position: sticky; left: 0; z-index: 3; flex: none; width: ${GUTTER}px;
    padding: 16px 14px 14px 20px; background: var(--surface); box-shadow: 1px 0 0 var(--line-soft);
  }
  .lane-head h3 { font-size: 17px; font-weight: 800; letter-spacing: -.01em; line-height: 1.2; }
  .lane-head .slug { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; color: var(--muted); text-transform: uppercase; }
  .chips { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; margin-top: 7px; }
  .chip {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .04em; padding: 1px 5px;
    border: 1px solid var(--line); border-radius: 2px; color: var(--ink-2); white-space: nowrap;
  }
  .chip.on { border-color: var(--accent); color: var(--accent); }
  .chip.off { border-color: var(--line); color: var(--muted); }
  .chip.warn { border-color: var(--signal-soft); color: var(--signal); }
  .chip.bad { border-color: var(--signal); color: var(--signal); font-weight: 700; }

  /* nodes */
  .cell { fill: var(--sunken); stroke: var(--line-soft); }
  .cell.empty { fill: none; stroke: var(--line); stroke-dasharray: 3 3; }
  .node image { image-rendering: pixelated; }
  .node .name { font-family: var(--display); font-size: 11.5px; font-weight: 600; fill: var(--ink); text-anchor: middle; }
  .node .nodot { font-family: var(--mono); font-size: 8.5px; fill: var(--muted); text-anchor: middle; }
  .node.spine .cell { stroke: var(--accent-soft); }
  .node.orphan .cell { stroke: var(--signal); stroke-dasharray: 3 3; }
  .node.orphan image { opacity: .5; }
  .node.stalls image { opacity: .38; }
  .node.stalls .name { fill: var(--muted); font-weight: 500; }

  /* edges */
  .edges path { fill: none; stroke-linecap: round; }
  .e-real { stroke: var(--accent); stroke-width: 1.6; opacity: .75; }
  .e-cond { stroke: var(--signal); stroke-width: 1.4; stroke-dasharray: 2 4; opacity: .8; }
  .e-label { font-family: var(--mono); font-size: 8px; fill: var(--signal); text-anchor: middle; letter-spacing: .01em; }

  /* ---- section heads ---- */
  .section-head { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; }
  .section-head h2 { font-size: 22px; font-weight: 800; letter-spacing: -.015em; line-height: 1.15; }
  .section-head p:not(.eyebrow) { font-size: 13.5px; color: var(--ink-2); max-width: 68ch; }
  .section-head code { font-family: var(--mono); font-size: 12px; }

  /* ---- catalogue grid ---- */
  .cat-grid { min-width: 1198px; }
  .cat-row {
    display: grid; grid-template-columns: 198px repeat(${CAT_STAGES.length}, ${(1198 - 198) / CAT_STAGES.length}px);
    border-top: 1px solid var(--line-soft);
  }
  .cat-row:first-child { border-top: 0; }
  .cat-head { background: var(--sunken); border-bottom: 1px solid var(--line); border-top: 0; }
  .cat-head .cat-cell, .cat-head .cat-line-cell { padding: 8px 10px 9px; align-self: end; }
  .rail-label-in { font-family: var(--mono); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .cat-cell { padding: 9px 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; border-left: 1px solid var(--line-soft); }
  .cat-head .cat-cell { display: flex; flex-direction: column; gap: 1px; }
  .cat-line-cell {
    position: sticky; left: 0; z-index: 2; background: var(--surface);
    padding: 11px 14px 12px 16px; display: flex; flex-direction: column; gap: 3px;
    box-shadow: 1px 0 0 var(--line-soft);
  }
  .cat-head .cat-line-cell { background: var(--sunken); z-index: 5; }
  .cell-label { display: none; }
  .cat-line-top { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
  .cat-line-cell h4 { font-size: 15px; font-weight: 800; letter-spacing: -.01em; }
  .cat-meta { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: .03em; }
  .bar { height: 3px; background: var(--line-soft); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .cat-pct { font-family: var(--mono); font-size: 10px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .cat-row.in-repo .cat-line-cell { box-shadow: inset 2px 0 0 var(--accent), 1px 0 0 var(--line-soft); }
  .cat-extra {
    grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
    padding: 7px 16px 10px; background: var(--sunken);
  }
  .extra-label {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); margin-right: 3px;
  }
  .extra-label:not(:first-child) { margin-left: 10px; }

  .form {
    display: inline-block; font-size: 11px; line-height: 1.35; padding: 2px 6px; border-radius: 2px;
    border: 1px solid transparent; max-width: 100%;
  }
  .form.wired { background: var(--accent); color: var(--surface); border-color: var(--accent); font-weight: 600; }
  .form.mismatch { border-color: var(--signal); color: var(--signal); }
  .form.dot { border-color: var(--accent); color: var(--accent); }
  .form.sheet { border-style: dashed; border-color: var(--accent-soft); color: var(--ink-2); }
  .form.none { color: var(--muted); border-color: var(--line-soft); }
  .form.untracked { color: var(--ink-2); background: var(--line-soft); }
  .form.mini { width: 22px; height: 13px; padding: 0; flex: none; }
  .none-mark { font-family: var(--mono); font-size: 11px; color: var(--line); }

  .scroll-hint { display: none; }

  /* ---- narrow screens: the map still scrolls sideways (a stage ladder has to),
     the catalogue stops being a table and unfolds per lineage ---- */
  @media (max-width: 760px) {
    .wrap { padding: 26px 14px 56px; gap: 22px; }
    h1 { font-size: 32px; }
    .section-head h2 { font-size: 19px; }
    .stat { flex-basis: calc(50% - 1px); }
    .legend { gap: 8px 16px; padding: 12px 13px; }
    .legend div { font-size: 12px; }
    .scroll-hint {
      display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em;
      color: var(--muted); margin-top: 2px;
    }
    .scroll-hint span { color: var(--ink-2); }

    .lane-head, .rail-label { width: 118px; }
    .graph { width: ${STAGES.length * COL_W * NARROW_SCALE}px; height: auto; }
    .rail-col { width: ${COL_W * NARROW_SCALE}px; }
    .lane-head { padding: 13px 10px 12px 13px; }
    .lane-head h3 { font-size: 15px; }
    .rail-label { padding: 9px 10px 10px 13px; }
    .rail-label span { font-size: 9.5px; letter-spacing: .1em; }

    .cat-grid { min-width: 0; }
    .cat-head { display: none; }
    .cat-row { grid-template-columns: 1fr; }
    .cat-row + .cat-row { border-top: 2px solid var(--line); }
    .cat-line-cell {
      position: static; box-shadow: none; padding: 13px 14px 11px;
      border-bottom: 1px solid var(--line-soft);
    }
    .cat-row.in-repo .cat-line-cell { box-shadow: inset 2px 0 0 var(--accent); }
    .cat-cell {
      flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 4px;
      border-left: 0; padding: 6px 14px;
    }
    .cat-cell + .cat-cell { border-top: 1px dotted var(--line-soft); }
    .cat-cell.empty-cell { display: none; }
    .cell-label {
      display: block; flex: none; width: 54px; font-family: var(--mono); font-size: 9.5px;
      letter-spacing: .04em; color: var(--muted); align-self: center;
    }
    .cat-extra { padding: 8px 14px 10px; }
    .bar { max-width: 220px; }
  }

  /* ---- legend + notes ---- */
  .legend { display: flex; flex-wrap: wrap; gap: 10px 24px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
  .legend div { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
  .swatch { width: 26px; height: 0; border-top-width: 2px; border-top-style: solid; flex: none; }
  .swatch.real { border-color: var(--accent); }
  .swatch.cond { border-color: var(--signal); border-top-style: dashed; }
  .box { width: 14px; height: 14px; border-radius: 2px; flex: none; background: var(--sunken); border: 1px solid var(--accent-soft); }
  .box.dashed { background: none; border: 1px dashed var(--line); }
  .box.faded { opacity: .38; }
  .box.orphan { background: none; border: 1px dashed var(--signal); }

  .notes { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .note { border: 1px solid var(--line); border-left: 2px solid var(--signal); border-radius: 3px; background: var(--surface); padding: 14px 16px; }
  .note.calm { border-left-color: var(--accent-soft); }
  .note h4 { font-size: 13px; font-weight: 800; margin-bottom: 5px; }
  .note p { font-size: 12.5px; color: var(--ink-2); }
  .note code, .path { font-family: var(--mono); font-size: 11.5px; color: var(--ink); }
  footer { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .04em; }
  a { color: var(--accent); }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">claudemon · sprites/packs/*/pack.json</p>
    <h1>진화 맵</h1>
    <p class="lede">하루 output 토큰이 임계치를 넘을 때마다 한 칸 진화한다. 데이터는 두 층이다 —
      지금 화면에 나오는 <b>팩 트리</b>(<code>sprites/packs/*/pack.json</code>)와, 도트를 채워 넣을
      대상 목록인 <b>계보 카탈로그</b>(<code>docs/digimon-evolution-lines.yaml</code> +
      <code>docs/sprite-status.yaml</code>). 아래는 두 층을 순서대로, 저장소 실측으로 그렸다.</p>
    <div class="stats">
      <div class="stat"><b>${packs.length}</b><span>팩 · 트리 노드 ${totalNodes}</span></div>
      <div class="stat"><b>${rotationPacks.length}/${packs.length}</b><span>로테이션 후보</span></div>
      <div class="stat hi"><b>${totalRoutes}</b><span>하루 루트 (로테이션 후보 합)</span></div>
      <div class="stat${invalidTotal ? ' hi' : ''}"><b>${invalidTotal}</b><span>INVALID</span></div>
      <div class="stat"><b>${CATALOG.lines.length}</b><span>카탈로그 계보</span></div>
      <div class="stat"><b>${CATALOG.summary.ready + CATALOG.summary.mismatch}/${CATALOG.summary.total}</b><span>도트 확보 종</span></div>
    </div>
  </header>

  <div class="section-head">
    <p class="eyebrow">layer 1 · sprites/packs/*/pack.json</p>
    <h2>지금 도는 트리</h2>
    <p>매일 이 그래프에서 하루 루트 하나를 뽑는다. 가로가 스테이지, 상단 레일이 임계치다.</p>
    <p class="scroll-hint">좌우로 밀어서 다음 단계 → <span>팩 이름은 왼쪽에 고정된다</span></p>
  </div>

  <div class="legend">
    <div><i class="swatch real"></i> 무조건 엣지 (<code>when: null</code>)</div>
    <div><i class="swatch cond"></i> 조건부 엣지 (라벨 = 오늘 이 분기를 여는 조건)</div>
    <div><i class="box"></i> spine (스테이지 첫 노드)</div>
    <div><i class="box faded"></i> 최상위 미달 · 추첨 제외</div>
    ${dotless ? '<div><i class="box dashed"></i> 도트 없음</div>' : ''}
    <div><i class="box orphan"></i> 부모 엣지 없음 · 도달 불가</div>
  </div>

  <div class="map">
    <div class="map-scroll">
      <div class="rail">
        <div class="rail-label"><span>일일 output 토큰 →</span></div>
        ${railCols}
      </div>
      ${packs.map(renderPack).join('\n      ')}
    </div>
  </div>

  <div class="section-head">
    <p class="eyebrow">layer 2 · docs/digimon-evolution-lines.yaml</p>
    <h2>계보 카탈로그</h2>
    <p>namu.wiki 진화도에서 옮긴 ${CATALOG.lines.length}개 계보 ${CATALOG.summary.total}종. 도트가 생기는 순간
      위 트리로 편입된다. 도트가 있는 ${CATALOG.summary.ready + CATALOG.summary.mismatch}종 중 ${wiredSpecies}종이 편입된 상태고,
      ${CATALOG.summary.missing}종이 남았다. 왼쪽 막대가 계보별 도트 확보율이다.</p>
    <p class="scroll-hint">좁은 화면에서는 계보별로 단계가 세로로 펼쳐진다</p>
  </div>

  <div class="legend">
    <div><i class="form wired mini"></i> 편입 · 화면에 나옴</div>
    <div><i class="form mismatch mini"></i> 도트가 다른 종 (유아기 ${CATALOG.summary.mismatch}종)</div>
    <div><i class="form sheet mini"></i> DWDS 시트만</div>
    <div><i class="form none mini"></i> 아직 없음</div>
    <div><i class="form untracked mini"></i> 아머체 · 조그레스 (스캐너 밖)</div>
  </div>

  <div class="map">
    <div class="map-scroll">
      <div class="cat-grid">
        ${catalog.html}
      </div>
    </div>
  </div>

  <div class="notes">
    <div class="note calm">
      <h4>점선은 조건부 엣지다</h4>
      <p>부모 노드의 <code>evolutions</code> 목록을 순서대로 검사해 오늘의 신호(<code>sessionCount</code>
        · <code>topSharePct</code> · <code>failureRatioPct</code> 등)로 조건이 먼저 걸린 분기를
        먼저 시도하고, 실선(<code>when: null</code>)이 도달을 보장하는 폴백이다. 후속이 없는
        분기를 다음 스테이지의 spine으로 되돌리는 합성 엣지는 더 이상 없다 — 각 팩의 데이터가
        직접 도달을 보장해야 하고, <span class="path">validatePackTree</span>가 그 계약을 검사한다.</p>
    </div>
    <div class="note calm">
      <h4>지연 진화가 들어왔다</h4>
      <p><span class="path">selectRoute</span>의 <code>locked</code>가 이미 도달한 단계는 고정하고
        위쪽 단계만 오늘의 신호로 다시 뽑는다. 하루 중간에 채워진 <code>sessionCount</code> 등이
        아직 도달하지 않은 분기를 바꾸면서도 화면의 모습은 흔들리지 않는다.</p>
    </div>
    <div class="note calm">
      <h4>로테이션에 드는 조건</h4>
      <p><span class="path">idle-0.png</span>이 있고, 알 도트에 닿고, <span class="path">stageNames</span>가
        초궁극체를 이름 붙인 팩만 매일 추첨에 든다. 가오몬은 궁극체(미라지가오가몬)에서 멈춰
        제외 상태 — 명시 선택으로는 그대로 나온다.</p>
    </div>
    <div class="note">
      <h4>두 층이 겹치지 않는 자리</h4>
      <p>팩 트리에는 있는데 카탈로그에는 없는 노드가 ${offCatalog.length}개다 — 지오그레이몬·샤인그레이몬처럼
        DWDS(세이버즈) 계열 분기다. 카탈로그는 namu의 정사 진화도라 이쪽을 <span class="path">stages</span>에
        담지 않는다.</p>
    </div>
    ${
      orphanNodes.length
        ? `<div class="note">
      <h4>부모가 없는 노드 (${orphanNodes.length})</h4>
      <p>${orphanNodes.map((n) => `${esc(n.pack)}/${esc(n.name)}`).join(', ')} — 트리에 있고 도트도
        있지만 알에서 출발하는 어떤 경로에도 닿지 않는다. 정사 근거(<span class="path">docs/evolution-routes.md</span>,
        <span class="path">docs/digimon-evolution-lines.yaml</span>) 없이 부모 엣지를 지어내지 않았다.</p>
    </div>`
        : `<div class="note calm">
      <h4>부모 없는 노드 0개</h4>
      <p>모든 노드가 알에서 시작하는 경로 위에 있다. 지난 판(가오몬 도입 이전)에 있던
        블랙워가루몬·레이브몬 고아는 각각 D4·<code>docs/digimon-evolution-lines.yaml</code> 근거로
        부모 엣지를 이어 해소했다.</p>
    </div>`
    }
  </div>

  <footer>저장소 실측 · pack.json ${totalNodes} 노드 · 카탈로그 ${CATALOG.summary.total} 종 (fetched ${esc(CATALOG.meta.fetched)}) · 규칙은 docs/evolution-routes.md</footer>
</div>
`;

fs.writeFileSync(OUT, html);
console.log('wrote', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB');
for (const p of packs) {
  console.log(
    p.name.padEnd(7),
    'rotation:' + (p.rotation ? 'Y' : 'N'),
    'routes:' + countRoutes(p),
    'INVALID:' + p.invalid.length,
    'stalls:' + [...p.nodes.values()].filter((n) => !n.reaches).map((n) => n.name).join(',')
  );
}
