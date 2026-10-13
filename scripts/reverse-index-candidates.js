#!/usr/bin/env node
// 역방향 인덱스: 기존 그래프 노드의 캐시된 wikitext에서 Evolves From을 파싱해
// 미편입 부모를 모아낸다. 자식이 이미 그래프에 있으므로 R10·R11 자동 만족.
// 스테이지 인접성 필터로 R9도 1차 만족. 도트 캐시 여부를 추가로 보고한다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const WN_NAMES_PATH = path.join(ROOT, 'docs', 'wikimon-names.yaml');
const CACHE_DIR = '/Users/saladlab/Dev/claude-mon/.omc/wikimon-cache';
const SPRITE_DIR = '/Users/saladlab/Dev/claude-mon/sprites';

const STAGES = ['digitama', 'baby', 'child', 'adult', 'perfect', 'ultimate', 'superultimate'];
const stageIdx = Object.fromEntries(STAGES.map((s, i) => [s, i]));

const LEVEL_TO_STAGE = {
  'Baby I': 'baby',
  'Baby II': 'baby',
  Child: 'child',
  Adult: 'adult',
  Perfect: 'perfect',
  Ultimate: 'ultimate',
  'Super Ultimate': 'superultimate',
};

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadAliases() {
  const yaml = fs.readFileSync(WN_NAMES_PATH, 'utf8');
  const aliases = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^  "([^"]+)":\s*"([^"]+)"/);
    if (m) aliases[m[1]] = m[2];
  }
  return aliases;
}

function isDuplicate(title, graphIds, aliases) {
  const normId = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (graphIds.has(normId)) return { dup: true, reason: 'id=' + normId };

  const aliasId = aliases[title];
  if (aliasId && graphIds.has(aliasId)) return { dup: true, reason: 'alias=' + aliasId };

  return { dup: false };
}

function parseStageFromWikitext(content) {
  const firstHeading = content.search(/^==/m);
  const infobox = firstHeading >= 0 ? content.slice(0, firstHeading) : content;

  const levelMatch =
    infobox.match(/\|l1\s*=\s*(.+?)(?:\||\n|$)/i) ||
    infobox.match(/\|l2\s*=\s*(.+?)(?:\||\n|$)/i) ||
    infobox.match(/\|l3\s*=\s*(.+?)(?:\||\n|$)/i);

  if (!levelMatch) return { level: null, stage: null, koName: null };

  const levelStr = levelMatch[1].trim().replace(/\[\[|\]\]/g, '');
  const stage = LEVEL_TO_STAGE[levelStr] || null;

  let koName = null;
  const olMatch = infobox.match(/\|ol\s*=([\s\S]*?)(?:\n\|[a-z]|$)/i);
  if (olMatch) {
    const korMatch = olMatch[1].match(/\{\{KOR\s*\|\s*([^}]+)\}\}/i);
    if (korMatch) koName = korMatch[1].trim();
  }

  return { level: levelStr, stage, koName };
}

function main() {
  const graph = loadGraph();
  const aliases = loadAliases();

  const graphIds = new Set(graph.nodes.map((n) => n.id));
  const nodeStage = Object.fromEntries(graph.nodes.map((n) => [n.id, n.stage]));

  const cacheFiles = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.wikitext'));

  console.log('=== 역방향 인덱스 산출 시작 ===');
  console.log('그래프 노드:', graph.nodes.length);
  console.log('캐시 파일:', cacheFiles.length);
  console.log('');

  const candidates = new Map();
  let totalLinks = 0;

  // 1단계: 기존 노드의 Evolves From 파싱
  for (const file of cacheFiles) {
    const title = file.replace(/\.wikitext$/, '').replace(/_/g, '/');
    const content = fs.readFileSync(path.join(CACHE_DIR, file), 'utf8');

    const possibleId = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliasId = aliases[title];
    const nodeId = graphIds.has(possibleId)
      ? possibleId
      : aliasId && graphIds.has(aliasId)
        ? aliasId
        : null;

    if (!nodeId) continue;

    const evFromMatch = content.match(/==\s*Evolves From\s*==([\s\S]*?)(?:==|$)/i);
    if (!evFromMatch) continue;

    const section = evFromMatch[1];
    const lines = section.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('*')) continue;

      const headMatch = trimmed.match(/^\*\s*(?:''')?\[\[([^\]]+)\]\](?:''')?/);
      if (!headMatch) continue;

      let parentTitle = headMatch[1];
      if (parentTitle.includes('|')) parentTitle = parentTitle.split('|')[0].trim();
      if (
        parentTitle.includes('#') ||
        parentTitle.includes('Digimon Card Game') ||
        parentTitle.includes('Category:')
      )
        continue;
      if (/\(\s*with\s+\[\[/i.test(trimmed) && !/with or without/i.test(trimmed)) continue;

      totalLinks++;

      const dupCheck = isDuplicate(parentTitle, graphIds, aliases);
      if (dupCheck.dup) continue;

      if (!candidates.has(parentTitle)) {
        candidates.set(parentTitle, {
          stage: null,
          level: null,
          koName: null,
          children: [],
        });
      }
      candidates.get(parentTitle).children.push(nodeId);
    }
  }

  console.log('총 부모 링크:', totalLinks);
  console.log('중복 제거 후 후보:', candidates.size);
  console.log('');

  // 2단계: 후보의 스테이지 파싱
  let parsedCount = 0;
  for (const [title, data] of candidates) {
    const cacheFile = path.join(CACHE_DIR, title.replace(/[:/]/g, '_') + '.wikitext');
    if (!fs.existsSync(cacheFile)) continue;

    const content = fs.readFileSync(cacheFile, 'utf8');
    const parsed = parseStageFromWikitext(content);
    data.level = parsed.level;
    data.stage = parsed.stage;
    data.koName = parsed.koName;
    if (parsed.stage) parsedCount++;
  }

  console.log('스테이지 파싱 성공:', parsedCount, '/', candidates.size);
  console.log('');

  // 3단계: 스테이지 인접성 필터
  const adjacentCandidates = [];

  for (const [title, data] of candidates) {
    if (!data.stage) continue;

    const parentIdx = stageIdx[data.stage];
    const childStages = data.children.map((cid) => nodeStage[cid]).filter((s) => s);
    const adjacentChildren = childStages.filter((cs) => {
      const childIdx = stageIdx[cs];
      return childIdx === parentIdx + 1;
    });

    if (adjacentChildren.length > 0) {
      adjacentCandidates.push({
        title,
        ...data,
        adjacentChildren: adjacentChildren.length,
      });
    }
  }

  console.log('스테이지 인접 후보:', adjacentCandidates.length);

  // 스테이지 분포
  const stageDistrib = {};
  for (const cand of adjacentCandidates) {
    stageDistrib[cand.stage] = (stageDistrib[cand.stage] || 0) + 1;
  }
  console.log('스테이지 분포:', stageDistrib);
  console.log('');

  // 4단계: 도트 캐시 확인 (sprites/nodes/<id>-0.png)
  const nodeDir = path.join(SPRITE_DIR, 'nodes');
  const nodeFiles = new Set(fs.readdirSync(nodeDir));

  const withDots = [];
  const withoutDots = [];

  for (const cand of adjacentCandidates) {
    const spriteId = cand.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hasDot = nodeFiles.has(spriteId + '-0.png');

    if (hasDot) {
      withDots.push({ ...cand, hasDot: true });
    } else {
      withoutDots.push(cand);
    }
  }

  console.log('도트 있음:', withDots.length);
  console.log('도트 없음:', withoutDots.length);
  console.log('');

  // 도트 보유 스테이지 분포
  const dotStageDistrib = {};
  for (const c of withDots) {
    dotStageDistrib[c.stage] = (dotStageDistrib[c.stage] || 0) + 1;
  }
  console.log('도트 보유 스테이지 분포:', dotStageDistrib);
  console.log('');

  // 샘플 출력
  console.log('=== 도트 있는 샘플 30개 ===');
  for (let i = 0; i < Math.min(30, withDots.length); i++) {
    const c = withDots[i];
    console.log(
      `  ${c.title} (${c.stage}, 인접 자식 ${c.adjacentChildren})`
    );
  }
  console.log('');

  // JSON 출력
  const outputPath = path.join(ROOT, 'docs', 'reverse-index-candidates.json');
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        withDots,
        withoutDots,
        stats: {
          totalCandidates: adjacentCandidates.length,
          withDots: withDots.length,
          withoutDots: withoutDots.length,
          stageDistrib,
          dotStageDistrib,
        },
      },
      null,
      2
    )
  );

  console.log('결과 저장:', outputPath);
}

main();
