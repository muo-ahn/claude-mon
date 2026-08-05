# TODOS

의도적으로 미룬 작업. 각 항목은 3개월 뒤에 읽어도 동기와 시작점이 복원되도록 적는다.

---

## 1. 스테이지 스킵 검증을 팩 스키마 계약으로 승격

**What** — `evolutions[].to` 가 *바로 다음 선언 스테이지*의 노드를 가리켜야 한다는 규칙을
`docs/evolution-routes.md` 의 루트 요구사항으로 명문화한다.

**Why** — 이 제약은 지금 구현 세부에만 존재한다. `lib/daily.js` 의 `byId` 는 전 스테이지
노드를 한 맵에 담고, 후보 필터에 스테이지 검사가 없다. 그래서 성숙기 노드가 궁극체 id를
가리키면 그 노드가 **완전체 슬롯에 배정된다.** 스프라이트 이름 조회가 어긋나 메뉴바 앱이
한 단계 아래 프레임으로 폴백하고(README §스프라이트 폴백), 사용자에게는 "진화했는데
퇴화한 것처럼" 보인다 — README 가 과거 버그로 기록해둔 바로 그 증상이다.
README 는 커스텀 팩 제작을 공개 계약으로 약속하는데, 제작자가 이 제약을 알 방법이 없다.

**Pros** — 커스텀 팩 생태계에서 사일런트 실패를 예방한다.
**Cons** — 조건부 엣지 작업의 `validatePackTree` 가 실용적으로는 이미 잡는다. 남은 건
대부분 문서 작업이다.

**Depends on** — 조건부 엣지 변경의 `validatePackTree` 완료 후.

---

## 2. 퇴화(`TREE.regression`) 활성화 검토

**What** — `evolution-tree.json` 에 `regression` 키를 넣어 `applyRegression` 을 살릴지
결정한다.

**Why** — `claudemon-prd.md` §2 의 명시 요구사항이다("방치 또는 나쁜 습관에 따라 조건
저하 → 퇴화 가능"). 코드는 이미 있다 — `lib/evolve.js:66 applyRegression` 이 마지막 활동
시각으로부터 N시간 경과 시 지정 스테이지로 되돌린다. 그런데 `evolution-tree.json` 에
`regression` 키가 없어서 `if (!rule) return false` 로 즉시 반환하는 **죽은 경로**다.

**Pros** — PRD 완결. 방치에 대한 피드백 루프가 생긴다.

**Cons** — 세 가지가 걸린다.
1. `locked` lazy binding(화면 무깜빡임 보장, `lib/daily.js:211-219`)과 정면 충돌한다.
   "조건이 거짓으로 돌아가면 되돌아가나, 아니면 래치인가"를 먼저 정해야 한다.
2. `statusline.js:45` 가 이미 `applyRegression` 을 호출한다. 데이터를 넣는 순간
   statusline 동작이 바뀐다 — 조용한 활성화가 아니다.
3. 하루 KST 리셋 모델에서는 자정 리셋이 이미 사실상의 퇴화다. 중복일 수 있다.

**Context** — 일일 리셋은 의도된 동기 설계라는 결정이 이미 내려져 있다(2026-08-05,
Approach C 기각 근거). 퇴화를 켤 때 그 결정과 충돌하지 않는지 함께 봐야 한다.

**Depends on** — 없음. 단 조건부 엣지 변경 이후가 안전하다.
