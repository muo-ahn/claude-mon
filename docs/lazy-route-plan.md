# 계획: route 를 유도값에서 기록으로 (Phase A: A-2 · A-3 + A-4)

> 상태: **착수 가능**. 선행조건 없음. 다른 두 계획과 병행 가능.
> 이 문서는 자립적이다. 다른 문서를 읽지 않아도 착수할 수 있다.
> 출처: `docs/global-graph-plan.md` §4 Phase A (A-2·A-3) 의 착수 계획 + 신규 A-4.
>
> **먼저 읽을 것 (§1)**: 이 계획은 진화 계보의 **다양성을 늘리지 않는다.**
> 다양성이 목적이면 `gate-weighting-plan.md` 로 가라.

## 0. 한 줄

**진화 결과가 자정에 날짜로 확정되는 것을 없앤다.**
route 를 "매번 재계산되는 유도값"에서 "하루에 걸쳐 자라는 기록"으로 바꾼다.

## 1. 이 계획이 사는 것과 안 사는 것 — 먼저 읽어라

실측(20,000 시행)으로 확인된 것:

```
아구몬 계보 가짓수
  현행 날짜해시 365일 노출 :   8가지
  A-4 시드 롤 적용        :   8가지   ← 변화 없음
  게이트 가중치(별도 계획) : 543가지
```

**A-4 단독으로는 다양성이 0만큼 늘어난다.** 아구몬은 조건 게이트가 앞 3칸을 잠그므로
랜덤이 굴릴 자리가 궁극체 칸 하나뿐이고, 날짜 해시는 이미 그 8개를 충실히 샘플링하고 있다.
큰 표본에서 해시는 균등난수와 통계적으로 구분되지 않는다 — 당연하다, 해시가 하는 일이다.

| 이 계획이 사는 것 | 안 사는 것 |
|---|---|
| 날짜만 알면 미래 전체를 예측할 수 있는 성질의 제거 | 계보 다양성 (기여 0) |
| `route` 에 미도달 칸이 미리 채워져 "미래가 확정된 것처럼 보이는" 문제 | 초궁극체 도달률 (33.3% → 33.6%, 변화 없음) |
| 같은 날 같은 팩이면 항상 같은 형태가 나오는 성질의 제거 | 완전체 종점률 (11.0% → 11.2%, 변화 없음) |

**이 값이 필요 없다고 판단되면 이 계획은 폐기해도 된다.**
`global-graph-plan.md` §1 이 증상으로 명시하고는 있다:
*"도달하지 않은 칸이 route에 미리 채워져 밖에서 보면 미래가 확정된 것처럼 보인다."*

## 2. 현재 구조

```js
// lib/daily.js  computeDailyTokens()
const pinned = previous.dateKST===dateKST && previous.mon===mon && previous.route
             ? previous.route : null;
route = selectRoute(dateKST, mon, graph, ctx,
                    pinned ? { route: pinned, throughStage: stageState.stageId } : null);
```

- 스테이지 ≤ 현재 `stageId` → `daily.json` 에서 핀
- 스테이지 > 현재 `stageId` → **매 폴링(30초)마다 재계산**, `hashString(날짜|팩|단계) % n`

즉 7칸 전부가 항상 채워져 있고, 위쪽 칸은 날짜만 알면 예측 가능하다.

## 3. 변경

### A-2 미확정 구간을 비운다

`route` 에 **도달한 칸까지만** 기록한다. `daily.json` 이 하루에 걸쳐 자란다.
스테이지가 올라가는 순간 그 칸을 굴려 append 하고, 이미 쓴 칸은 절대 재굴림하지 않는다.

### A-3 멱등성 포기를 명문화한다

지금은 날짜+지표로 언제든 재계산 가능하다. 지연 평가는 "그 순간의 값"에 의존하므로
`daily.json` 을 지우면 복원할 수 없다.

> **`Math.random` 금지는 유지한다** — `global-graph-plan.md` A-3 원문 계약.
> 같은 `daily.json` + 같은 지표면 같은 결과여야 한다. A-4 의 시드 영속화가 이를 충족한다.

### A-4 타이브레이크를 날짜 해시에서 시드 롤로

`hashString(날짜|팩|단계)` → `mulberry32(rollSeed)`.

- 하루 시작 시 `rollSeed` 1개를 뽑아 `daily.json` 에 저장
- **날짜와 무관** → 미리 안 정해짐 ✓
- **같은 daily.json → 같은 결과** → A-3 계약 충족, 30초 폴링에 안 깜빡임 ✓
- **daily.json 만 있으면 복원 가능** → 멱등성 일부 회수 ✓

`mulberry32` 는 `selectMon`(`lib/daily.js:590`) 이 이미 쓰고 있다. 신규 의존 없음.

## 4. 결정적 제약 — 왜 `Math.random()` 을 못 쓰나

`computeDailyTokens` 는 **메뉴바가 30초마다 호출**하고 매번 전체를 처음부터 재계산한다.
`pick()` 안에 `Math.random()` 을 넣으면 30초마다 스프라이트가 바뀐다.
`mulberry32` 주석이 이미 경고하고 있다:

> Math.random would break the "same KST date always picks the same mon" invariant.

해시는 랜덤을 피하려던 게 아니라 **재계산 안정성**을 사려던 것이다.
A-4 는 그 안정성을 시드 영속화로 다시 사면서 날짜 의존만 떼어낸다.

## 5. 위험

| # | 위험 | 완화 |
|---|---|---|
| 1 | 30초 폴링 중 스프라이트 깜빡임 | 시드 영속화 + 도달 칸 불변. §4 가 이 방어의 근거 |
| 2 | `daily.json` 유실 시 그날 계보 소실 | 시드만 있으면 복원. 시드는 파일 첫 write 때 고정 |
| 3 | **골든 테스트** | **안 깨진다** — `test/daily.test.js:1878` 은 frozen snapshot + 명시 ctx 로 `selectRoute` 를 **직접** 호출한다. `selectRoute` 시그니처를 지키고 `computeDailyTokens` 쪽 pinning 만 고치면 통과. **롤을 `selectRoute` 안에 박으면 깨진다 — 설계 갈림길이다** |
| 4 | `terminalFrom` 이 lookahead 를 요구 | 현재 구현은 route 전체를 훑어 종점을 찾는다. 지연 기록이면 도달해야 알 수 있다. 배지 판정은 **이미 현재 칸만 본다**(`menubar/claudemon-menubar.swift:1691` 주석) → 현재 노드 종점 여부로 대체 가능 |
| 5 | 메뉴바가 미도달 칸 스프라이트를 못 찾음 | `loadFrames` 가 route 없는 칸을 spine(`<stage>-*.png`)으로 폴백한다(`menubar:1055`). `switchMonIfNeeded(routeChanged:)` 가 리로드를 트리거하므로 자라는 route 를 견딘다 |
| 6 | 맵 스크립트 | `build-evolution-map.js` 의 "오늘의 루트"가 **걸어온 경로 + 가능한 미래**로 성격이 바뀐다 |

## 6. 검증

```bash
node --test        # 골든 포함. 위험 #3 대로라면 갱신 불필요
```

- **폴링 안정성**: 같은 `daily.json` 으로 `computeDailyTokens` 100회 재실행 → 결과 동일
- **성장 시뮬레이션**: 토큰을 0 → 30k → 100k → 300k 로 올리며 route 가 append 만 되고
  기존 칸이 안 바뀌는지
- 초궁극체 도달률 33.3% 기준선 유지 확인
- `daily.json` 삭제 후 재생성 시 그날 계보가 달라지는 것이 **정상 동작임을 문서화**

## 7. 열린 질문

- **Q-1.** `rollSeed` 를 무엇으로 뽑나. `crypto.randomBytes` 인가, 날짜와 무관한 다른 것인가
- **Q-2.** 시드 스트림 소비 순서가 스테이지 순서에 묶이면, 하위 칸이 늦게 굴려질 때
  스트림 위치가 어긋난다. **스테이지별 독립 시드(`mulberry32(seed ^ stageIdx)`)가 안전해 보인다**
- **Q-3.** 맵의 "가능한 미래"를 어디까지 보여줄지 (전체 부분그래프 / 다음 칸만 / 안 보여줌)
- **Q-4.** `terminalFrom` 을 계약에서 제거할지, 현재 칸 기준으로 의미를 바꿀지

## 8. NOT in scope

- **A-1 로키 조건화** (`selectMon` 폐기) — 셔플 덱과 `mon-history.json` 을 버리는 큰 교환.
  `global-graph-plan.md` §4 A-1 에 원안이 있다. A-4 가 들어가면 압력이 줄어든다
- 게이트 가중치 → `gate-weighting-plan.md`
- 완전체 종점 4건 → `terminal-gaps-plan.md`
