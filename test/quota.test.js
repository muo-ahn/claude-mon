// Run: node --test test/quota.test.js
//
// 쿼터 페이싱 단위 테스트. 핵심은 "같은 잔여%라도 리셋까지 남은 시간에 따라
// 정반대 판정이 나와야 한다" 는 것 — 절대 잔여%로 판정하던 이전 표시의 결함이다.

const test = require('node:test');
const assert = require('node:assert');

const {
  HOUR,
  DAY,
  windowSeconds,
  labelForBucket,
  classify,
  paceForBucket,
  summarize,
  formatPace
} = require('../lib/quota');

const NOW = 1_787_800_000;

function weekly(used, leftSec) {
  return { used_percentage: used, resets_at: NOW + leftSec };
}

// --- 창 길이 추정 -------------------------------------------------------

test('windowSeconds는 키 문자열로 창을 고르고 모르는 키는 주간으로 본다', () => {
  assert.strictEqual(windowSeconds('five_hour'), 5 * HOUR);
  assert.strictEqual(windowSeconds('seven_day'), 7 * DAY);
  // 모델별 주간 버킷이 추가돼도 주간으로 잡혀야 한다.
  assert.strictEqual(windowSeconds('seven_day_opus'), 7 * DAY);
  assert.strictEqual(windowSeconds('totally_unknown'), 7 * DAY);
});

test('labelForBucket은 모르는 키를 삼키지 않고 원문을 되돌린다', () => {
  assert.strictEqual(labelForBucket('five_hour'), '5h');
  assert.strictEqual(labelForBucket('seven_day'), '주간');
  assert.strictEqual(labelForBucket('seven_day_opus'), 'Opus 주간');
  assert.strictEqual(labelForBucket('mystery'), 'mystery');
});

// --- pace 계산 ----------------------------------------------------------

test('pace 1.0은 리셋 시각에 딱 소진하는 페이스다', () => {
  // 절반 남은 창에 절반 남은 쿼터 = 정확히 온페이스.
  const b = paceForBucket('seven_day', weekly(50, 3.5 * DAY), NOW);
  assert.ok(Math.abs(b.pace - 1.0) < 0.001);
  assert.strictEqual(b.mode, 'normal');
});

test('같은 잔여 36%라도 리셋 직전이면 여유, 주 초면 고갈 궤도다', () => {
  const nearReset = paceForBucket('seven_day', weekly(64, 10 * HOUR), NOW);
  const weekStart = paceForBucket('seven_day', weekly(64, 6 * DAY), NOW);
  assert.strictEqual(nearReset.headroom, weekStart.headroom);
  assert.strictEqual(nearReset.mode, 'surplus');
  assert.strictEqual(weekStart.mode, 'deficit');
});

test('잔여 바닥은 deficit, 단 pace가 이미 여유면 예외', () => {
  assert.strictEqual(classify(0.1, 3), 'deficit');
  // 곧 리셋 — 남은 3%는 어차피 사라지므로 경고 대상이 아니다.
  assert.strictEqual(classify(Infinity, 3), 'surplus');
});

test('회귀: 리셋 30분 전 잔여 4%는 여유다 (고정 유예 시간으로는 못 가름)', () => {
  // 7일 창에서 30분은 0.3% — 어떤 고정 유예 상수를 골라도 주간 버킷은 늘 유예
  // 밖으로 떨어져, 태워야 하는 구간에서 마스코트가 쓰러지고 경고가 떴다.
  const b = paceForBucket('seven_day', weekly(96, 0.5 * HOUR), NOW);
  assert.ok(b.pace > 2, `pace ${b.pace} should be surplus-grade`);
  assert.strictEqual(b.mode, 'surplus');
  // 같은 잔여 4%라도 이틀 남았으면 정반대 판정이어야 한다.
  assert.strictEqual(paceForBucket('seven_day', weekly(96, 2 * DAY), NOW).mode, 'deficit');
});

test('시계 어긋남으로 남은 시간이 창보다 길어도 창 길이로 잘린다', () => {
  const b = paceForBucket('seven_day', weekly(0, 30 * DAY), NOW);
  assert.strictEqual(b.leftSec, 7 * DAY);
  assert.ok(Math.abs(b.pace - 1.0) < 0.001);
});

test('형식이 깨진 버킷은 0%로 오해하지 않고 건너뛴다', () => {
  assert.strictEqual(paceForBucket('seven_day', {}, NOW), null);
  assert.strictEqual(paceForBucket('seven_day', { used_percentage: 'x', resets_at: NOW }, NOW), null);
  assert.strictEqual(paceForBucket('seven_day', null, NOW), null);
});

// --- 요약: 어느 버킷이 모드를 정하는가 ----------------------------------

test('모드는 장주기 버킷이 정한다 — 5h가 여유를 가리지 않는다', () => {
  const s = summarize(
    {
      five_hour: { used_percentage: 30, resets_at: NOW + 1.8 * HOUR },
      seven_day: weekly(64, 10 * HOUR)
    },
    NOW
  );
  // 5h pace(약 1.9x)가 주간 pace(약 6x)보다 낮지만 지배 버킷은 주간이어야 한다.
  assert.strictEqual(s.governing.key, 'seven_day');
  assert.strictEqual(s.mode, 'surplus');
  assert.strictEqual(s.hourlyRisk.length, 0);
});

test('주간이 여유여도 5h가 위험하면 hourlyRisk로 따로 보고된다', () => {
  const s = summarize(
    {
      five_hour: { used_percentage: 95, resets_at: NOW + 4 * HOUR },
      seven_day: weekly(64, 10 * HOUR)
    },
    NOW
  );
  assert.strictEqual(s.mode, 'surplus');
  assert.deepStrictEqual(s.hourlyRisk.map((b) => b.key), ['five_hour']);
});

test('주간 버킷이 여럿이면 가장 빡빡한 쪽이 지배한다', () => {
  const s = summarize(
    { seven_day: weekly(40, 3 * DAY), seven_day_opus: weekly(88, 3 * DAY) },
    NOW
  );
  assert.strictEqual(s.governing.key, 'seven_day_opus');
  assert.strictEqual(s.mode, 'deficit');
});

test('장주기 버킷이 하나도 없으면 시간 버킷으로 폴백한다', () => {
  const s = summarize({ five_hour: { used_percentage: 95, resets_at: NOW + 4 * HOUR } }, NOW);
  assert.strictEqual(s.governing.key, 'five_hour');
  assert.strictEqual(s.mode, 'deficit');
});

test('rate_limits가 없거나 비면 null — 표시를 생략할 수 있어야 한다', () => {
  assert.strictEqual(summarize(undefined, NOW), null);
  assert.strictEqual(summarize({}, NOW), null);
  assert.strictEqual(summarize({ bad: {} }, NOW), null);
});

test('formatPace는 무한대를 숫자로 뭉개지 않는다', () => {
  assert.strictEqual(formatPace(6.04), '6.0x');
  assert.strictEqual(formatPace(Infinity), '∞');
});
