#!/usr/bin/env node
// 임의의 디지몬 종 목록에 대해 Wikimon raw wikitext에서
//   ① 세대(Level) ② 한글명(koName) ③ `Evolves From` 부모 목록 + 각 부모의 출처 게임
// 을 뽑아 JSON으로 산출한다. 신규 노드를 evolution-graph.json에 편입할 때의 입력.
//
// 사용법:
//   node scripts/harvest-wikimon-canon.js --titles <titles.json> --out <out.json> [--refresh] [--roster-mode strict|relaxed]
//   node scripts/harvest-wikimon-canon.js --from-graph --out <out.json> [--refresh] [--roster-mode strict|relaxed]
//
// --titles <path>   Wikimon 페이지 제목 문자열 배열을 담은 JSON 파일
// --from-graph       evolution-graph.json 의 현 노드 전체를 대상으로 함
// --out <path>       결과 JSON 출력 경로
// --refresh          캐시 무효화 (재조회)
// --roster-mode <strict|relaxed>  기본 strict(기존 동작 불변).
//   strict:  ALLOWED_GAMES 화이트리스트를 통과해야 allowed=true (기존 79노드 판정).
//   relaxed: 화이트리스트로 거르지 않는다 — EXCLUDED_GAMES(Cyber Sleuth/Time
//            Stranger/Linkz/ReArise)만 계속 배제하고, 카드게임/카테고리 링크·
//            조그레스 제외도 그대로 유지한다(사용자 결정 2026-08-20, 신규
//            편입분 전용 완화). 어느 모드든 evolvesFrom 각 엣지에 games와
//            passesStrictGate(항상 strict 기준)를 같이 남겨 소급 적용/철회가
//            가능하게 한다.
//
// 로스터 게이트 판정, Evolves From 파싱, ref 태그 해석 로직은
// scripts/audit-canon-edges.js 와 동등하게 유지한다 (그 파일은 읽기만 하고 수정하지 않음).
// 배치 조회는 api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1
// (한 번에 최대 50 titles) — 실측상 차단되지 않는다. index.php?action=raw 경로는 쓰지 않는다.
// redirects=1: Wargreymon 같은 리다이렉트 스텁을 서버가 직접 해소해 최종 문서를
// 돌려준다 (호스트 실측) — query.redirects에 from→to 체인이 실려온다.
//
// 세대·한글명은 모두 인포박스({{S2|...}} 등, 첫 == 헤딩 전까지) 안의 필드에서만
// 뽑는다: 세대는 |l1=/|l2=/|l3=(l1 우선, 이견 있으면 기록), 한글명은 |ol= 의
// {{KOR}} 항목. 본문 전체를 훑으면 카드게임 Lv.3 등 노이즈가 잡힌다(호스트 실측).

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const TREE_PATH = path.join(ROOT, 'evolution-tree.json');
const NAMES_PATH = path.join(ROOT, 'docs', 'wikimon-names.yaml');
const CACHE_DIR = path.join(ROOT, '.omc', 'wikimon-cache');

// scripts/audit-canon-edges.js 와 동일 (로스터 게이트는 태그 약어가 아니라
// ref 정의의 게임 제목 문자열로 판정한다 — 같은 Dawn/Dusk가 페이지마다
// DSSM/DSMS로 다르게 쓰인다, 실측 2026-08-20).
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

// Wikimon Level 표기 → 이 저장소 stage id (evolution-tree.json 정본).
// Baby I/Baby II는 이 그래프에 별도 stage가 없어 둘 다 baby로 합친다.
const LEVEL_TO_STAGE = {
  'Baby I': 'baby',
  'Baby II': 'baby',
  Child: 'child',
  Adult: 'adult',
  Perfect: 'perfect',
  Ultimate: 'ultimate',
  'Super Ultimate': 'superultimate',
};

const BATCH_SIZE = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const titlesFile = args.includes('--titles') ? args[args.indexOf('--titles') + 1] : null;
  const fromGraph = args.includes('--from-graph');
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const refresh = args.includes('--refresh');
  const rosterMode = args.includes('--roster-mode') ? args[args.indexOf('--roster-mode') + 1] : 'strict';
  if (rosterMode !== 'strict' && rosterMode !== 'relaxed') {
    throw new Error(`--roster-mode는 strict|relaxed만 허용 (받은 값: ${rosterMode})`);
  }
  return { titlesFile, fromGraph, outPath, refresh, rosterMode };
}

function loadGraph() {
  return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
}

function loadStages() {
  return JSON.parse(fs.readFileSync(TREE_PATH, 'utf8')).stages.map((s) => s.id);
}

// --- 아래 5개 함수는 scripts/audit-canon-edges.js 의 동등 포팅. 판정이
// 달라지면 안 되므로 로직을 그대로 옮긴다 (그 파일에는 module.exports가 없어
// require로 재사용할 수 없음). ---

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

  const refRegex = /<ref\s+name=([^>]+)>([^<]+)<\/ref>/gi;
  let match;
  while ((match = refRegex.exec(wikitext)) !== null) {
    // 태그 정규화: 자기닫힘 재사용이 `<ref name="Foo" />`처럼 슬래시 앞에 공백을
    // 두는 경우가 실측 9208건 있다(전 캐시 대상) — trim 없으면 정의 쪽 키("Foo")와
    // 재사용 쪽 키("Foo ")가 어긋나 해소 실패한다.
    const tag = match[1].replace(/["']/g, '').trim();
    const content = match[2];

    const gameMatches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    for (const gm of gameMatches) {
      const game = gm[1];
      if (game.includes('Digimon Card Game')) continue;
      if (!defs.has(tag)) defs.set(tag, []);
      defs.get(tag).push(game);
    }
  }

  return defs;
}

// --- 여기서부터 판정이 audit-canon-edges.js와 갈라진다 (호스트 지시 2026-08-20).
// "동등 유지"는 착수 조건이었을 뿐 불변식은 아니었다 — 대량 편입에서는 판정
// 정확도가 우선이라, 아래 두 함수는 이 파일에서만 적용되는 개선판이다.
// audit-canon-edges.js는 여전히 건드리지 않는다.

// 템플릿({{...}})과 <ref>...</ref> 블록을 제거한 문자열을 반환한다. 조그레스
// 판정을 raw 텍스트로 하면 {{rfc|..}}/{{Note|...}} 안의 무관한 "("가 오탐을
// 낸다 (실측: Patamon← Tokomon이 조그레스로 잘못 제외됨).
function stripTemplatesAndRefs(str) {
  let s = str.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref\b[^>]*\/>/gi, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, '');
  } while (s !== prev);
  return s;
}

// 진짜 조그레스만 걸러낸다: 템플릿/ref를 뗀 본문에 "(with ... [[파트너]])" 패턴이
// 남아있을 때만 조그레스로 본다 (Wikimon 실제 관례). "with or without"는 파트너
// 없이도 진화가 성립하는 선택적 조그레스라 제외하지 않는다(기존 정책 유지 —
// claudemon은 하루 1마리라 조그레스 발동 조건이 없음, global-graph-plan §7).
function isTrueJogress(strippedLine) {
  if (/with or without/i.test(strippedLine)) return false;
  return /\(\s*(?:''')?\s*with\b[^)]*\[\[[^\]]+\]\][^)]*\)/i.test(strippedLine);
}

// 카드게임/카테고리 링크: 개체가 아니라 카드게임 색상·레벨 카테고리 페이지로
// 향하는 링크다(예: "Digimon Card Game Colors and Levels#Black Lv.5 Digimon").
// 링크 타깃에 "#"가 있거나 카테고리 접두어로 시작하면 개체 부모가 아니다.
const CATEGORY_LINK_PREFIXES = [
  'Digimon Card Game Colors',
  'Battle Spirits Card Game',
  'Digimon World: Digital Card',
  ':Category:',
];

function isCategoryLinkTarget(target) {
  if (target.includes('#')) return true;
  return CATEGORY_LINK_PREFIXES.some((p) => target.startsWith(p));
}

function parseEvolvesFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('*')) return null;

  const headMatch = trimmed.match(/^\*\s*(?:''')??\[\[([^\]]+)\]\](?:''')?/);
  if (!headMatch) return null;

  const parent = headMatch[1];
  // [[Target|Display]] 형태일 수 있으므로 카테고리 판정은 링크 타깃(파이프 앞)만 본다.
  const linkTarget = parent.includes('|') ? parent.split('|')[0].trim() : parent;

  const isCategoryLink = parent.includes('Digimon Card Game') || isCategoryLinkTarget(linkTarget);
  if (isCategoryLink) {
    return { parent, tags: [], isJogress: false, isCategoryLink: true, rawLine: trimmed };
  }

  if (isTrueJogress(stripTemplatesAndRefs(trimmed))) {
    return { parent, tags: [], isJogress: true, isCategoryLink: false, rawLine: trimmed };
  }

  const tags = [];
  const refRegex = /<ref\s+name=([^/>]+)/gi;
  let match;
  while ((match = refRegex.exec(trimmed)) !== null) {
    tags.push(match[1].replace(/["']/g, '').trim());
  }

  const inlineRefRegex = /{{ref\|''([^']+)''}}/gi;
  while ((match = inlineRefRegex.exec(trimmed)) !== null) {
    tags.push(`inline:${match[1]}`);
  }

  return { parent, tags, isJogress: false, isCategoryLink: false, rawLine: trimmed };
}

function resolveRefTags(tags, refDefs) {
  const games = new Set();
  for (const tag of tags) {
    if (tag.startsWith('inline:')) {
      games.add(tag.slice(7));
      continue;
    }
    if (refDefs.has(tag)) {
      for (const game of refDefs.get(tag)) {
        games.add(game);
      }
    }
  }
  return Array.from(games);
}

// EXCLUDED_GAMES(Cyber Sleuth/Time Stranger/Linkz/ReArise)는 로스터 범위 문제가
// 아니라 다른 세계관/리부트 계열이라, strict/relaxed 모드 공통으로 배제한다
// (사용자 결정 2026-08-20 — 신규 편입분만 화이트리스트를 완화하되 이 배제는 유지).
function filterExcludedGames(games) {
  return games.filter((g) => !EXCLUDED_GAMES.some((excluded) => g.includes(excluded)));
}

// strict: ALLOWED_GAMES 화이트리스트를 통과해야 한다 (기존 79노드 판정, 불변).
function passesRosterGate(games) {
  return filterExcludedGames(games).some((g) => ALLOWED_GAMES.some((allowed) => g.includes(allowed)));
}

// relaxed: 화이트리스트로 거르지 않는다 — EXCLUDED_GAMES만 빼고 하나라도 유효한
// 게임 인용이 남으면 통과. 카드게임/카테고리 링크·조그레스 제외는 파싱 단계에서
// 이미 걸러지므로(harvestNode 호출 전) 이 함수에는 그 후보가 들어오지 않는다.
function passesRelaxedGate(games) {
  return filterExcludedGames(games).length > 0;
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

  return { id: candidate, unmapped: false };
}

// --- 포팅 끝. 이하는 이 스크립트 고유 로직. ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheFilePathFor(title) {
  return path.join(CACHE_DIR, `${title.replace(/[:/]/g, '_')}.wikitext`);
}

function isRedirect(content) {
  return !!content && content.trim().toLowerCase().startsWith('#redirect');
}

function redirectTarget(content) {
  const m = content.match(/#redirect\s*\[\[([^\]]+)\]\]/i);
  return m ? m[1] : null;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// 배치 조회: api.php?action=query&prop=revisions&rvprop=content&rvslots=main
// &titles=A|B|C&format=json&formatversion=2 — 실측 2026-08-20, 50 titles/call,
// 1.3초에 응답, 차단 없음. index.php?action=raw 경로(3초 간격에도 70% 차단)는 쓰지 않는다.
function fetchBatchRaw(titles) {
  // redirects=1: Wikimon 리다이렉트 스텁(예: Wargreymon → War Greymon)을 서버가
  // 직접 해소해 최종 문서 content를 돌려준다 (호스트 실측). query.redirects에
  // from/to 매핑이 실려온다 — 우리가 텍스트로 #REDIRECT를 다시 파싱할 필요가 없다.
  const url = `https://wikimon.net/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&titles=${encodeURIComponent(
    titles.join('|')
  )}&format=json&formatversion=2`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // 청크마다 문자열로 이어붙이면(`data += chunk`) UTF-8 멀티바이트 문자가
        // 청크 경계에서 잘려 손상된다(한글 3바이트 문자 → U+FFFD, 실측:
        // Tentomon koName "텐���몬"). Buffer로 모아 끝에 한 번만 디코드한다.
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} (batch: ${titles.join(', ')})`));
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function pageContent(page) {
  if (!page || !page.revisions || page.revisions.length === 0) return null;
  const rev = page.revisions[0];
  return rev.slots && rev.slots.main ? rev.slots.main.content : rev.content;
}

// 단건 조회 (배치 응답이 #redirect인 경우의 체인 해소용). audit-canon-edges.js의
// fetchWikitext와 동일한 엔드포인트·재시도 정책을 쓰되, 배치 캐시와 합류하도록
// 단순화한다.
async function fetchSingle(title, depth = 0, retryCount = 0) {
  const url = `https://wikimon.net/api.php?action=query&titles=${encodeURIComponent(
    title
  )}&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&formatversion=2`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // fetchBatchRaw와 동일한 이유로 Buffer로 모아 끝에 한 번만 디코드한다.
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            if (retryCount >= 3) {
              return reject(new Error(`HTTP ${res.statusCode} after ${retryCount} retries: ${title}`));
            }
            const backoffDelay = 5000 * Math.pow(3, retryCount);
            await sleep(backoffDelay);
            try {
              resolve(await fetchSingle(title, depth, retryCount + 1));
            } catch (err) {
              reject(err);
            }
            return;
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${title}`));
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const page = json.query?.pages?.[0];
            if (!page || page.missing || !page.revisions) {
              return reject(new Error(`페이지 없음: ${title}`));
            }
            const content = pageContent(page);
            const finalTitle = page.title;

            if (isRedirect(content) && depth < 3) {
              const target = redirectTarget(content);
              if (target) {
                await sleep(1500);
                const result = await fetchSingle(target, depth + 1, 0);
                resolve({ ...result, chain: [title, ...result.chain] });
                return;
              }
            }

            resolve({ content, finalTitle, chain: depth > 0 ? [title] : [] });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

// 제목 목록을 캐시 우선 + 배치 조회로 wikitext를 채운다.
// 반환: Map(요청 title -> { content, finalTitle, chain, cached, error })
async function fetchAll(titles, refresh) {
  const result = new Map();
  const toBatch = [];

  for (const title of titles) {
    const cacheFile = cacheFilePathFor(title);
    if (!refresh && fs.existsSync(cacheFile)) {
      const content = fs.readFileSync(cacheFile, 'utf8');
      if (!isRedirect(content)) {
        result.set(title, { content, finalTitle: title, chain: [], cached: true });
        continue;
      }
      // 캐시가 리다이렉트 스텁이면 무효화하고 재조회 (audit-canon-edges.js와 동일 정책)
      fs.unlinkSync(cacheFile);
    }
    toBatch.push(title);
  }

  ensureCacheDir();

  for (const chunk of chunkArray(toBatch, BATCH_SIZE)) {
    let json;
    try {
      json = await fetchBatchRaw(chunk);
    } catch (err) {
      for (const title of chunk) {
        result.set(title, { content: null, error: err.message, cached: false });
      }
      continue;
    }

    // normalized: 대소문자/공백 정규화 (from=요청 제목 → to=정규화된 제목).
    const normalizedTo = new Map();
    for (const n of json.query?.normalized || []) {
      normalizedTo.set(n.from, n.to);
    }

    // redirects=1이면 API가 체인을 전부 따라가 query.redirects에 각 홉(from→to)을
    // 순서대로 싣고, pages에는 최종 문서 하나만 담는다 (호스트 실측 반영,
    // Wargreymon → War Greymon 등). 텍스트로 #REDIRECT를 다시 파싱할 필요가 없다.
    const redirectTo = new Map();
    for (const r of json.query?.redirects || []) {
      redirectTo.set(r.from, r.to);
    }

    const pagesByTitle = new Map();
    for (const page of json.query?.pages || []) {
      pagesByTitle.set(page.title, page);
    }

    for (const requested of chunk) {
      let current = normalizedTo.get(requested) || requested;
      const chain = [];
      while (redirectTo.has(current)) {
        chain.push(current);
        current = redirectTo.get(current);
      }

      const page = pagesByTitle.get(current);
      if (!page || page.missing) {
        result.set(requested, { content: null, error: '페이지 없음', cached: false });
        continue;
      }

      const content = pageContent(page);

      // 방어적 폴백: redirects=1로도 못 푼 잔여 #REDIRECT 텍스트 (드묾 — 이중
      // 리다이렉트가 API 한도를 넘는 경우 등)
      if (isRedirect(content)) {
        try {
          const resolved = await fetchSingle(redirectTarget(content) || page.title, 1);
          fs.writeFileSync(cacheFilePathFor(resolved.finalTitle), resolved.content);
          result.set(requested, { ...resolved, chain: [...chain, ...resolved.chain], cached: false });
          await sleep(1500);
        } catch (err) {
          result.set(requested, { content: null, error: err.message, cached: false });
        }
        continue;
      }

      fs.writeFileSync(cacheFilePathFor(page.title), content);
      result.set(requested, { content, finalTitle: page.title, chain, cached: false });
    }
  }

  return result;
}

// 인포박스 영역(첫 == 헤딩 전까지)만 잘라낸다. 세대(l1/l2..)와 |ol= 한글명은
// 모두 이 영역({{S2|...}} 등)에 있다 — 본문까지 훑으면 카드게임 Lv.3 / 게임 내
// 레벨 21 같은 노이즈가 잡힌다 (호스트 실측 2026-08-20, 재조사 금지).
function extractInfoboxRegion(wikitext) {
  const lines = wikitext.split('\n');
  const result = [];
  for (const line of lines) {
    if (line.match(/^==/)) break;
    result.push(line);
  }
  return result.join('\n');
}

// 세대(Level)는 인포박스의 |l1=, |l2=... 필드다 (l1이 1차, l2/l3는 출처별 이견).
function extractLevels(infobox) {
  const levels = [];
  const re = /\|l(\d+)=\s*([^|\n{<]+)/g;
  let match;
  while ((match = re.exec(infobox)) !== null) {
    const value = match[2].trim();
    if (value) levels.push({ index: Number(match[1]), value });
  }
  levels.sort((a, b) => a.index - b.index);
  return levels;
}

// 한글명은 인포박스 |ol= 필드의 {{KOR}} 항목에 정본으로 있다. 실측된 두 표기:
//   {{KOR}} {{j2|엔젤몬|Enjelmon ''Angelmon''}}  → "엔젤몬"
//   {{KOR}} 파닥몬 — ''Padyangmon''              → "파닥몬"
// 그래프 노드 name이 한글이라 이걸 쓰면 음역 추정이 필요 없다 — 없으면 null.
function extractKoName(infobox) {
  const olMatch = infobox.match(/\|ol=([^\n]*)/);
  if (!olMatch) return null;

  const korMatch = olMatch[1].match(/\{\{KOR\}\}\s*(.*)/);
  if (!korMatch) return null;

  const rest = korMatch[1];

  const j2Match = rest.match(/^\{\{j2\|([^|}]+)\|/);
  if (j2Match) return j2Match[1].trim() || null;

  const plainMatch = rest.match(/^([^<{]+)/);
  if (!plainMatch) return null;

  const name = plainMatch[1].split(/\s[—-]\s/)[0].trim();
  return name || null;
}

function mapLevelToStage(levels) {
  if (levels.length === 0) {
    return { stageId: null, level: null, reason: 'Level 필드 없음' };
  }
  const primary = levels[0].value;
  const stageId = LEVEL_TO_STAGE[primary] ?? null;
  if (stageId === null) {
    return { stageId: null, level: primary, reason: `매핑 실패: Wikimon Level "${primary}" 대응 stage 없음` };
  }
  const distinctValues = new Set(levels.map((l) => l.value));
  if (distinctValues.size > 1) {
    return {
      stageId,
      level: primary,
      reason: `복수 Level 표기 발견(${[...distinctValues].join(', ')}) — l1 기준(${primary}) 채택`,
    };
  }
  return { stageId, level: primary, reason: null };
}

function harvestNode(title, wikitext, graph, nameMap, rosterMode) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const stageById = new Map(graph.nodes.map((n) => [n.id, n.stage]));

  const infobox = extractInfoboxRegion(wikitext);
  const levels = extractLevels(infobox);
  const { stageId, level, reason: stageReason } = mapLevelToStage(levels);
  const koName = extractKoName(infobox);

  const evolvesFromLines = extractEvolvesFrom(wikitext);
  const refDefs = extractRefDefinitions(wikitext);

  const evolvesFrom = [];
  let excludedCount = 0;
  const exclusionReasons = [];

  for (const line of evolvesFromLines) {
    const parsed = parseEvolvesFromLine(line);
    if (!parsed) continue;
    if (parsed.isCategoryLink) {
      excludedCount += 1;
      exclusionReasons.push(`카드게임/카테고리 링크: ${parsed.parent}`);
      continue;
    }
    if (parsed.isJogress) {
      excludedCount += 1;
      exclusionReasons.push(`조그레스: ${parsed.parent}`);
      continue;
    }

    const { parent, tags, rawLine } = parsed;
    const games = resolveRefTags(tags, refDefs);
    // passesStrictGate는 모드와 무관하게 항상 기록한다 — relaxed로 들어온 엣지를
    // 나중에 소급 적용/철회할 수 있어야 한다는 것이 사용자 조건이다.
    const passesStrictGate = games.length > 0 && passesRosterGate(games);
    const passesRelaxed = games.length > 0 && passesRelaxedGate(games);
    const allowed = rosterMode === 'relaxed' ? passesRelaxed : passesStrictGate;

    const parentLookup = findNodeIdByTitle(parent, byId, nameMap);
    const parentNode = parentLookup.id ? byId.get(parentLookup.id) : null;

    if (!allowed) {
      excludedCount += 1;
      exclusionReasons.push(
        games.length === 0
          ? `${parent}: ref 태그 미해석 (게임 불명)`
          : rosterMode === 'relaxed'
            ? `${parent}: 제외 게임만 존재 (${games.join(', ')})`
            : `${parent}: 로스터 게이트 미달 (${games.join(', ')})`
      );
    }

    evolvesFrom.push({
      parent,
      parentId: parentLookup.id,
      parentInGraph: !!parentNode,
      parentStageId: parentNode ? parentNode.stage : null,
      games,
      allowed,
      passesStrictGate,
      refTags: tags,
      rawLine,
    });
  }

  return {
    title,
    level,
    levels: levels.map((l) => l.value),
    stageId,
    stageMappingNote: stageReason,
    koName,
    evolvesFrom,
    excludedCount,
    exclusionReasons,
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.titlesFile && !opts.fromGraph) {
    console.error('--titles <path> 또는 --from-graph 중 하나가 필요합니다.');
    process.exit(1);
  }
  if (!opts.outPath) {
    console.error('--out <path> 가 필요합니다.');
    process.exit(1);
  }

  const graph = loadGraph();
  loadStages(); // stage id 정본 존재 확인 (부수효과: 실패 시 예외)
  const nameMap = loadNameMapping();

  let titles;
  if (opts.fromGraph) {
    titles = graph.nodes
      .filter((n) => n.id !== 'digitama')
      .map((n) => nodeIdToWikimonTitle(n.id, nameMap.exceptions || {}));
  } else {
    titles = JSON.parse(fs.readFileSync(opts.titlesFile, 'utf8'));
  }

  console.log(`조회 대상: ${titles.length}개 (${opts.fromGraph ? 'from-graph' : opts.titlesFile}) — roster-mode=${opts.rosterMode}`);

  const fetched = await fetchAll(titles, opts.refresh);

  const records = [];
  let fetchOk = 0;
  let fetchFail = 0;
  let allowedEdges = 0;
  let excludedEdges = 0;
  const allExclusionReasons = [];

  for (const title of titles) {
    const entry = fetched.get(title);
    if (!entry || !entry.content) {
      fetchFail += 1;
      records.push({ title, error: entry ? entry.error : '조회 결과 없음' });
      console.log(`[실패] ${title}: ${entry ? entry.error : '조회 결과 없음'}`);
      continue;
    }
    fetchOk += 1;
    const record = harvestNode(title, entry.content, graph, nameMap, opts.rosterMode);
    record.finalTitle = entry.finalTitle;
    if (entry.chain && entry.chain.length > 0) record.redirectChain = entry.chain;
    records.push(record);

    allowedEdges += record.evolvesFrom.filter((e) => e.allowed).length;
    excludedEdges += record.excludedCount;
    allExclusionReasons.push(...record.exclusionReasons);

    console.log(
      `[조회] ${title}${record.finalTitle !== title ? ` → ${record.finalTitle}` : ''} — level=${record.level ?? '?'} stage=${record.stageId ?? 'null'} koName=${record.koName ?? 'null'} evolvesFrom=${record.evolvesFrom.length}`
    );
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, JSON.stringify(records, null, 2));

  const reasonCounts = new Map();
  for (const r of allExclusionReasons) {
    reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
  }
  const top5 = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  console.log('\n========================================');
  console.log('요약');
  console.log('========================================');
  console.log(`  조회 성공: ${fetchOk}개, 조회 실패: ${fetchFail}개`);
  console.log(`  로스터 통과 엣지: ${allowedEdges}개`);
  console.log(`  제외 엣지: ${excludedEdges}개`);
  if (top5.length > 0) {
    console.log('  제외 사유 top 5:');
    for (const [reason, count] of top5) {
      console.log(`    (${count}) ${reason}`);
    }
  }
  console.log(`  출력: ${opts.outPath}`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
