// Run: node --test test/sprites.test.js
//
// 그래프에 노드를 추가하고 materialize-sprites.js 를 다시 돌리지 않으면, 메뉴바가
// 팩의 척추 도트(다른 종)를 대신 보여 준다. 팩에 빠진 도트가 없는지 확인한다.

const test = require('node:test');
const assert = require('node:assert');

const { findMissingDots } = require('../scripts/materialize-sprites');
const { findNodesWithoutDot } = require('../scripts/audit-node-dots');

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
