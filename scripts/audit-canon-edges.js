#!/usr/bin/env node
// Wikimon 정규 진화 엣지를 evolution-graph.json 과 대조한다.
//
// 사용법:
//   node scripts/audit-canon-edges.js [--offline] [--fetch] [--stage <stage>] [--refresh]
//                                     [--terminals] [--check]
//
// 모드:
//   --offline  (기본값) 캐시만 사용, 네트워크 미접촉. 캐시 없으면 "미조회"로 집계.
//   --fetch    명시 시에만 네트워크 조회. 반드시 칸 단위(--stage)로 나눠 돌려라.
//              Wikimon은 짧은 시간 수십 요청 시 403 차단(실측 2026-08-20: 3초 간격에도 70% 차단).
//              차단되면 기다린다 — 재시도로 뚫지 않는다.
//   --stage <id>  지정 칸만 대조
//   --refresh   캐시 무효화 (fetch 모드에서만 작동)
//   --terminals 종점 검사만 돌린다 (나가는 엣지 누락 + 별칭 충돌). 오프라인 전용 로직.
//   --check     지금 고칠 수 있는 결함(T-A·별칭 충돌)이 있으면 exit 1. CI 용.
//   --verbose   종점 검사의 단방향 후보까지 펼친다 (기본은 양방향 확정만).
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

// Evolves To/From 줄에서 볼드로 등장하지만 **종이 아닌** Wikimon 문서들.
// 진화 조건 수식어로 쓰인다 — "with the X-Antibody", "one of the Seven Great
// Demon Lords" 같은 식으로 볼드가 붙는다. 종점 검사에서 후보로 잡으면
// T-B(노드 편입 필요)가 실제로 필요 없는 항목으로 오염된다.
// 실측 2026-09-02: 고유 후보 55건 중 6종 17건이 이 부류였다.
// "Whispered" 는 "Apollomon: Whispered" 로 가는 리다이렉트라 중복이다.
const NON_SPECIES_TITLES = [
  'X-Antibody',
  'Seven Great Demon Lords',
  'System Omega',
  'Whispered',
];

// 위 목록 + 문서 제목 패턴을 걸러낸다.
//
// (X-Antibody) 접미 종은 별도 종이지만 이 그래프에 없다. 그런데
// findNodeIdByTitle 이 괄호 접미사를 떼므로 "Barbamon (X-Antibody)" 가
// 기반 노드 barbamon 으로 해석되고, 같은 스테이지라 자기 자신을 가리키는
// T-C 로 잡힌다 (실측: barbamon·demon·duftmon·dynasmon·ebemon·examon·
// leviamon·minervamon 8건이 전부 이 오탐이었다). 편입하려면 별개 노드를
// 만들어야 하므로 종점 검사의 관심사가 아니다.
function isNonSpeciesTitle(name) {
  if (NON_SPECIES_TITLES.includes(name)) return true;
  if (/^Digimon\s/.test(name)) return true;      // 게임·매체 문서 (Digimon Chronicle X 등)
  if (/^V-\d+$/.test(name)) return true;         // 카드 번호
  if (/\(X-Antibody\)\s*$/.test(name)) return true;
  return false;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;
  const refresh = args.includes('--refresh');
  const fetch = args.includes('--fetch');
  const offline = args.includes('--offline') || !fetch;
  // --terminals: 종점 검사만 돌린다 (캐시만 쓰므로 네트워크 무관).
  // --check: 지금 고칠 수 있는 결함이 있으면 exit 1 (CI 용).
  const terminalsOnly = args.includes('--terminals');
  const check = args.includes('--check');
  const verbose = args.includes('--verbose');
  return { stage, refresh, offline, terminalsOnly, check, verbose };
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
  // 읽기는 표기 폴백을 허용하고, 쓰기는 항상 정확한 제목으로 한다.
  const readFile = resolveCacheFile(title);

  if (!refresh && fs.existsSync(readFile)) {
    const content = fs.readFileSync(readFile, 'utf8');
    if (content.trim().toLowerCase().startsWith('#redirect')) {
      const redirectMatch = content.match(/#redirect\s*\[\[([^\]]+)\]\]/i);
      if (redirectMatch && depth < 3) {
        fs.unlinkSync(readFile);
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

// 캐시 파일명은 Wikimon 페이지 제목(콜론·슬래시만 _ 치환)이다. 그런데
// nodeIdToWikimonTitle 은 노드 id 의 첫 글자만 대문자로 올릴 뿐 띄어쓰기를
// 복원하지 못한다 — Wikimon 은 "Geo Greymon"/"War Greymon" 처럼 띄어쓰는데
// 노드 id 는 geogreymon/wargreymon 으로 붙여쓴다.
//
// 실측 2026-09-02: 이 불일치로 **69개 노드**가 캐시를 갖고 있는데도
// "[미조회] (캐시 없음)" 으로 조용히 건너뛰어졌다. 감사가 통과한 것처럼
// 보이던 이유의 상당 부분이 이것이다.
//
// 예외 표(docs/wikimon-names.yaml)에 69줄을 손으로 넣는 대신, 캐시 디렉터리의
// 파일명을 normalize 해 인덱스를 만들어 폴백으로 쓴다. 표기 규칙이 바뀌어도
// 따라간다.
let _cacheIndex = null;
function cacheTitleIndex() {
  if (_cacheIndex) return _cacheIndex;
  _cacheIndex = new Map();
  if (!fs.existsSync(CACHE_DIR)) return _cacheIndex;
  for (const fname of fs.readdirSync(CACHE_DIR)) {
    if (!fname.endsWith('.wikitext')) continue;
    const title = fname.slice(0, -'.wikitext'.length);
    const key = normalize(title.replace(/_/g, ''));
    if (!_cacheIndex.has(key)) _cacheIndex.set(key, fname);
  }
  return _cacheIndex;
}

// 제목으로 캐시 파일 경로를 찾는다. 정확한 이름이 없으면 normalize 기준으로
// 한 번 더 찾는다. 쓰기 경로는 항상 정확한 이름을 쓴다 (writeCacheFile).
function resolveCacheFile(title) {
  const exact = path.join(CACHE_DIR, `${title.replace(/[:/]/g, '_')}.wikitext`);
  if (fs.existsSync(exact)) return exact;
  const alt = cacheTitleIndex().get(normalize(title));
  return alt ? path.join(CACHE_DIR, alt) : exact;
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
  const cacheFile = resolveCacheFile(title);
  
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

// --- 종점(terminal) 검사 -------------------------------------------------
//
// 기존 감사는 노드의 `Evolves From`(들어오는 엣지)만 대조한다. 그래서 계보가
// 최상위 아닌 칸에서 끊기는 결함 — 나가는 엣지 누락 — 을 구조적으로 못 잡는다.
// 실측 2026-09-02: 완전체 종점 4건이 감사를 통과한 채 남아 있었고, 도달 루트의
// 11.0% 가 완전체에서 끊겼다.
//
// 판정 기준은 **정본 계열 후계**다. Wikimon 은 그 디지몬 자신의 계열 후계를
// 볼드(+refd 템플릿)로 표시하고, 나머지는 게임별 파생 교차 진화다. 실측상
// 파생이 압도적으로 많아(에어로브이드라몬 27건 중 정본 2건) 구분하지 않으면
// 계열 후계가 파묻힌다 — 정본 엣지 2줄이 파생 36줄보다 초궁극체 도달률이 높았다.
//
// 방향은 둘 다 본다. docs/global-graph-plan.md §B-6 이 정본으로 정한 방향은
// **자식의 Evolves From** 이지만(부모의 Evolves To 는 조그레스 파트너 오탐이
// 절반), 종점 노드는 자식이 없으므로 그 방향만으로는 후보를 알 수 없다. 그래서:
//
//   forward : 종점 노드 자신의 Evolves To 볼드 → 후보 도출
//   reverse : 캐시 전수의 Evolves From 볼드 역참조 → 후보 도출
//   교차     : 양쪽에 다 나오면 양방향(확정), 한쪽만이면 단방향(후보)
//
// reverse 는 캐시 파일을 전수 읽지만 네트워크를 쓰지 않으므로 오프라인에서 돈다.

// 조그레스(합체 진화) 판정 — **배제가 아니라 표시다.**
//
// Wikimon 은 파트너 요구를 괄호 수식어로 쓰고, 세 형태의 의미가 다르다:
//
//   (with X)                 → X 가 반드시 필요 = 조그레스 전용
//   (with or without X)      → 단독 진화도 된다
//   (including or not ... X) → 단독 진화도 된다
//
// evolvesFrom: [{from, when}] 은 부모가 하나뿐이라 "둘 다 필요"를 표현할 수 없다.
// 그렇다고 조그레스 종이 편입 불가인 것은 **아니다** — 이 저장소에는 부모별로
// 쪼개 독립 엣지로 넣는 선례가 있다.
//
// 실측 선례 (2026-09-02):
//   · 오메가몬은 워그레이몬+메탈가루몬 조그레스인데, Wikimon l1=Ultimate 를
//     초궁극체로 **승격**시켜 두 부모와 스테이지를 인접하게 만들고 각각을
//     독립 엣지로 넣었다. 같은 승격이 15종에 적용돼 있다(§7 "초궁극체 칸 승격").
//   · 조그레스 전용 줄만 있는 엣지도 이미 2건 들어와 있다
//     (weregarurumon→boltmon, renamon→hanumon).
//   · 반면 그래프 엣지 960건 중 958건(99.8%)은 단독 가능한 줄을 갖는다 —
//     즉 조그레스 편입은 예외적 판단이고 기본값이 아니다.
//
// 그래서 이 판정의 역할은 "거르기"가 아니라 **"판단이 필요한 것을 골라내기"** 다.
// T-J 로 따로 묶어 보고하되 --check 게이트에는 넣지 않는다. 편입 여부는
// 스테이지 승격을 할 것인지와 함께 사람이 결정해야 한다.
function isJogressOnly(line) {
  if (!/\(\s*(?:with|including)\b/i.test(line)) return false;
  if (/\bor\s+without\b/i.test(line)) return false;
  if (/\bor\s+not\s+including\b/i.test(line)) return false;
  return true;
}

// 한 줄에서 볼드 위키링크를 뽑는다.
//
// headOnly=true (Evolves From 방향): 줄 머리의 볼드만 부모다. 괄호 안의 볼드는
// 조그레스 **파트너**이므로 후보가 아니다 — 실측: Grace Novamon 의
// "'''[[Apollomon]]''' (with '''[[Dianamon]]''')" 에서 Dianamon 을 후보로 잡으면
// 안 된다.
//
// headOnly=false (Evolves To 방향): 괄호 안의 볼드도 후계일 수 있으므로 전부
// 본다 — 실측: Lucemon: Falldown Mode 의 정본 후계 Lucemon: Satan Mode 는
// "'''[[Lucemon: Larva]]''' ... (including or not including
//  '''[[Lucemon: Satan Mode]]''')" 처럼 괄호 안에 있다.
function boldLinksInLine(line, headOnly) {
  const out = [];
  const re = /'''\s*\[\[\s*([^\]|#]+?)\s*(?:\|[^\]]*)?\]\]\s*'''/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const name = m[1].trim();
    if (!name || name.includes('Digimon Card Game')) continue;
    if (isNonSpeciesTitle(name)) continue;
    out.push(name);
    if (headOnly) break; // 머리 하나만
  }
  return out;
}

function extractSectionLines(wikitext, sectionName) {
  const lines = wikitext.split('\n');
  let inSection = false;
  const result = [];
  for (const line of lines) {
    if (new RegExp('^==\\s*' + sectionName + '\\s*==', 'i').test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^==/.test(line)) break;
    if (inSection && line.trim().startsWith('*')) result.push(line);
  }
  return result;
}

function cacheFileFor(title) {
  return resolveCacheFile(title);
}

// 캐시된 모든 페이지의 Evolves From 을 훑어, 어느 부모가 볼드로 지목됐는지
// 역인덱스를 만든다. 키는 normalize(부모 위키 제목), 값은 자식 위키 제목 배열.
// 캐시가 없는 페이지는 빠진다 — 오프라인 감사의 알려진 한계다.
function buildReverseBoldIndex() {
  const index = new Map();
  let scanned = 0;
  if (!fs.existsSync(CACHE_DIR)) return { index, scanned };
  for (const fname of fs.readdirSync(CACHE_DIR)) {
    if (!fname.endsWith('.wikitext')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(CACHE_DIR, fname), 'utf8');
    } catch (e) {
      continue; // 읽기 실패는 그 파일만 건너뛴다
    }
    scanned++;
    const childTitle = fname.slice(0, -'.wikitext'.length);
    for (const line of extractSectionLines(text, 'Evolves From')) {
      const jogress = isJogressOnly(line);
      // headOnly: 괄호 안 볼드는 조그레스 파트너이므로 부모가 아니다.
      for (const parent of boldLinksInLine(line, true)) {
        const key = normalize(parent);
        if (!index.has(key)) index.set(key, []);
        const list = index.get(key);
        const hit = list.find((e) => e.title === childTitle);
        // 같은 자식이 여러 줄에 나오면 하나라도 단독 가능하면 단독으로 본다.
        if (hit) hit.jogressOnly = hit.jogressOnly && jogress;
        else list.push({ title: childTitle, jogressOnly: jogress });
      }
    }
  }
  return { index, scanned };
}

// 종점 후보 위키 제목 → 노드 id.
//
// findNodeIdByTitle 은 공백만 제거하고 하이픈·콜론을 남긴다. 그래서
// "Ulforce V-dramon" 이 ulforcev-dramon 으로 나와 실제 노드 ulforcevdramon 을
// 못 찾고, 엣지 한 줄이면 되는 결함(T-A)이 노드 편입 필요(T-B)로 오분류된다
// (실측 2026-09-02: aerovdramon → ulforcevdramon 이 이 경로로 누락됐다.
//  T-A 는 --check 가 게이트하는 범주이므로 과소보고가 곧 CI 통과다).
//
// 그래서 실패 시 normalize(공백·하이픈·콜론 제거) 기준으로 한 번 더 찾는다.
// 이 인덱스는 노드 id 를 normalize 한 것이라 제목 표기 차이를 흡수한다.
function resolveTerminalTarget(name, byId, normalizedIds, nameMap) {
  const direct = findNodeIdByTitle(name, byId, nameMap);
  if (direct.id && byId.has(direct.id)) return direct.id;
  const fallback = normalizedIds.get(normalize(name));
  if (fallback) return fallback;
  return direct.id || null;
}

// 종점 노드 하나를 판정한다. 네트워크를 쓰지 않는다 (캐시만).
//
// 분류:
//   T-A  노드가 있고 스테이지가 인접 → 엣지 한 줄만 추가하면 된다 (즉시 조치 가능)
//   T-B  정본이지만 노드가 없다 → 노드 편입 필요 (도트 확보 선행)
//   T-C  스테이지 불인접 → validateGraph 의 parent-stage-mismatch 가 거부한다
function auditTerminal(node, indices, nameMap, reverseIndex, normalizedIds) {
  const { byId, stageIndex } = indices;
  const title = nodeIdToWikimonTitle(node.id, nameMap.exceptions || {});
  const cacheFile = cacheFileFor(title);

  const forward = [];
  let cached = false;
  if (fs.existsSync(cacheFile)) {
    cached = true;
    const text = fs.readFileSync(cacheFile, 'utf8');
    for (const line of extractSectionLines(text, 'Evolves To')) {
      const jogress = isJogressOnly(line);
      for (const name of boldLinksInLine(line, false)) forward.push({ name, jogressOnly: jogress });
    }
  }

  const reverse = reverseIndex.get(normalize(title)) || [];

  // 방향별 인덱스. jogressOnly 는 **양쪽 모두** 조그레스일 때만 참으로 본다 —
  // 한 방향이라도 단독 진화를 허용하면 편입 가능하다.
  const fwdBy = new Map();
  for (const f of forward) {
    const k = normalize(f.name);
    if (fwdBy.has(k)) fwdBy.get(k).jogressOnly = fwdBy.get(k).jogressOnly && f.jogressOnly;
    else fwdBy.set(k, { name: f.name, jogressOnly: f.jogressOnly });
  }
  const revBy = new Map();
  for (const r of reverse) {
    // 캐시 파일명은 콜론이 _ 로 치환돼 있으므로 되돌린다.
    revBy.set(normalize(r.title), { name: r.title.replace(/_\s*/g, ': '), jogressOnly: r.jogressOnly });
  }

  const names = new Set([
    ...[...fwdBy.values()].map((v) => v.name),
    ...[...revBy.values()].map((v) => v.name)
  ]);
  const seenFwd = new Set(fwdBy.keys());
  const seenRev = new Set(revBy.keys());

  const candidates = [];
  for (const name of names) {
    const key = normalize(name);
    const dirs = [];
    if (seenFwd.has(key)) dirs.push('forward');
    if (seenRev.has(key)) dirs.push('reverse');

    const id = resolveTerminalTarget(name, byId, normalizedIds, nameMap);
    const target = id ? byId.get(id) : null;
    const myIdx = stageIndex.get(node.stage);

    let category;
    let targetStage = null;
    if (!target) {
      category = 'T-B';
    } else {
      targetStage = target.stage;
      category = stageIndex.get(target.stage) - myIdx === 1 ? 'T-A' : 'T-C';
    }
    const f = fwdBy.get(key);
    const r = revBy.get(key);
    const sources = [f, r].filter(Boolean);
    const jogressOnly = sources.length > 0 && sources.every((x) => x.jogressOnly);

    candidates.push({
      name,
      id: id || null,
      targetStage,
      category,
      bidirectional: dirs.length === 2,
      dirs,
      jogressOnly
    });
  }

  return { node: node.id, name: node.name, stage: node.stage, title, cached, candidates };
}

// docs/wikimon-names.yaml 의 별칭이 선언한 정본 id 와, 같은 위키 제목을 slug 로
// 바꾼 id 가 **둘 다** 노드로 존재하면 같은 종이 두 노드로 갈린 것이다.
//
// 실측 근거 (2026-09-02): "Vamdemon": "myotismon" 별칭이 있는데도 #24 의 235종
// 하베스트가 vamdemon 노드를 새로 만들었다. 들어오는 엣지 11개는 vamdemon,
// 나가는 엣지 9개는 myotismon 으로 갈려 계보가 완전체에서 끊겼다. 한글명이
// 서로 달라서(묘티스몬 vs 뱀파이몬) 이름 중복 검사로는 안 잡힌다.
function auditAliasCollisions(indices, nameMap) {
  const { byId } = indices;
  const slugToId = new Map();
  for (const id of byId.keys()) slugToId.set(normalize(id), id);

  const collisions = [];
  for (const [title, canonicalId] of Object.entries(nameMap.aliases || {})) {
    const slugId = slugToId.get(normalize(title));
    if (!slugId || !byId.has(canonicalId) || slugId === canonicalId) continue;
    collisions.push({
      title,
      canonicalId,
      canonicalNode: byId.get(canonicalId),
      duplicateId: slugId,
      duplicateNode: byId.get(slugId)
    });
  }
  return collisions;
}

// 최상위가 아닌 스테이지에서 out-degree 0 인 노드를 모은다.
// 최상위(초궁극체)와 D7 로 인정된 궁극체 종점은 설계상 정상이므로 구분해 센다.
function collectTerminals(graph, indices, stages) {
  const { childrenOf } = indices;
  const topStage = stages[stages.length - 1];
  const byStage = new Map(stages.map((s) => [s, []]));
  for (const node of graph.nodes) {
    if ((childrenOf.get(node.id) || []).length > 0) continue;
    byStage.get(node.stage).push(node);
  }
  return { byStage, topStage };
}

function reportTerminals(graph, indices, nameMap, stages, opts) {
  const { byStage, topStage } = collectTerminals(graph, indices, stages);
  const { index: reverseIndex, scanned } = buildReverseBoldIndex();
  // 노드 id 를 normalize 해둔 인덱스 — 제목 표기 차이(하이픈·콜론) 흡수용.
  const normalizedIds = new Map();
  for (const id of indices.byId.keys()) normalizedIds.set(normalize(id), id);

  console.log('\n========================================');
  console.log('T. 종점 검사 (나가는 엣지 누락)');
  console.log('========================================');
  console.log(`  캐시 역스캔: ${scanned}개 페이지의 Evolves From 볼드 참조\n`);

  console.log('  스테이지별 out-degree 0:');
  for (const stage of stages) {
    const list = byStage.get(stage) || [];
    if (list.length === 0) continue;
    const note =
      stage === topStage ? ' (최상위 — 정상)' :
      stage === 'ultimate' ? ' (D7 로 인정된 궁극체 종점 포함)' : '';
    console.log(`    ${stage.padEnd(14)} ${String(list.length).padStart(3)}개${note}`);
  }

  // 검사 대상: 최상위가 아닌 종점. --stage 가 주어지면 그 칸만.
  const targets = [];
  for (const stage of stages) {
    if (stage === topStage) continue;
    if (opts.stage && stage !== opts.stage) continue;
    targets.push(...(byStage.get(stage) || []));
  }

  const tA = [];
  const tB = [];
  const tC = [];
  const tJ = [];
  const noCanon = [];
  const noCache = [];

  for (const node of targets) {
    const r = auditTerminal(node, indices, nameMap, reverseIndex, normalizedIds);
    const cands = r.candidates;
    if (!r.cached && cands.length === 0) {
      noCache.push(r);
      continue;
    }
    if (cands.length === 0) {
      noCanon.push(r);
      continue;
    }
    for (const c of cands) {
      const entry = { ...r, cand: c };
      // 조그레스 전용은 스테이지 승격까지 걸린 판단이라 --check 게이트에서 빼낸다.
      // 편입 불가라는 뜻이 아니다 — isJogressOnly 주석의 선례 참고.
      if (c.jogressOnly) {
        tJ.push(entry);
        continue;
      }
      if (c.category === 'T-A') tA.push(entry);
      else if (c.category === 'T-B') tB.push(entry);
      else tC.push(entry);
    }
  }

  const fmt = (e) => {
    const c = e.cand;
    const dir = c.bidirectional ? '양방향' : `단방향(${c.dirs.join('')})`;
    return `    ${e.node} (${e.stage}) → ${c.name}${c.id ? ` [${c.id}]` : ''}` +
           `${c.targetStage ? ` (${c.targetStage})` : ''}  ${dir}`;
  };

  console.log('\n  T-A 엣지만 추가하면 됨 (노드 존재 + 스테이지 인접):');
  if (tA.length === 0) console.log('    (없음)');
  else tA.forEach((e) => console.log(fmt(e)));

  // T-B/T-C 는 조치가 이 감사 밖(도트 확보·노드 설계)이라 길어지기만 한다.
  // 양방향 교차검증을 통과한 것만 펼치고 단방향은 접는다 — 단방향 forward 는
  // 조그레스 파트너 오탐이 섞이는 방향이라(§B-6) 신뢰도가 낮다.
  // --verbose 로 전부 펼친다.
  const showGroup = (label, list) => {
    console.log(`\n  ${label}`);
    if (list.length === 0) {
      console.log('    (없음)');
      return;
    }
    const both = list.filter((e) => e.cand.bidirectional);
    const one = list.filter((e) => !e.cand.bidirectional);
    if (both.length > 0) both.forEach((e) => console.log(fmt(e)));
    else if (!opts.verbose) console.log('    (양방향 확정 없음)');
    if (opts.verbose) {
      one.forEach((e) => console.log(fmt(e)));
    } else if (one.length > 0) {
      const nodes = [...new Set(one.map((e) => e.node))];
      console.log(`    단방향 ${one.length}건 (노드 ${nodes.length}개) — --verbose 로 펼침`);
    }
  };
  showGroup('T-B 노드 편입 필요 (정본이지만 노드 없음):', tB);
  showGroup('T-C 스테이지 불인접 (넣으면 parent-stage-mismatch):', tC);
  showGroup('T-J 조그레스 전용 (분할 편입 판단 필요 — 오메가몬 선례):', tJ);

  if (noCanon.length > 0) {
    console.log('\n  정본 후계 없음 — 진짜 종점으로 판단:');
    console.log(`    ${noCanon.map((r) => `${r.node}(${r.stage})`).join(', ')}`);
  }
  if (noCache.length > 0) {
    console.log('\n  미조회 (캐시 없음 — 판정 보류):');
    console.log(`    ${noCache.map((r) => `${r.node}(${r.stage})`).join(', ')}`);
  }

  // 별칭 충돌
  const collisions = auditAliasCollisions(indices, nameMap);
  console.log('\n========================================');
  console.log('E. 별칭 역방향 충돌 (같은 종이 두 노드로 갈림)');
  console.log('========================================');
  if (collisions.length === 0) {
    console.log('  (없음)');
  } else {
    for (const c of collisions) {
      console.log(`\n  "${c.title}" 별칭 정본 = ${c.canonicalId}`);
      console.log(`    정본  ${c.canonicalId} (${c.canonicalNode.name}) ` +
                  `부모 ${c.canonicalNode.evolvesFrom.length} / 자식 ${(indices.childrenOf.get(c.canonicalId) || []).length}`);
      console.log(`    중복  ${c.duplicateId} (${c.duplicateNode.name}) ` +
                  `부모 ${c.duplicateNode.evolvesFrom.length} / 자식 ${(indices.childrenOf.get(c.duplicateId) || []).length}`);
    }
  }

  return { tA, tB, tC, tJ, noCanon, noCache, collisions };
}

// --check 의 종료코드. 지금 바로 고칠 수 있는 결함만 실패로 본다:
//   T-A (엣지 한 줄이면 되는 종점) 과 별칭 충돌.
// T-B(도트 확보 선행)·T-C(스테이지 불인접)·미조회는 조치가 이 감사 밖이라
// 경고로만 남긴다 — 실패로 만들면 CI 가 영구히 빨간불이 된다.
function finishCheck(t, opts) {
  if (!opts.check) return;
  const blockers = t.tA.length + t.collisions.length;
  console.log('\n========================================');
  console.log('--check 판정');
  console.log('========================================');
  console.log(`  T-A (엣지만 추가하면 되는 종점): ${t.tA.length}건`);
  console.log(`  E   (별칭 역방향 충돌):          ${t.collisions.length}건`);
  if (blockers > 0) {
    console.log('  → 실패 (exit 1)');
    process.exitCode = 1;
  } else {
    console.log('  → 통과');
  }
}

async function main() {
  const opts = parseArgs();
  const graph = loadGraph();
  const stages = loadStages();
  const nameMap = loadNameMapping();

  const indices = buildIndices(graph, stages);

  if (opts.terminalsOnly) {
    console.log(`종점 검사만 (${opts.offline ? '오프라인' : '온라인'})`);
    const t = reportTerminals(graph, indices, nameMap, stages, opts);
    finishCheck(t, opts);
    return;
  }

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

  // 종점 검사 — incoming 대조로는 구조적으로 못 잡는 축이다 (헬퍼 주석 참고).
  const t = reportTerminals(graph, indices, nameMap, stages, opts);
  console.log(`\n  T-A (엣지만 추가):  ${t.tA.length}개`);
  console.log(`  T-B (노드 편입):    ${t.tB.length}개`);
  console.log(`  T-C (스테이지 불인접): ${t.tC.length}개`);
  console.log(`  T-J (조그레스 전용):  ${t.tJ.length}개`);
  console.log(`  E (별칭 충돌):      ${t.collisions.length}개`);
  finishCheck(t, opts);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
