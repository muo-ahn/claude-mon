'use strict';
// 쿼터 페이싱 — 잔여 쿼터를 "리셋까지 남은 시간" 으로 나눠, 지금이 아낄 구간인지
// 태울 구간인지 판정한다.
//
//   pace = 잔여% / (남은시간 ÷ 창길이 × 100)
//
// 1.0 이면 리셋 시각에 정확히 100% 를 쓰는 페이스다. 남은 쿼터는 리셋과 함께
// 소멸하므로 리셋 직전의 큰 잔여(pace 높음)는 아끼면 순손실이고, 주 초의 같은
// 잔여(pace 낮음)는 고갈 경고다. 절대 잔여%만으로는 이 비대칭을 표현할 수 없다.
//
// 같은 공식과 임계치를 ~/.claude/hooks/session_budget_nudge.py 와
// menubar/claudemon-menubar.swift 가 공유한다. 한쪽만 고치면 표시와 경고가 어긋난다.

const HOUR = 3600;
const DAY = 24 * HOUR;

// 모드 경계. 훅과 동일해야 한다.
const PACE_SURPLUS = 2.0;
const PACE_TIGHT = 1.0;
const PACE_DEFICIT = 0.7;
const HEADROOM_FLOOR = 5;


// 버킷 키는 고정이 아니다 — 모델별 주간 버킷(seven_day_opus 등)이 추가되는
// 방향이므로 문자열로 판정하고, 모르는 키는 주간으로 본다.
function windowSeconds(key) {
  const lower = String(key).toLowerCase();
  if (lower.includes('five_hour') || lower.includes('5h')) return 5 * HOUR;
  if (lower.includes('hour')) return HOUR;
  return 7 * DAY;
}

function labelForBucket(key) {
  if (key === 'five_hour') return '5h';
  if (key === 'seven_day') return '주간';
  const lower = String(key).toLowerCase();
  if (lower.includes('opus')) return 'Opus 주간';
  if (lower.includes('fable')) return 'Fable 주간';
  return String(key);
}

function classify(pace, headroom) {
  // 잔여가 바닥이면 deficit — 단 pace 가 이미 여유면 제외한다. 잔여 4% 라도
  // 리셋 30분 전이면 태우지 않는 쪽이 손해이고, 고정 유예 시간(예: 15분)으로는
  // 이걸 가를 수 없다. 7일 창에서 30분은 창의 0.3% 라 어떤 상수를 골라도
  // 주간 버킷에서는 항상 유예 밖으로 떨어진다. 남은 시간이 아니라 페이스가 기준이다.
  if (headroom <= HEADROOM_FLOOR && pace < PACE_SURPLUS) return 'deficit';
  if (pace >= PACE_SURPLUS) return 'surplus';
  if (pace >= PACE_TIGHT) return 'normal';
  if (pace >= PACE_DEFICIT) return 'tight';
  return 'deficit';
}

const MODE_LABEL = { surplus: '여유', normal: '적정', tight: '빠듯', deficit: '과속' };

function modeLabel(mode) {
  return MODE_LABEL[mode] || mode;
}

// 단일 버킷 → 페이스 정보. 형식이 깨진 버킷은 null (0% 로 오해하지 않도록 건너뛴다).
function paceForBucket(key, bucket, nowSec) {
  if (!bucket || typeof bucket !== 'object') return null;
  const used = Number(bucket.used_percentage);
  const resetsAt = Number(bucket.resets_at);
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;

  const window = windowSeconds(key);
  // 로컬/서버 시계가 어긋나 남은 시간이 창보다 길게 나오면 창 길이로 자른다.
  const leftSec = Math.min(Math.max(0, resetsAt - nowSec), window);
  const headroom = Math.max(0, 100 - used);
  const leftFrac = leftSec / window;
  const pace = leftFrac <= 0.0005 ? Infinity : headroom / (leftFrac * 100);

  return {
    key,
    label: labelForBucket(key),
    used,
    headroom,
    resetsAt,
    leftSec,
    window,
    pace,
    hourly: window <= 12 * HOUR,
    mode: classify(pace, headroom)
  };
}

// rate_limits 블록 전체 → 표시/판정에 필요한 요약.
//
// 모드는 **장주기(주간) 버킷**이 정한다. 고갈이 곧 할증/차단으로 이어지는 실질
// 동인이기 때문이다. 5h 버킷은 돈이 아니라 지연(대기) 위험이라 hourlyRisk 로만
// 따로 노출한다 — 이걸 같이 min() 하면 리셋 직전 주간 여유가 5h 에 가려진다.
function summarize(rateLimits, nowSec) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const buckets = [];
  for (const key of Object.keys(rateLimits)) {
    const info = paceForBucket(key, rateLimits[key], nowSec);
    if (info) buckets.push(info);
  }
  if (!buckets.length) return null;

  const longterm = buckets.filter((b) => !b.hourly);
  const pool = longterm.length ? longterm : buckets;
  const governing = pool.reduce((lo, b) => (b.pace < lo.pace ? b : lo), pool[0]);
  const hourlyRisk = buckets.filter(
    (b) => b.hourly && (b.mode === 'tight' || b.mode === 'deficit')
  );

  buckets.sort((a, b) => a.window - b.window);
  return { mode: governing.mode, governing, buckets, hourlyRisk };
}

function formatPace(pace) {
  if (!Number.isFinite(pace)) return '∞';
  return `${pace.toFixed(1)}x`;
}

function formatLeft(seconds) {
  if (seconds >= DAY) return `${(seconds / DAY).toFixed(1)}d`;
  if (seconds >= HOUR) return `${(seconds / HOUR).toFixed(1)}h`;
  return `${Math.round(seconds / 60)}m`;
}

module.exports = {
  HOUR,
  DAY,
  PACE_SURPLUS,
  PACE_TIGHT,
  PACE_DEFICIT,
  HEADROOM_FLOOR,
  windowSeconds,
  labelForBucket,
  classify,
  modeLabel,
  paceForBucket,
  summarize,
  formatPace,
  formatLeft
};
