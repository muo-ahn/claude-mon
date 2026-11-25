#!/usr/bin/env node
// C7: apocalymon 단일 자식 완전체 10개에, Wikimon 원작에서 그 완전체를 Evolves From 으로
// 갖는 최종체(superultimate) 엣지를 {from, when:null} 로 더한다 (결정 D-19).
//
// 사용법:
//   node scripts/add-apocalymon-fanout.js            # 후보와 근거만 출력 (dry-run)
//   node scripts/add-apocalymon-fanout.js --write    # evolution-graph.json 에 엣지 추가
//   --cache <dir>   Wikimon wikitext 캐시 경로 (기본 .omc/wikimon-cache, 네트워크 조회 없음)
//   --allow-jogress-for-apocalymon-parents
//                   결정 D-20 예외: 위 10개 완전체가 원작 조그레스 "(with ...)" 재료로 등장하는
//                   최종체에 한해 조그레스 줄도 근거로 인정한다. 끄면(기본) 조그레스 줄은
//                   global-graph-plan §7 정책대로 제외되어 후보 0건이다. 다른 노드에는 영향 없다.
//
// 판정(Evolves From 파싱·ref 게임 해석·로스터 게이트)은 scripts/harvest-wikimon-canon.js 와 같다.
// 도트가 있고 sprites/nodes-denylist.json 에 없는 최종체만 대상이다. 기존 엣지는 지우지 않는다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const NAMES_PATH = path.join(ROOT, 'docs', 'wikimon-names.yaml');
const DENYLIST_PATH = path.join(ROOT, 'sprites', 'nodes-denylist.json');
const NODE_SPRITES_DIR = path.join(ROOT, 'sprites', 'nodes');

const PARENTS = [
  'ancientmegatheriumon',
  'ancientmermaimon',
  'ancientsphinxmon',
  'ancienttroiamon',
  'ancientvolcamon',
  'gigaseadramon',
  'metalseadramon',
  'mugendramon',
  'piemon',
  'pinochimon',
];

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
const CATEGORY_LINK_PREFIXES = [
  'Digimon Card Game Colors',
  'Battle Spirits Card Game',
  'Digimon World: Digital Card',
  ':Category:',
];

// 노드 id 규칙으로 Wikimon 제목이 안 나오는 최종체의 캐시 페이지 제목 (캐시 파일명 실측).
const TITLE_OVERRIDES = {
  'beelzebumon-bm': 'Beelzebumon: Blast Mode',
  belialvamdemon: 'Belial Vamdemon',
  belphemon_ragemode: 'Belphemon: Rage Mode',
  miragegaogamon_burstmode: 'Mirage Gaogamon: Burst Mode',
  rosemon_burstmode: 'Rosemon: Burst Mode',
  zeedmillenniumon: 'Zeed Millenniumon',
  death_x_dorugoramon: 'Death-X-DORUgoramon',
  grandiskuwagamon: 'Grandis Kuwagamon',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const cacheIdx = args.indexOf('--cache');
  return {
    write: args.includes('--write'),
    allowJogress: args.includes('--allow-jogress-for-apocalymon-parents'),
    cacheDir: cacheIdx >= 0 ? args[cacheIdx + 1] : path.join(ROOT, '.omc', 'wikimon-cache'),
  };
}

function loadNameMapping() {
  const exceptions = {};
  const aliases = {};
  if (!fs.existsSync(NAMES_PATH)) return { exceptions, aliases };
  let section = null;
  for (const line of fs.readFileSync(NAMES_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed === 'exceptions:') { section = 'exceptions'; continue; }
    if (trimmed === 'aliases:') { section = 'aliases'; continue; }
    if (section && (line.startsWith(' ') || line.startsWith('\t'))) {
      const match = trimmed.match(/^"?([^:"]+)"?:\s*"?([^"]+)"?$/);
      if (match) {
        (section === 'exceptions' ? exceptions : aliases)[match[1].trim()] = match[2].trim();
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
    _fm: ': Fighter Mode', _dm: ': Dragon Mode', _pm: ': Paladin Mode', _hm: ': Holy Mode',
    _burst: ': Burst Mode', _crimson: ': Crimson Mode', '-bm': ': Burst Mode', '-black': ' Black',
  };
  let title = id;
  for (const [suffix, replacement] of Object.entries(modeMap)) {
    if (title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length) + replacement;
      break;
    }
  }
  if (title.startsWith('black') && !title.includes(':')) title = 'Black' + title.slice(5);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function titleToNodeId(title, nameMap) {
  if (nameMap.aliases[title]) return nameMap.aliases[title];
  for (const [id, wikiTitle] of Object.entries(nameMap.exceptions)) {
    if (wikiTitle === title) return id;
  }
  let c = title.toLowerCase().replace(/\s*\([^)]+\)\s*$/g, '');
  c = c.replace(/: fighter mode/i, '_fm').replace(/: dragon mode/i, '_dm')
    .replace(/: paladin mode/i, '_pm').replace(/: holy mode/i, '_hm')
    .replace(/: burst mode/i, '-bm').replace(/: blast mode/i, '-bm')
    .replace(/: crimson mode/i, '_crimson').replace(/ black$/i, '-black');
  return c.replace(/\s+/g, '');
}

function extractEvolvesFrom(wikitext) {
  const result = [];
  let inSection = false;
  for (const line of wikitext.split('\n')) {
    if (/^==\s*Evolves From\s*==/i.test(line)) { inSection = true; continue; }
    if (inSection && /^==/.test(line)) break;
    if (inSection && line.trim()) result.push(line);
  }
  return result;
}

function extractRefDefinitions(wikitext) {
  const defs = new Map();
  const refRegex = /<ref\s+name=([^>]+)>([^<]+)<\/ref>/gi;
  let match;
  while ((match = refRegex.exec(wikitext)) !== null) {
    const tag = match[1].replace(/["']/g, '').trim();
    for (const gm of match[2].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      if (gm[1].includes('Digimon Card Game')) continue;
      if (!defs.has(tag)) defs.set(tag, []);
      defs.get(tag).push(gm[1]);
    }
  }
  return defs;
}

function stripTemplatesAndRefs(str) {
  let s = str.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref\b[^>]*\/>/gi, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, '');
  } while (s !== prev);
  return s;
}

function isTrueJogress(strippedLine) {
  if (/with or without/i.test(strippedLine)) return false;
  return /\(\s*(?:''')?\s*with\b[^)]*\[\[[^\]]+\]\][^)]*\)/i.test(strippedLine);
}

function isCategoryLinkTarget(target) {
  return target.includes('#') || CATEGORY_LINK_PREFIXES.some((p) => target.startsWith(p));
}

function parseEvolvesFromLine(line, allowJogress) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('*')) return null;
  const headMatch = trimmed.match(/^\*\s*(?:''')??\[\[([^\]]+)\]\](?:''')?/);
  if (!headMatch) return null;
  const parent = headMatch[1];
  const linkTarget = parent.includes('|') ? parent.split('|')[0].trim() : parent;
  if (parent.includes('Digimon Card Game') || isCategoryLinkTarget(linkTarget)) return null;
  const stripped = stripTemplatesAndRefs(trimmed);
  const jogress = isTrueJogress(stripped);
  if (jogress && !allowJogress) return null;
  const tags = [];
  let match;
  const refRegex = /<ref\s+name=([^/>]+)/gi;
  while ((match = refRegex.exec(trimmed)) !== null) tags.push(match[1].replace(/["']/g, '').trim());
  const inlineRefRegex = /{{ref\|''([^']+)''}}/gi;
  while ((match = inlineRefRegex.exec(trimmed)) !== null) tags.push(`inline:${match[1]}`);
  const materials = [linkTarget];
  if (jogress) {
    for (const m of stripped.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) materials.push(m[1].trim());
  }
  return { parent: linkTarget, materials, jogress, tags };
}

function resolveGames(tags, refDefs) {
  const games = new Set();
  for (const tag of tags) {
    if (tag.startsWith('inline:')) games.add(tag.slice(7));
    else if (refDefs.has(tag)) refDefs.get(tag).forEach((g) => games.add(g));
  }
  return [...games];
}

function passesStrictGate(games) {
  const kept = games.filter((g) => !EXCLUDED_GAMES.some((x) => g.includes(x)));
  return kept.some((g) => ALLOWED_GAMES.some((a) => g.includes(a)));
}

function cachePathFor(cacheDir, title) {
  return path.join(cacheDir, `${title.replace(/[:/]/g, '_')}.wikitext`);
}

function findCandidates(graph, nameMap, cacheDir, denylist, allowJogress) {
  const parentSet = new Set(PARENTS);
  const candidates = [];
  const skipped = [];
  for (const node of graph.nodes.filter((n) => n.stage === 'superultimate')) {
    const title = TITLE_OVERRIDES[node.id] || nodeIdToWikimonTitle(node.id, nameMap.exceptions);
    const file = cachePathFor(cacheDir, title);
    if (!fs.existsSync(file)) {
      skipped.push({ id: node.id, reason: `캐시 없음 (${title})` });
      continue;
    }
    const wikitext = fs.readFileSync(file, 'utf8');
    const refDefs = extractRefDefinitions(wikitext);
    for (const line of extractEvolvesFrom(wikitext)) {
      const parsed = parseEvolvesFromLine(line, allowJogress);
      if (!parsed) continue;
      const froms = [...new Set(parsed.materials.map((m) => titleToNodeId(m, nameMap)))].filter((f) => parentSet.has(f));
      const games = resolveGames(parsed.tags, refDefs);
      for (const from of froms) {
      const hasDot = fs.existsSync(path.join(NODE_SPRITES_DIR, `${node.id}-0.png`));
      candidates.push({
        from,
        to: node.id,
        page: path.basename(file),
        games,
        strictGate: games.length > 0 && passesStrictGate(games),
        hasDot,
        denied: !!(denylist.nodes && denylist.nodes[node.id]),
        alreadyEdge: node.evolvesFrom.some((e) => e.from === from),
        jogress: parsed.jogress,
      });
      }
    }
  }
  return { candidates, skipped };
}

function main() {
  const opts = parseArgs();
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const denylist = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf8'));
  const nameMap = loadNameMapping();
  const { candidates, skipped } = findCandidates(graph, nameMap, opts.cacheDir, denylist, opts.allowJogress);

  for (const s of skipped) console.log(`[건너뜀] ${s.id}: ${s.reason}`);
  const eligible = candidates.filter((c) => c.hasDot && !c.denied && !c.alreadyEdge && (c.jogress || c.strictGate));
  for (const c of candidates) {
    const ok = eligible.includes(c) ? 'ADD' : 'SKIP';
    console.log(
      `[${ok}] ${c.from} -> ${c.to} (${c.page}) dot=${c.hasDot} denied=${c.denied} exists=${c.alreadyEdge} jogress=${c.jogress} strict=${c.strictGate} games=${c.games.join('|')}`
    );
  }
  console.log(`후보 ${candidates.length}개, 추가 대상 ${eligible.length}개`);

  if (!opts.write) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const added = new Set();
  for (const c of eligible) {
    const key = `${c.from}>${c.to}`;
    if (added.has(key)) continue;
    added.add(key);
    byId.get(c.to).evolvesFrom.push({ from: c.from, when: null });
  }
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n');
  console.log(`evolution-graph.json 에 ${added.size}개 엣지 추가`);
}

main();
