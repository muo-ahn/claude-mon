// Run: node --test test/sprites.test.js
//
// 그래프에 노드를 추가하고 materialize-sprites.js 를 다시 돌리지 않으면, 메뉴바가
// 팩의 척추 도트(다른 종)를 대신 보여 준다. 팩에 빠진 도트가 없는지 확인한다.

const test = require('node:test');
const assert = require('node:assert');

const { findMissingDots } = require('../scripts/materialize-sprites');
const { findNodesWithoutDot, findSuspectDots } = require('../scripts/audit-node-dots');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { spawnSync } = require('child_process');

test('sprites/nodes/ 의 도트가 필요한 모든 팩에 복사되어 있다', () => {
  const missing = findMissingDots();
  assert.deepStrictEqual(
    missing,
    [],
    `node scripts/materialize-sprites.js --write 를 실행하라. 누락 ${missing.length}장`
  );
});

test('그래프의 모든 노드에 sprites/nodes/<sprite>-0.png 도트가 있다', () => {
  const missing = findNodesWithoutDot();
  assert.deepStrictEqual(
    missing,
    [],
    `python3 scripts/fetch-wikimon-dots.py 로 도트를 받아라. 누락 ${missing.length}종: ${missing.join(', ')}`
  );
});

// --- 제외 목록(sprites/nodes-denylist.json) -------------------------------
// 파일은 읽을 때마다 검사한다(모듈 로드 시 require 로 읽으면 깨진 파일 하나가
// 이 파일 전체를 죽인다). 지금은 nodes 가 빈 객체라 대부분 자명하게 통과하며,
// 사용자가 육안 검수 후 항목을 채우면 아래 검사가 회귀를 막는다.


const ROOT = path.join(__dirname, '..');
const DENYLIST_PATH = path.join(ROOT, 'sprites', 'nodes-denylist.json');
const GRAPH_PATH = path.join(ROOT, 'evolution-graph.json');
const NODES_DIR = path.join(ROOT, 'sprites', 'nodes');

test('제외 목록 파일은 version 1 형식이고 항목이 모두 그래프 노드와 사유를 가진다', () => {
  const data = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf8'));
  assert.strictEqual(data.version, 1);
  assert.ok(data.nodes && typeof data.nodes === 'object' && !Array.isArray(data.nodes), 'nodes 는 객체여야 한다');
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const [id, reason] of Object.entries(data.nodes)) {
    assert.ok(ids.has(id), `제외 목록의 ${id} 는 그래프 노드가 아니다`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${id} 의 사유가 비었다`);
  }
});

test('제외 목록에 든 노드의 도트 파일은 삭제되지 않고 남아 있다', () => {
  const data = JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf8'));
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  for (const id of Object.keys(data.nodes)) {
    const node = graph.nodes.find((n) => n.id === id);
    assert.ok(node, `${id} 노드가 그래프에 없다`);
    assert.ok(fs.existsSync(path.join(NODES_DIR, `${node.sprite}-0.png`)), `${id} 도트 파일이 없다`);
  }
});

// 32x32 RGBA 8-bit PNG 를 만든다. alphaAt(x, y) 가 각 픽셀의 알파(0~255)다.
function crcChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height, alphaAt) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      row[1 + x * 4] = 200;
      row[2 + x * 4] = 120;
      row[3 + x * 4] = 60;
      row[4 + x * 4] = alphaAt(x, y);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    crcChunk('IHDR', ihdr),
    crcChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    crcChunk('IEND', Buffer.alloc(0))
  ]);
}

const CENTER_BLOCK = (x, y) => (x >= 8 && x < 24 && y >= 8 && y < 24 ? 255 : 0);

// 임시 그래프 하나와 도트 폴더를 만들고, 노드 id 별 PNG 버퍼를 써 넣는다.
function suspectFixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemon-suspect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodesDir = path.join(dir, 'nodes');
  const sharedDir = path.join(dir, 'shared');
  fs.mkdirSync(nodesDir);
  fs.mkdirSync(sharedDir);
  const nodes = [];
  for (const [id, buf] of Object.entries(files)) {
    nodes.push({ id, sprite: id, stage: 'child', name: id, evolvesFrom: [] });
    fs.writeFileSync(path.join(nodesDir, `${id}-0.png`), buf);
  }
  const graphPath = path.join(dir, 'graph.json');
  fs.writeFileSync(graphPath, JSON.stringify({ nodes }));
  return { graphPath, nodesDir, sharedDir };
}

function reasonOf(found, id) {
  const hit = found.find((f) => f.id === id);
  return hit ? hit.reason : null;
}

test('findSuspectDots 는 정상 도트를 후보로 올리지 않는다', (t) => {
  const f = suspectFixture(t, { normal: makePng(32, 32, CENTER_BLOCK) });
  assert.deepStrictEqual(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), []);
});

test('findSuspectDots 는 완전 투명 도트를 빈 이미지로 잡는다', (t) => {
  const f = suspectFixture(t, { empty: makePng(32, 32, () => 0) });
  assert.match(reasonOf(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), 'empty') || '', /빈 이미지/);
});

test('findSuspectDots 는 불투명 픽셀이 극단적으로 적은 도트를 잡는다', (t) => {
  const f = suspectFixture(t, { sparse: makePng(32, 32, (x, y) => (x === 16 && y === 16 ? 255 : 0)) });
  assert.match(reasonOf(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), 'sparse') || '', /불투명 픽셀 부족/);
});

test('findSuspectDots 는 좌우 가장자리 열에 불투명 픽셀이 붙은 도트를 잘림 의심으로 잡는다', (t) => {
  // 왼쪽 열 y 4~11 여덟 픽셀. 한 픽셀만 닿는 경우는 잘림이 아니므로 잡지 않는다.
  const edge = (x, y) => (CENTER_BLOCK(x, y) || (x === 0 && y >= 4 && y < 12) ? 255 : 0);
  const f = suspectFixture(t, { clipped: makePng(32, 32, edge) });
  assert.match(reasonOf(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), 'clipped') || '', /가장자리 접촉/);
});

test('findSuspectDots 는 32x32 가 아닌 도트를 크기 이상으로 잡는다', (t) => {
  const f = suspectFixture(t, { small: makePng(16, 16, CENTER_BLOCK) });
  assert.match(reasonOf(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), 'small') || '', /크기/);
});

test('findSuspectDots 는 PNG 로 해독되지 않는 파일을 깨짐으로 잡는다', (t) => {
  const f = suspectFixture(t, { broken: Buffer.from('not a png at all') });
  assert.match(reasonOf(findSuspectDots(f.graphPath, f.nodesDir, f.sharedDir), 'broken') || '', /깨짐/);
});

test('findSuspectDots 는 실제 그래프 325노드를 예외 없이 검사하고 후보 수는 노드 수를 넘지 않는다', () => {
  const found = findSuspectDots();
  assert.ok(Array.isArray(found));
  assert.ok(found.length <= 325, `후보 ${found.length}`);
});

test('audit-node-dots --suspects 는 종료 코드 0 으로 후보 수 요약을 stdout 에 쓴다', () => {
  const script = path.join(ROOT, 'scripts', 'audit-node-dots.js');
  const res = spawnSync(process.execPath, [script, '--suspects'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /후보 \d+종/);
});

test('audit-node-dots 기본 실행은 기존처럼 누락이 없으면 종료 코드 0 이다', () => {
  const script = path.join(ROOT, 'scripts', 'audit-node-dots.js');
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
});
