#!/usr/bin/env node
// Wikimon 정규 진화 엣지를 evolution-graph.json 과 대조한다.
//
// 사용법:
//   node scripts/audit-canon-edges.js [--offline] [--fetch] [--stage <stage>] [--refresh]
//
// 모드:
//   --offline  (기본값) 캐시만 사용, 네트워크 미접촉. 캐시 없으면 "미조회"로 집계.
//   --fetch    명시 시에만 네트워크 조회. 반드시 칸 단위(--stage)로 나눠 돌려라.
//              Wikimon은 짧은 시간 수십 요청 시 403 차단(실측 2026-08-20: 3초 간격에도 70% 차단).
//              차단되면 기다린다 — 재시도로 뚫지 않는다.
//   --stage <id>  지정 칸만 대조
//   --refresh   캐시 무효화 (fetch 모드에서만 작동)
//
// 로스터 판정:
//   태그 약어가 아니라 ref 정의의 **게임 제목 문자열**로 판정한다.
//   같은 Dawn/Dusk가 페이지마다 DSSM/DSMS로 다르게 쓰인다(실측).

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const TREE_PATH = path.join(ROOT, 'evolution-tree.json');
const NAMES_PATH = path.join(ROOT, 'docs', 'wikimon-names.yaml');
const CACHE_DIR = path.join(ROOT, '.omc', 'wikimon-cache');

const ALLOWED_GAMES = [
  'Digimon Story: Sunburst',
  'Digimon Story: Moonlight',
  'Digimon World DS',
  'Digimon Story',
  'Digimon Story: Lost Evolution',
  'Digimon Story: Super Xros Wars',
];

const EXCLUDED_GAMES = [
  'Digimon Story: Cyber Sleuth',
  'Digimon Story: Time Stranger',
  'Digimon Story: Linkz',
  'Digimon Story: ReArise',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;
  const refresh = args.includes('--refresh');
  const fetch = args.includes('--fetch');
  const offline = args.includes('--offline') || !fetch;
  return { stage, refresh, offline };
}

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadStages() {
  return JSON.parse(fs.readFileSync(TREE_PATH, 'utf8')).stages.map((s) => s.id);
}

function loadNameMapping() {
  if (!fs.existsSync(NAMES_PATH)) {
    return { exceptions: {}, aliases: {} };
  }
  const content = fs.readFileSync(NAMES_PATH, 'utf8');
  const exceptions = {};
  const aliases = {};
  let section = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'exceptions:') {
      section = 'exceptions';
      continue;
    }
    if (trimmed === 'aliases:') {
      section = 'aliases';
      continue;
    }

    if (section && (line.startsWith(' ') || line.startsWith('\t'))) {
      const match = trimmed.match(/^"?([^:"]+)"?:\s*"?([^"]+)"?$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (section === 'exceptions') exceptions[key] = value;
        else if (section === 'aliases') aliases[key] = value;
      }
    } else if (trimmed && !trimmed.endsWith(':')) {
      section = null;
    }
  }

  return { exceptions, aliases };
}

function nodeIdToWikimonTitle(id, exceptions) {
  if (exceptions[id]) return exceptions[id];

  const modeMap = {
    _fm: ': Fighter Mode',
    _dm: ': Dragon Mode',
    _pm: ': Paladin Mode',
    _hm: ': Holy Mode',
    _burst: ': Burst Mode',
    _crimson: ': Crimson Mode',
    '-bm': ': Burst Mode',
    '-black': ' Black',
  };

  let title = id;
  for (const [suffix, replacement] of Object.entries(modeMap)) {
    if (title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  if (title.startsWith('black') && !title.includes(':')) {
    title = 'Black' + title.slice(5);
  }

  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWikitext(title, refresh, depth = 0, retryCount = 0) {
  const cacheFile = path.join(CACHE_DIR, `${title.replace(/[:/]/g, '_')}.wikitext`);

  if (!refresh && fs.existsSync(cacheFile)) {
    const content = fs.readFileSync(cacheFile, 'utf8');
    if (content.trim().toLowerCase().startsWith('#redirect')) {
      const redirectMatch = content.match(/#redirect\s*\[\[([^\]]+)\]\]/i);
      if (redirectMatch && depth < 3) {
        fs.unlinkSync(cacheFile);
        await sleep(3000);
        return fetchWikitext(redirectMatch[1], false, depth + 1, 0);
      }
    }
    return { content, finalTitle: title, chain: [] };
  }

  const url = `https://wikimon.net/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&format=json&formatversion=2`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            if (retryCount >= 3) {
              return reject(new Error(`HTTP ${res.statusCode} after ${retryCount} retries: ${title}`));
            }
            const backoffDelay = 5000 * Math.pow(3, retryCount);
            console.log(`  HTTP ${res.statusCode} → ${backoffDelay}ms 대기 후 재시도 (${retryCount + 1}/3)`);
            await sleep(backoffDelay);
            try {
              const result = await fetchWikitext(title, refresh, depth, retryCount + 1);
              resolve(result);
            } catch (err) {
              reject(err);
            }
            return;
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${title}`));
          }

          try {
            const json = JSON.parse(data);
            const page = json.query?.pages?.[0];
            if (!page || !page.revisions) {
              return reject(new Error(`페이지 없음: ${title}`));
            }

            const content = page.revisions[0].content;
            const finalTitle = page.title;

            if (content.trim().toLowerCase().startsWith('#redirect')) {
              const redirectMatch = content.match(/#redirect\s*\[\[([^\]]+)\]\]/i);
              if (redirectMatch && depth < 3) {
                await sleep(3000);
                const result = await fetchWikitext(redirectMatch[1], false, depth + 1, 0);
                resolve({ ...result, chain: [title, ...result.chain] });
                return;
              }
            }

            if (!fs.existsSync(CACHE_DIR)) {
              fs.mkdirSync(CACHE_DIR, { recursive: true });
            }
            fs.writeFileSync(cacheFile, content);

            resolve({ content, finalTitle, chain: depth > 0 ? [title] : [] });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function extractEvolvesFrom(wikitext) {
  const lines = wikitext.split('\n');
  let inSection = false;
  const result = [];

  for (const line of lines) {
    if (line.match(/^==\s*Evolves From\s*==/i)) {
      inSection = true;
      continue;
    }
    if (inSection && line.match(/^==/)) {
      break;
    }
    if (inSection && line.trim()) {
      result.push(line);
    }
  }

  return result;
}

function extractRefDefinitions(wikitext) {
  const defs = new Map();
  
  // <ref name=...>...</ref> 형식 (전체 내용 추출)
  const refRegex = /<ref\s+name=([^>]+)>([^<]+)<\/ref>/gi;
  let match;
  while ((match = refRegex.exec(wikitext)) !== null) {
    const tag = match[1].replace(/["']/g, '');
    const content = match[2];
    
    // 내용에서 모든 [[Game]] 링크 추출
    const gameMatches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    for (const gm of gameMatches) {
      const game = gm[1];
      // Digimon Card Game 링크는 무시
      if (game.includes('Digimon Card Game')) continue;
      if (!defs.has(tag)) defs.set(tag, []);
      defs.get(tag).push(game);
    }
  }
  
  return defs;
}

function parseEvolvesFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('*')) return null;

  // bold 마크 '''도 허용 (non-capturing group)
  const headMatch = trimmed.match(/^\*\s*(?:''')??\[\[([^\]]+)\]\](?:''')?/);
  if (!headMatch) return null;

  const parent = headMatch[1];

  // 카드 게임 필터링: parent 이름에 "Digimon Card Game" 포함
  // ({{rfc|...}}는 참조 태그이므로 무시)
  const isCardGame = parent.includes('Digimon Card Game');
  if (isCardGame) {
    return { parent, tags: [], isJogress: false, isCardGame: true, rawLine: trimmed };
  }

  // 조그레스 필터링: 괄호가 있으면 조그레스 (단, "with or without"은 예외)
  const hasParenthesis = trimmed.includes('(');
  const isOptionalJogress = trimmed.includes('with or without');
  if (hasParenthesis && !isOptionalJogress) {
    return { parent, tags: [], isJogress: true, isCardGame: false, rawLine: trimmed };
  }

  // ref 태그 추출
  const tags = [];
  const refRegex = /<ref\s+name=([^/>]+)/gi;
  let match;
  while ((match = refRegex.exec(trimmed)) !== null) {
    tags.push(match[1].replace(/["']/g, ''));
  }
  
  // {{ref|...}} 인라인 형식도 처리
  const inlineRefRegex = /{{ref\|''([^']+)''}}/gi;
  while ((match = inlineRefRegex.exec(trimmed)) !== null) {
    tags.push(`inline:${match[1]}`);
  }

  return { parent, tags, isJogress: false, isCardGame: false, rawLine: trimmed };
}

function resolveRefTags(tags, refDefs) {
  const games = new Set();
  for (const tag of tags) {
    // 인라인 ref는 직접 게임 이름
    if (tag.startsWith('inline:')) {
      games.add(tag.slice(7));
      continue;
    }
    
    // 정의된 ref 태그
    if (refDefs.has(tag)) {
      for (const game of refDefs.get(tag)) {
        games.add(game);
      }
    }
  }
  return Array.from(games);
}

function passesRosterGate(games) {
  // EXCLUDED 게임 제외하고 나머지만 검사
  const validGames = games.filter(g =>
    !EXCLUDED_GAMES.some(excluded => g.includes(excluded))
  );

  // 유효한 게임 중 ALLOWED가 있으면 통과
  return validGames.some(g =>
    ALLOWED_GAMES.some(allowed => g.includes(allowed))
  );
}

function buildIndices(graph, stages) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  const stageIndex = new Map(stages.map((s, i) => [s, i]));

  for (const node of graph.nodes) {
    for (const link of node.evolvesFrom) {
      if (!childrenOf.has(link.from)) {
        childrenOf.set(link.from, []);
      }
      childrenOf.get(link.from).push({ child: node, when: link.when });
    }
  }

  return { byId, childrenOf, stageIndex };
}

function hasEdge(child, parentId) {
  return child.evolvesFrom.some((link) => link.from === parentId);
}

function analyzeFanOut(parentId, childrenOf, existingEdge) {
  const children = childrenOf.get(parentId) || [];
  const currentFanOut = children.length;
  const afterFanOut = existingEdge ? currentFanOut : currentFanOut + 1;
  const warning = afterFanOut >= 4 ? '⚠️ 조건 축 상한 근접 (≥4)' : '';
  return { currentFanOut, afterFanOut, warning };
}

function normalize(str) {
  return str.toLowerCase().replace(/[\s\-:]/g, '');
}

function findNodeIdByTitle(title, byId, nameMap) {
  const aliases = nameMap.aliases || {};
  if (aliases[title]) {
    const id = aliases[title];
    return { id: byId.has(id) ? id : null, unmapped: false };
  }

  const exceptions = nameMap.exceptions || {};
  for (const [id, wikiTitle] of Object.entries(exceptions)) {
    if (wikiTitle === title) {
      return { id: byId.has(id) ? id : null, unmapped: false };
    }
  }

  let candidate = title.toLowerCase();
  // 괄호 접미사 제거 (예: "Yatagaramon (2006 Anime Version)" → "yatagaramon")
  candidate = candidate.replace(/\s*\([^)]+\)\s*$/g, '');
  candidate = candidate.replace(/: fighter mode/i, '_fm');
  candidate = candidate.replace(/: dragon mode/i, '_dm');
  candidate = candidate.replace(/: paladin mode/i, '_pm');
  candidate = candidate.replace(/: holy mode/i, '_hm');
  candidate = candidate.replace(/: burst mode/i, '-bm');
  candidate = candidate.replace(/: blast mode/i, '-bm');
  candidate = candidate.replace(/: crimson mode/i, '_crimson');
  candidate = candidate.replace(/ black$/i, '-black');
  candidate = candidate.replace(/\s+/g, '');

  // candidate가 유효한 id 형식이면 성공 (노드 존재 여부는 별도)
  return { id: candidate, unmapped: false };
}

async function auditNode(node, graph, indices, nameMap, opts) {
  const { byId, childrenOf, stageIndex } = indices;
  const title = nodeIdToWikimonTitle(node.id, nameMap.exceptions || {});

  let wikitext = null;
  const cacheFile = path.join(CACHE_DIR, `${title.replace(/[:/]/g, '_')}.wikitext`);
  
  if (opts.offline) {
    if (fs.existsSync(cacheFile)) {
      wikitext = fs.readFileSync(cacheFile, 'utf8');
    } else {
      return {
        node: node.id,
        title,
        cached: false,
        category: 'nocache',
      };
    }
  } else {
    try {
      const result = await fetchWikitext(title, opts.refresh);
      wikitext = result.content;
      if (result.chain.length > 0) {
        console.log(`  리다이렉트: ${result.chain.join(' → ')} → ${result.finalTitle}`);
      }
      await sleep(3000);
    } catch (err) {
      console.error(`  조회 실패: ${title} — ${err.message}`);
      return {
        node: node.id,
        title,
        cached: false,
        category: 'error',
        error: err.message,
      };
    }
  }

  const evolvesFromLines = extractEvolvesFrom(wikitext);
  if (evolvesFromLines.length === 0) {
    return {
      node: node.id,
      title,
      cached: true,
      hasEvolvesFrom: false,
      category: 'uninterpreted',
    };
  }

  const refDefs = extractRefDefinitions(wikitext);
  const candidates = [];

  for (const line of evolvesFromLines) {
    const parsed = parseEvolvesFromLine(line);
    if (!parsed) continue;
    if (parsed.isJogress) continue;
    if (parsed.isCardGame) continue;

    const { parent, tags, rawLine } = parsed;
    const games = resolveRefTags(tags, refDefs);

    const passesGate = games.length === 0 ? null : passesRosterGate(games);

    const parentLookup = findNodeIdByTitle(parent, byId, nameMap);
    const parentId = parentLookup.id;
    const parentNode = parentId ? byId.get(parentId) : null;
    const unmapped = parentLookup.unmapped;

    const stageMismatch = parentNode && stageIndex.get(parentNode.stage) !== stageIndex.get(node.stage) - 1;

    const edgeExists = parentNode && hasEdge(node, parentId);

    let category;
    // 로스터 게이트 우선: 태그가 없거나(null) 게이트 미달이면 C
    if (passesGate === false || passesGate === null) {
      category = 'C';
    } else if (!parentNode) {
      category = 'B';
    } else if (edgeExists) {
      category = 'exists';
    } else if (stageMismatch) {
      category = 'D';
    } else if (unmapped) {
      category = 'unmapped';
    } else if (passesGate === true) {
      category = 'A';
    } else {
      category = 'unknown';
    }

    const fanOut = parentNode ? analyzeFanOut(parentId, childrenOf, edgeExists) : null;

    candidates.push({
      parent: parentId || parent,
      parentExists: !!parentNode,
      parentStage: parentNode ? parentNode.stage : null,
      unmapped,
      tags,
      games,
      passesGate,
      stageMismatch,
      edgeExists,
      rawLine,
      category,
      fanOut,
    });
  }

  return {
    node: node.id,
    title,
    cached: true,
    hasEvolvesFrom: true,
    candidates,
  };
}

async function main() {
  const opts = parseArgs();
  const graph = loadGraph();
  const stages = loadStages();
  const nameMap = loadNameMapping();

  const indices = buildIndices(graph, stages);

  const targetNodes = opts.stage
    ? graph.nodes.filter((n) => n.stage === opts.stage)
    : graph.nodes;

  console.log(`${opts.offline ? '오프라인' : '온라인'} 검증\n대조 대상: ${targetNodes.length}개 노드${opts.stage ? ` (stage=${opts.stage})` : ''}\n`);

  const results = [];

  for (const node of targetNodes) {
    const result = await auditNode(node, graph, indices, nameMap, opts);
    results.push(result);

    if (!result.cached && opts.offline) {
      console.log(`[미조회] ${node.id} (캐시 없음)`);
    } else if (result.cached) {
      console.log(`[조회] ${node.id} → ${result.title}`);
    }
  }

  const categoryA = [];
  const categoryB = [];
  const categoryC = [];
  const categoryD = [];
  const alreadyExists = [];
  const unmappedNames = [];
  const nocache = [];

  for (const result of results) {
    if (result.category === 'nocache') {
      nocache.push(result);
      continue;
    }
    if (result.category === 'uninterpreted') continue;

    for (const cand of result.candidates || []) {
      const entry = { node: result.node, ...cand };
      if (cand.category === 'unmapped') unmappedNames.push(entry);
      else if (cand.category === 'A') categoryA.push(entry);
      else if (cand.category === 'B') categoryB.push(entry);
      else if (cand.category === 'C') categoryC.push(entry);
      else if (cand.category === 'D') categoryD.push(entry);
      else if (cand.category === 'exists') alreadyExists.push(entry);
    }
  }

  console.log('\n========================================');
  console.log('A. 도트 0장');
  console.log('========================================');
  if (categoryA.length === 0) {
    console.log('  (없음)');
  } else {
    for (const e of categoryA) {
      console.log(`\n  ${e.node} ← ${e.parent}`);
      console.log(`    게임: ${e.games.join(', ')}`);
      console.log(`    fan-out: ${e.fanOut.currentFanOut} → ${e.fanOut.afterFanOut}`);
    }
  }

  console.log('\n========================================');
  console.log('B. 노드 필요');
  console.log('========================================');
  if (categoryB.length === 0) {
    console.log('  (없음)');
  } else {
    for (const e of categoryB) {
      console.log(`\n  ${e.node} ← ${e.parent}`);
      console.log(`    게임: ${e.games.join(', ')}`);
    }
  }

  console.log('\n========================================');
  console.log('C. 게이트 미달');
  console.log('========================================');
  if (categoryC.length === 0) {
    console.log('  (없음)');
  } else {
    for (const e of categoryC) {
      console.log(`\n  ${e.node} ← ${e.parent}`);
      console.log(`    게임: ${e.games.join(', ')}`);
    }
  }

  console.log('\n========================================');
  console.log('D. 스테이지 불일치');
  console.log('========================================');
  if (categoryD.length === 0) {
    console.log('  (없음)');
  } else {
    for (const e of categoryD) {
      console.log(`\n  ${e.node} (${indices.byId.get(e.node).stage}) ← ${e.parent} (${e.parentStage})`);
    }
  }

  console.log('\n========================================');
  console.log('이미 있음');
  console.log('========================================');
  console.log(`  ${alreadyExists.length}개 엣지`);
  for (const e of alreadyExists) {
    console.log(`    ${e.node} ← ${e.parent}`);
  }

  console.log('\n========================================');
  console.log('요약');
  console.log('========================================');
  console.log(`  A (도트 0장):      ${categoryA.length}개`);
  console.log(`  B (노드 필요):     ${categoryB.length}개`);
  console.log(`  C (게이트 미달):   ${categoryC.length}개`);
  console.log(`  D (스테이지 불일치): ${categoryD.length}개`);
  console.log(`  이미 있음:         ${alreadyExists.length}개`);
  console.log(`  이름 해석 실패:    ${unmappedNames.length}개`);
  console.log(`  미조회 (캐시 없음): ${nocache.length}개`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
