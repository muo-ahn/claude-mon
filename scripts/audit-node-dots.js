#!/usr/bin/env node
// 그래프의 모든 노드에 sprites/nodes/<sprite>-0.png 가 있는지 검사한다.
// 종을 그래프에 편입하면서 도트 수집을 빠뜨리면 메뉴바가 이전 단계 도트를 대신 보여 준다.
//
// 실행: node scripts/audit-node-dots.js
// 누락이 있으면 목록을 출력하고 종료 코드 1 로 끝난다.
// digitama 처럼 공용 도트를 쓰는 단계는 sprites/shared/ 를 본다.
//
// 실행: node scripts/audit-node-dots.js --suspects
// 육안 검수 후보를 stdout 으로만 낸다(노드id<TAB>사유, 끝에 건수 요약). 종료 코드는 0.
// 파일로 쓰지 않고 제외 목록(sprites/nodes-denylist.json)에도 넣지 않는다.
// 휴리스틱이라 "다른 종처럼 보임" 같은 판정은 못 한다. 그건 사용자 육안 몫이다.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');
const SHARED_DIR = path.join(ROOT, 'sprites', 'shared');
const SHARED_STAGES = new Set(['digitama']);

function findNodesWithoutDot(graphPath = GRAPH_PATH, nodesDir = NODES_DIR, sharedDir = SHARED_DIR) {
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  return graph.nodes
    .filter((node) => {
      const dir = SHARED_STAGES.has(node.stage) ? sharedDir : nodesDir;
      return !fs.existsSync(path.join(dir, `${node.sprite}-0.png`));
    })
    .map((node) => node.id);
}

// 누락이 있으면 목록을 출력하고 false 를 돌려준다.
function auditNodeDots() {
  const missing = findNodesWithoutDot();
  if (missing.length === 0) return true;
  console.error(`도트(sprites/nodes/<sprite>-0.png) 누락 ${missing.length}종: ${missing.join(', ')}`);
  console.error('python3 scripts/fetch-wikimon-dots.py 로 도트를 받은 뒤 다시 실행하라.');
  return false;
}

// --- 육안 검수 후보(--suspects) ------------------------------------------
// 목적은 사람이 볼 목록을 좁히는 것이다. 판정이 아니다. 임계값은 실제 325노드
// 분포를 찍어 극단값만 걸리도록 정했다(아래 상수 주석 참고).

const DOT_SIZE = 32;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 알파가 이 값 이상이면 불투명 픽셀로 센다.
const OPAQUE_ALPHA = 128;
// 불투명 픽셀이 이보다 적으면 "부족"으로 본다. 실측 최소는 102(mamemon), 극단값만 건진다.
const MIN_OPAQUE_PIXELS = 40;
// 좌우 가장자리 열에 이만큼 이상 불투명 픽셀이 붙으면 "잘림 의심"으로 본다.
// 실측: 위쪽 가장자리는 날개와 머리 때문에 174종이 닿고, 아래쪽은 땅 그림자로 322종이
// 닿아서 쓸 수 없다. 좌우 열은 3 이상이 10종(약 3%)이라 후보 목록이 된다.
const EDGE_COLUMN_PIXELS = 3;

// PNG 청크를 나눠 IHDR 과 IDAT 를 모은다. 시그니처가 없거나 청크가 잘리면 throw.
function parsePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG 시그니처 없음');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error('청크 잘림');
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('IHDR 없음');
  return { header, idat: Buffer.concat(idat) };
}

// PNG 필터 예측값. 필터 종류 4(Paeth) 의 선택 규칙이 PNG 명세와 같아야 한다.
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterPredictor(filter, left, up, upLeft) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: return paethPredictor(left, up, upLeft);
    default: throw new Error(`알 수 없는 필터 ${filter}`);
  }
}

// 스캔라인 필터를 풀어 픽셀 바이트 배열을 돌려준다. bpp 는 픽셀당 바이트 수.
function unfilterRows(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) throw new Error('스캔라인 크기 불일치');
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      out[dst + x] = raw[src + x] + filterPredictor(filter, left, up, upLeft);
    }
  }
  return out;
}

// 도트를 해독해 크기와 알파 배열을 돌려준다. RGBA 8-bit 비인터레이스가 아니면
// alpha 는 null 이다. PNG 로 읽을 수 없으면 throw 한다.
function decodeDotAlpha(buf) {
  const { header, idat } = parsePng(buf);
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    return { width, height, alpha: null };
  }
  const pixels = unfilterRows(zlib.inflateSync(idat), width, height, 4);
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  return { width, height, alpha };
}

// 한 도트의 의심 사유 목록. 빈 배열이면 후보가 아니다.
function suspectReasons(buf) {
  let decoded;
  try {
    decoded = decodeDotAlpha(buf);
  } catch (e) {
    return ['깨짐'];
  }
  const { width, height, alpha } = decoded;
  const reasons = [];
  if (width !== DOT_SIZE || height !== DOT_SIZE) reasons.push(`크기 ${width}x${height}`);
  if (alpha === null) {
    reasons.push('형식 RGBA8 아님');
    return reasons;
  }
  let opaque = 0;
  let leftColumn = 0;
  let rightColumn = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] < OPAQUE_ALPHA) continue;
      opaque++;
      if (x === 0) leftColumn++;
      if (x === width - 1) rightColumn++;
    }
  }
  if (opaque === 0) reasons.push('빈 이미지');
  else if (opaque < MIN_OPAQUE_PIXELS) reasons.push(`불투명 픽셀 부족 (${opaque})`);
  if (leftColumn >= EDGE_COLUMN_PIXELS || rightColumn >= EDGE_COLUMN_PIXELS) reasons.push('가장자리 접촉(좌우 잘림 의심)');
  return reasons;
}

// 그래프 노드 중 의심 사유가 있는 노드를 [{ id, reason }] 로 돌려준다.
// 도트 파일이 없는 노드는 '도트 없음' 으로 올린다(findNodesWithoutDot 과 같은 경로).
function findSuspectDots(graphPath = GRAPH_PATH, nodesDir = NODES_DIR, sharedDir = SHARED_DIR) {
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const suspects = [];
  for (const node of graph.nodes) {
    const dir = SHARED_STAGES.has(node.stage) ? sharedDir : nodesDir;
    const file = path.join(dir, `${node.sprite}-0.png`);
    if (!fs.existsSync(file)) {
      suspects.push({ id: node.id, reason: '도트 없음' });
      continue;
    }
    const reasons = suspectReasons(fs.readFileSync(file));
    if (reasons.length > 0) suspects.push({ id: node.id, reason: reasons.join(', ') });
  }
  return suspects;
}

// --suspects 출력. stdout 만 쓴다.
function printSuspects() {
  const suspects = findSuspectDots();
  for (const s of suspects) process.stdout.write(`${s.id}\t${s.reason}\n`);
  const total = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8')).nodes.length;
  process.stdout.write(`후보 ${suspects.length}종 / 전체 ${total}종 (육안 검수 대상. 자동 제외 아님)\n`);
}

if (require.main === module) {
  if (process.argv.includes('--suspects')) {
    printSuspects();
    process.exit(0);
  }
  process.exit(auditNodeDots() ? 0 : 1);
}

module.exports = {
  findNodesWithoutDot,
  auditNodeDots,
  findSuspectDots,
  decodeDotAlpha,
  suspectReasons
};
