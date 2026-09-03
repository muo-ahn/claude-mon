# 계획: route 를 유도값에서 기록으로 (Phase A: A-2 + 마지막 순간 추첨)

> 상태: **착수 가능**. 선행조건 없음.
> `gate-weighting-plan.md`(A-5) 는 이미 머지됐다(`be79705`, #29, 2026-09-03) —
> 이 계획과 코드가 겹치지 않으므로(§ 공통 주의 참조) 순서 무관하게 병행 가능하다.
> 이 문서는 자립적이다. 다른 문서를 읽지 않아도 착수할 수 있다.
> 출처: `docs/global-graph-plan.md` §4 Phase A(A-2·A-3) 의 착수 계획.
>
> **개정 (2026-09-03)**: 이전 버전은 A-2(미도달 칸 비우기)·A-3(멱등성 포기 명문화)·
> A-4(mulberry32 시드 롤)를 한 덩어리로 묶고 시드를 필수 부품으로 다뤘다. 재검토 결과
> **A-4 의 시드 장치는 불필요하다** — §3 에서 이유와 함께 대체한다. A-3 은 "A-2 의 비용"이
> 아니라 "마지막 순간 추첨을 택할 때의 비용"으로 재정의한다(§3, §비용).
>
> **먼저 읽을 것 (§1)**: 이 계획은 진화 계보의 **다양성을 늘리지 않는다.**
> 다양성이 목적이면 `gate-weighting-plan.md`(이미 완료, 아구몬 8 → 543가지) 로 가라.

## 0. 한 줄

**진화 결과가 자정에 날짜로 확정되는 것을 없앤다.**
route 를 "매번 재계산되는 유도값"에서 "하루에 걸쳐 자라는 기록"으로 바꾼다.
스테이지에 도달하는 순간 그 칸만 1회 굴려 즉시 기록하고, 다시는 굴리지 않는다.
날짜 씨앗도, 영속화할 시드도 필요 없다.

## 1. 이 계획이 사는 것과 안 사는 것 — 먼저 읽어라

### 오늘 실제로 스포일러가 되는 예시 (2026-09-03, 실측)

`~/.claude/claudemon/daily.json` 을 그대로 옮긴다. `stageId` 는 `perfect`(도달한 최고 칸)인데
`route` 에는 7칸이 전부 채워져 있다:

```
stageId: perfect              ← 오늘 실제로 도달한 칸
  route.perfect       = 릴리몬     ← 도달. 정당한 기록
  route.ultimate      = 마린엔젤몬  ← 미도달인데 이미 파일에 있다
  route.superultimate = 마린엔젤몬  ← 궁극체와 초궁극체가 같다 = 종점까지 노출됨
```

`cat daily.json` 한 번으로 이 계보가 궁극체에서 멈춰 마린엔젤몬으로 끝난다는 것을
자정이든 정오든 알 수 있다. 문제는 화면 표시가 아니라 **파일 내용**이다.

### 핀 기계는 이미 있다

`lib/daily.js:1239-1251` (`computeDailyTokens`):

```js
// Lazy binding: a route pinned earlier today is re-walked every run
// rather than reused verbatim. selectRoute pins the stages already
// reached (through stageState.stageId) to what daily.json already
// had and only re-draws the stages still ahead against today's ctx -
// see selectRoute's `locked` param. That is what lets a signal like
// sessionCount, which can't hit its threshold in the first seconds of
// the day, still steer a branch the mon hasn't reached yet without the
// on-screen form ever flickering.
const pinned = previous && previous.dateKST === dateKST && previous.mon === mon && previous.route
  ? previous.route
  : null;
route = selectRoute(dateKST, mon, graph, ctx,
                    pinned ? { route: pinned, throughStage: stageState.stageId } : null);
```

도달한 칸(`stageId` 이하)은 이미 고정되고, 안 간 칸만 매 폴링(30초) 재계산된다. **이 계획이
새로 만들 것은 이 핀 기계가 아니라, "미도달 칸을 애초에 파일에 안 쓰는 것"뿐이다.**

### `Math.random` 금지의 사유는 원칙이 아니라 재계산이다

`lib/daily.js:201-202`와 `lib/daily.js:666-672` 두 주석이 **같은 이유**를 댄다(강조 추가):

> Deterministic string hash (no Math.random - the daily mon pick must be idempotent for
> repeated runs on the same KST date). (`:201-202`)

> Math.random would break the "same KST date always picks the same mon" invariant this
> file already relies on ... **a second run on the same day would reshuffle differently
> and the on-screen mon would flicker mid-day**. (`:666-672`, `mulberry32` 앞)

해시는 랜덤 자체를 피하려던 게 아니라 **"같은 칸을 다시 그렸을 때 값이 바뀌면 안 된다"**를
사려던 것이다. 도달한 칸은 이제 핀으로 다시 안 그려지므로(위 인용), 그 칸을 처음 그릴 때만
쓰는 진짜 난수는 이 불변식을 건드리지 않는다. → **route 추첨에 한해 `Math.random` 금지를
해제할 수 있다.** 단 `selectMon`(`lib/daily.js:736`)이 팩을 고르는 셔플 덱은 별개의
불변식("한 사이클에 각 팩 정확히 한 번")이라 `mulberry32`(`lib/daily.js:673`)를 그대로 쓴다 —
이 계획이 건드리는 건 `selectRoute`(`lib/daily.js:568`)의 타이브레이크 하나뿐이다.

### 미도달 칸은 실제로 안 움직인다 — "표시만 고치면 된다"는 반론의 기각

하루치 지표 궤적(세션 1→9, 턴 5→95)으로 `selectRoute` 를 재실행한 실측:

- `keramon`: 09:00~22:00 한 번도 안 바뀜 (조건부 엣지 0개라 ctx 자체가 무관)
- `agumon`: 세션 수가 5를 넘는 순간 딱 한 번 바뀌고 전후로 붙박이
- 225개 노드 중 190개가 조건 없음 (`docs/evolution-variety-plan.md` 실측)

즉 "미도달 칸은 실시간으로 계속 바뀌는 투영이니 표시만 고치면 된다"는 반론은 틀렸다.
대부분의 팩에서 미도달 칸은 **자정에 이미 확정된 미래**고, 하루 중 값이 갱신되는 건 소수의
조건부 갈래(조건 보유 노드 35/225, 15.6%)뿐이다. 표시를 고치는 것만으로는 파일이 스포일러인
사실이 안 바뀐다.

### 스포일러 경로는 셋이다 — A-2 단독으로는 route 필드 하나만 막는다

1. **`cat daily.json`** → route 에 미도달 칸이 있다는 사실 자체가 문제. **A-2 가 막는다.**
2. **날짜를 알고 같은 해시를 재현** → `hashString(날짜|팩|단계)` 는 결정적이므로 오프라인으로도
   계산 가능. A-2 로 파일에서 지워도 코드를 읽을 수 있으면 여전히 재현된다.
   **마지막 순간 추첨(§3)이 막는다** — 도달 전에는 어떤 값도 아직 안 뽑혔으므로 재현할 값이
   없다.
3. **`terminalFrom` 필드** → `computeDailyTokens`(`lib/daily.js:1267-1284` 부근)는 route 를
   훑어 이 계보가 어디서 끝나는지(첫 종점)를 구해 최상위 필드로 얹는다. route 를 자르지 않은
   채로 이 계산을 먼저 하면 "완전체에 있는데 `terminalFrom: ultimate`"처럼 스포일러가
   `route`에서 `terminalFrom`으로 옮겨갈 뿐이다 — 실측(daily.json, 2026-09-03)으로 확인됨.
   **A-2 의 자르기를 `terminalFrom` 계산보다 먼저 실행하면 막힌다** — 그러면 이 필드의 의미가
   "어디서 끝날 것인가"에서 **"이미 끝났는가"**로 바뀌어, 종점에 실제로 도달하기 전에는 `null`/
   부재이고 도달한 순간부터만 값이 생긴다. clamp(`lib/daily.js:1282` 부근,
   `currentIdx > terminalIdx`)는 이 전제로도 그대로 동작한다 — terminal fill(§Q-2)이 종점 이후
   칸을 같은 노드로 채워 truncate 된 route 안에 남기 때문이다.

둘 다 있어야 "날짜만 알면 미래를 예측할 수 있다"는 성질이 완전히 사라진다.

### 표: 사는 것 / 안 사는 것

```
아구몬 계보 가짓수 (게이트 가중치 A-5 머지 후 기준 — 이미 반영된 현실, be79705/#29)
  현행(날짜 해시, A-2/마지막 순간 추첨 미적용) : 543가지
  이 계획 적용 후                              : 543가지 (변화 없음, 추론 — 아래 참조)
```

**이 계획 단독으로는 다양성이 0만큼 늘어난다.** `evolution-variety-plan.md` 의 20,000시행
시뮬레이션(2026-09-02, A-5 머지 전 기준)은 날짜 해시 8가지 vs lazy-route 8가지로 **변화
없음**을 실측했다. A-5 머지 후의 543가지 기준으로 재시행하지는 않았지만, 메커니즘상 결론은
같다: **다양성의 상한은 후보 풀 크기지 추첨 소스의 엔트로피가 아니다.** 후보가 N개면 날짜
해시든 진짜 난수든 그 N개 중 하나를 같은 분포로 고르는 것은 동일하다. lazy-route 는 "언제
굴리는가"와 "무엇으로 굴리는가"만 바꾸고 "무엇 중에서 고르는가"(candidatesFor 의 후보 집합,
가중치)는 안 건드리므로, 후보 풀을 늘린 A-5 의 효과를 이 계획이 깎거나 더하지 않는다.

| 이 계획이 사는 것 | 안 사는 것 |
|---|---|
| 날짜만 알면 미래 전체를 예측할 수 있는 성질의 제거 (경로 ①②③) | 계보 다양성 (기여 0, 위 추론) |
| `route` 에 미도달 칸이 미리 채워져 "미래가 확정된 것처럼 보이는" 문제 | 초궁극체 도달률 (변화 없음, §3 예상) |
| 같은 날 같은 팩이면 항상 같은 형태가 나오는 성질의 제거 | 완전체 종점률 (변화 없음, §3 예상) |

**이 값이 필요 없다고 판단되면 이 계획은 폐기해도 된다.**
`global-graph-plan.md` §1 이 증상으로 명시하고는 있다:
*"도달하지 않은 칸이 route에 미리 채워져 밖에서 보면 미래가 확정된 것처럼 보인다."*

## 2. 현재 구조

```js
// lib/daily.js:1247-1251  computeDailyTokens()
const pinned = previous && previous.dateKST === dateKST && previous.mon === mon && previous.route
  ? previous.route
  : null;
route = selectRoute(dateKST, mon, graph, ctx,
                    pinned ? { route: pinned, throughStage: stageState.stageId } : null);
```

- 스테이지 ≤ 현재 `stageId` → `daily.json` 에서 핀 (이미 동작)
- 스테이지 > 현재 `stageId` → **매 폴링(30초)마다 재계산**, `hashString(날짜|팩|단계) % n`
  으로 재현 가능한 값을 씀 (`selectRoute` 내부 `pick()`)

즉 핀 기계는 이미 "도달한 칸을 보존"하는 일을 하고 있다. 다만 `selectRoute` 가 `route` 를
7칸 전부 채워 반환하므로(§3 forward walk), 안 간 칸도 매번 값이 생겨 파일에 그대로 실린다.

## 3. 변경

### A-2 미확정 구간을 비운다

`computeDailyTokens` 가 `selectRoute` 의 반환값 중 **도달한 칸까지만** `route` 에 쓴다.
`daily.json` 이 하루에 걸쳐 자란다. `selectRoute` 자체의 시그니처와 동작(§2 인용)은
바뀌지 않는다 — 자르는 지점은 `computeDailyTokens` 쪽이다.

### 마지막 순간 추첨 (구 A-4 를 대체)

`hashString(날짜|팩|단계)` 타이브레이크를, **도달 시점에 딱 한 번** 굴리는 실난수로 바꾼다.

- 스테이지가 올라가는 순간 그 칸의 `pick()` 만 진짜 난수로 굴리고, 결과를 즉시
  `daily.json` 에 append 한다. 그 뒤로는 핀이라 다시 안 굴려진다(§1 인용 코드가 이미 함).
- 시드를 영속화할 필요가 없다 — "재계산 시 값이 안 바뀌어야 한다"는 요구는 **핀이 이미
  충족**한다(§1). 시드는 그 요구를 우회해서 만족시키려던 장치였는데, 요구 자체가 이미
  다른 메커니즘으로 충족되고 있었다.
- **금지 해제는 route 추첨(`selectRoute` 의 `pick()`)에 한정**한다. `selectMon` 의 셔플
  덱(`mulberry32`, `lib/daily.js:673`, `:736`)은 "한 사이클에 각 팩 한 번"이라는 별개
  불변식을 지키므로 그대로 둔다. 이 구분이 §1 마지막 문단의 근거다.

### A-3 재정의 — 멱등성 포기는 A-2 가 아니라 "마지막 순간 추첨"의 비용

이전 버전은 A-3(멱등성 포기)을 A-2 의 필연적 결과처럼 서술했는데 근거가 없었다. 날짜 해시를
유지한 채 `computeDailyTokens` 쪽 기록만 잘라도(A-2 단독) 동작 변화는 0이고 멱등성도 그대로
유지된다 — 안 간 칸은 재계산 때 여전히 같은 해시값을 내므로 파일에 안 쓴다고 달라질 게 없다.
**멱등성을 포기하는 것은 A-2 가 아니라, 스포일러 경로 ②(§1)까지 막기 위해 해시를 실난수로
바꾸는 순간**이다. 그 비용은 §비용 절에서 정리한다.

## 4. 위험

| # | 위험 | 완화 |
|---|---|---|
| 1 | 30초 폴링 중 스프라이트 깜빡임 | 도달 칸은 이미 핀으로 불변(§1, §2 인용). 시드 영속화 없이도 재계산이 도달 칸을 다시 안 그리므로 안전 |
| 2 | `daily.json` 유실 시 그날 이후 계보가 다시 굴려질 수 있음 | 완화 없음 — 이것이 마지막 순간 추첨을 택한 비용이다. §비용 참조 |
| 3 | **골든 테스트** | **안 깨진다** — `test/daily.test.js:1878` 은 frozen snapshot + 명시 ctx 로 `selectRoute` 를 **직접** 호출한다. `selectRoute` 시그니처(`lib/daily.js:568`)를 지키고 `computeDailyTokens` 쪽 절단·추첨 타이밍만 고치면 통과. **A-5(게이트 가중치)는 `candidatesFor`/`pick` 계약을 바꿔 골든을 의도적으로 갱신해야 했지만, 이 계획은 그 계약을 안 건드린다 — 결정적 차이다** |
| 4 | `terminalFrom` 이 lookahead 를 요구 | **과장이었다.** `lib/daily.js:1268-1284` 의 루프는 `if (!entry) continue;` 로 없는 칸을 이미 건너뛴다(`:1271`). clamp(`:1282`)도 `currentIdx > terminalIdx` 일 때만 동작하는데 도달하지 않은 종점을 지나칠 수는 없으므로, 도달한 칸 안에서 종점을 찾는 것으로 충분 — **거의 그대로 동작한다.** 남는 것은 §열린 질문의 종점-이후 칸 처리뿐 |
| 5 | 메뉴바가 미도달 칸 스프라이트를 못 찾음 | 유효한 위험, 완화 있음. `loadFrames`(`menubar/claudemon-menubar.swift:1058`)가 `activeRouteSprites[stage] ?? stage` 로 route 없는 칸을 spine(`<stage>-*.png`)에 폴백한다. `applyRoute`(`:194`)는 route 딕셔너리를 순회만 하고, `evolvedName`(`:177`)도 없는 스테이지는 `stageNames`/`labelForMon` 으로 폴백한다. `switchMonIfNeeded(routeChanged:)`(`:1124`)가 리로드를 트리거하므로 자라는 route 를 견딘다 |

**정정**: 이전 버전의 위험 #6(맵 스크립트가 `daily.json` 을 읽어 영향받는다)은 **사실이
아니었다.** `scripts/build-evolution-map.js:18` 은 `readGraph`/`graphFilePath` 만 가져오고
`daily.json` 을 전혀 참조하지 않는다(grep 결과 0건) — 그래프만 정적으로 분석해 루트 수를
센다. 이 위험 항목은 삭제한다.

## 5. 비용

`daily.json` 이 그날의 유일한 기록이 된다. 하루 중간에 지우면 핀이 전부 사라져 **지나온
칸까지 다시 굴려지고** 화면의 마스코트가 바뀔 수 있다.

지금은(변경 전) 지워도 무해하다 — 날짜 해시라 같은 날짜면 언제 다시 계산해도 같은 값이
복원되기 때문이다. 마지막 순간 추첨을 도입하면 이 성질이 사라진다. **"미래를 미리 계산할 수
없다"(스포일러 경로 ② 차단)와 "나중에 지워도 복원할 수 있다"(멱등성)는 같은 성질의 앞뒤라
동시에 가질 수 없다** — 전자는 "그 순간이 오기 전엔 값이 존재하지 않는다"를 요구하고, 후자는
"그 순간이 지난 뒤에도 같은 입력이면 같은 값을 재현할 수 있다"를 요구하는데, 재현이 가능하다는
것 자체가 스포일러 경로 ②를 다시 열기 때문이다. 이 계획은 전자를 택하고 후자를 포기한다.

## 6. 검증

```bash
node --test        # 골든 포함. §4 #3 대로라면 갱신 불필요
```

- **폴링 안정성**: 같은 `daily.json` 으로 `computeDailyTokens` 100회 재실행 → 결과 동일
- **성장 시뮬레이션**: 토큰을 0 → 30k → 100k → 300k 로 올리며 route 가 append 만 되고
  기존 칸이 안 바뀌는지, 미도달 칸은 `route` 에 아예 없는지
- 초궁극체 도달률·완전체 종점률 기준선 유지 확인 (§1 "안 사는 것" 표)
- `daily.json` 삭제 후 재생성 시 그날 계보가 달라지는 것이 **정상 동작임을 문서화** (§비용)

## 7. 열린 질문

- **Q-1 (구 Q-3 계승).** 맵/UI 에서 미도달 칸을 무엇으로 표시할지 (빈칸 / `?` / 안 보여줌).
  `route` 에서 빠지는 것과 화면에 무엇을 그릴지는 별개 결정이다.
- **Q-2.** 종점 이후 칸을 어떻게 쓸 것인가. 계보가 완전체에서 끝나는데 토큰이 궁극체를
  가리키면, 현재 forward walk(`lib/daily.js:619-622`)는 같은 노드를 반복 기록해 채운다
  (terminal fill). A-2 에서 이걸 자를지 유지할지가 미결이다. **유지가 타당해 보인다** —
  그건 예측이 아니라 "끝났다"는 이미 확정된 사실이고, `terminalFrom`(§4 #4)의 clamp 가
  route 안에 종점 이후 칸이 채워져 있다는 전제에 의존한다. 자르면 clamp 로직을 별도로
  다시 설계해야 한다.
- 이전 버전의 Q-1(시드를 뭘로 뽑나)·Q-2(스테이지별 독립 시드)는 **삭제한다.** 시드 자체가
  없어졌으므로 무의미하다.

## 8. NOT in scope

- **A-1 로키 조건화** (`selectMon` 폐기) — 셔플 덱과 `mon-history.json` 을 버리는 큰 교환.
  `global-graph-plan.md` §4 A-1 에 원안이 있다.
- 게이트 가중치 → `gate-weighting-plan.md` (완료, `be79705`/#29)
- 완전체 종점 4건 → `terminal-gaps-plan.md`

## 9. 작업 목록

1. `computeDailyTokens` 가 `selectRoute` 반환값 중 도달한 칸까지만 `route` 에 쓰도록.
   `selectRoute` 시그니처는 유지 → **골든 테스트 무영향**(§4 #3 — A-5 와 결정적으로
   다른 지점).
2. 추첨을 도달 시점 1회로 옮긴다. 핀이 없는 칸에서만 실난수로 굴리고 즉시 기록한다.
3. `terminalFrom` — 거의 그대로 동작한다(§4 #4). 종점 이후 칸 처리(Q-2)에 따라 확인
   필요. **순서 필수**: 1번의 자르기가 이 계산보다 반드시 먼저 실행돼야 한다(§1 경로③) —
   그래야 "어디서 끝날 것인가"가 아니라 "이미 끝났는가"가 된다. 순서를 바꾸면 route 는
   막아도 이 필드로 스포일러가 새어나간다.
4. 메뉴바 — 잘린 route 를 이미 견딘다(§4 #5, `applyRoute`/`evolvedName`/`loadFrames`
   폴백 확인 완료). 회귀 테스트만 추가하면 된다.
