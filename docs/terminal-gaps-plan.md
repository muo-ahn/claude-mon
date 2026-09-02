# 계획: 완전체 종점 해소 — 정본 계열 후계 편입

> 상태: **T-1 · T-2 · T-3 완료 (2026-09-02).** 완전체 종점 11.0% → **0.0%**,
> 초궁극체 도달률 33.3% → **40.5%**. 남은 것은 T-4(감사 확장)뿐이다.
> **다른 두 계획(`gate-weighting-plan.md`, `lazy-route-plan.md`)과 선후 관계 없이 병행 가능** —
> 독립성은 §6 에서 실측으로 확인했다.
> 이 문서는 자립적이다. 다른 문서를 읽지 않아도 착수할 수 있다.

## 0. 한 줄

완전체에서 진화가 끊기는 노드 4개에 **정본 계열 후계**를 이어붙인다.
파생 진화(게임별 교차 진화)를 무더기로 넣는 것이 아니다 — 실측상 **정본 2개가 파생 36개보다 낫다**(§4).

## 1. 증상

`evolution-graph.json`(314노드) 에서 out-degree 0 인 `perfect` 노드:

| id | 이름 | fan-in | 현재 자식 |
|---|---|---|---|
| `vamdemon` | 묘티스몬 | 11 | 0 |
| `aerovdramon` | 에어로브이드라몬 | 5 | 0 |
| `karatenmon` | 크로우몬 | 4 | 0 |
| `lucemon_falldownmode` | 루체몬 폴다운 모드 | 4 | 0 |

도달하면 궁극체·초궁극체 칸이 같은 이름으로 채워지고, D7 클램프가 `stageId` 를
`perfect` 로 눌러버린다. **발생률 11.0%** (같은 ctx 20,000 표본). 9일에 하루꼴.

## 2. 정본 판정 기준 — Wikimon 볼드 + `refd`

`.omc/wikimon-cache/` 의 `==Evolves To==` 절에서 **볼드 처리 + `{{refd|...}}` 템플릿**이
붙은 항목이 그 디지몬의 **계열 후계(정본)** 다. 나머지는 게임별 파생 교차 진화다.

```wikitext
* '''[[Venom Vamdemon]]'''{{refd|Venom Vamdemon|venomvamdemon}}   ← 정본
* [[War Greymon]]<ref name=DSSM/>                                  ← 파생 (특정 게임)
```

실제 비율 — 파생이 압도적이다:

| 종점 노드 | Evolves To 총건 | **정본(볼드)** | 파생 |
|---|---|---|---|
| `aerovdramon` | 27 | **알포스브이드라몬**, 알포스브이드라몬 FM | 25 |
| `vamdemon` | 31 | **베놈묘티스몬**, 베리얼묘티스몬, 네오묘티스몬, 묘티스몬(X), 볼토바우타몬 | 26 |
| `lucemon_falldownmode` | 15 | **루체몬 사탄모드**, 루체몬 라바, 오그도몬, 루체몬(X) | 11 |
| `karatenmon` | 11 | **텐구몬** | 10 |

> **이전 초안의 오류**: 파생·정본을 구분하지 않고 36개를 평평하게 긁었다.
> 그 결과 `aerovdramon → wargreymon`(파생 25개 중 하나) 같은 엣지가 들어가고,
> 정작 정본인 `루체몬 사탄모드`·`텐구몬`은 노드가 없다는 이유로 빠졌다.

## 3. 작업

### T-1 정본 엣지 2개 — ✅ 완료

엣지는 **자식이 소유한다**(§B-1). 대상 노드의 `evolvesFrom` 에 추가:

| 추가 위치 | 엣지 | 검증 |
|---|---|---|
| `ulforcevdramon`(알포스브이드라몬) | `{ "from": "aerovdramon", "when": null }` | Ultimate ✓ 인접, 도트 O |
| `venomvamdemon`(베놈묘티스몬) | `{ "from": "vamdemon", "when": null }` | Ultimate ✓ 인접, 도트 O |

**이 2줄만으로 완전체 종점 11.0% → 2.4%** (§4).

양방향 확인됨 — 부모 쪽 `Evolves To` 볼드 + 자식 쪽 `Evolves From` 볼드:
`Ulforce V-dramon ← '''Aero V-dramon'''`, `Venom Vamdemon ← '''Vamdemon'''`.

### T-2 정본 노드 편입 2건 — ✅ 완료

| 편입 노드 | 스테이지 | 부모 | 도트 출처 | 내용 크기 |
|---|---|---|---|---|
| `lucemon_satanmode` (루체몬 사탄모드) | `ultimate` ✓ | `lucemon_falldownmode` ✓볼드 | `Lucemon_Satan_vpet_xloader.png` (96×96) | 29×30 |
| `tengumon` (텐구몬) | `ultimate` ✓ | `karatenmon` ✓볼드 | `Tengumon_vpet_dpc.gif` (48×48) **+2x 업스케일** | 28×28 |

**이 저장소 최초의 vpet 도트 사용이다** (`TODOS.md` 가 "구현은 끝났지만 아직 쓰지
않았다"고 한 풀). 쓰지 않았던 이유가 실측으로 드러났다 — vpet 도트는 네이티브가
**16×16 수준**이라 DS 오버월드 도트(~32×32)와 해상도가 다르다. 정규화만 하면
내용이 14×14 로 나와 이웃 노드(22~32px) 절반 크기가 된다.

대응:
- `lucemon_satanmode` — 후보 중 네이티브가 큰 `vpet_xloader` 96×96 판을 골라 해결.
  192×192 판도 있으나 네이티브 62×62 를 32 로 줄이면 노이즈가 심해 96×96 을 채택
- `tengumon` — 링크된 파일이 `vpet_dpc.gif`(48×48)와 그 cutin(96×48, 2프레임)뿐이고
  둘 다 네이티브 16×16. **2x NEAREST 업스케일**로 28×28 을 만들었다.
  크기는 맞지만 픽셀이 2×2 블록이라 이웃과 화풍이 다르다 — §7 Q-5

초상: `lucemon_satanmode` 는 62×62 확보. `tengumon` 은 후보가 cutin(워크사이클
스트립, 초상 부적격)뿐이라 없다 — 메뉴바가 32px 도트의 4x 업스케일로 폴백한다.

편입 후 완전체 종점 2.4% → **0%**.

`node scripts/materialize-sprites.js --write` 로 팩 디렉터리 구체화까지 완료(34장 복사).
이 단계를 빼면 `sprite_status.py --check` 가 20건 경고한다 — 새 노드가 여러 팩의
계보에서 도달 가능해지기 때문이다.

**대안(정본 계열 내 다른 후보)** — 도트가 안 나올 때
- `lucemon_falldownmode`: `ogudomon`(오그도몬, l1=Ultimate, 캐시 있음, 노드 X) 도 볼드다
- `vamdemon` 계열: `neovamdemon`·`voltobautamon` 도 볼드지만 노드·캐시 모두 없다

### T-3 파생 엣지 — 보류 (§7 Q-1). provenance 기록은 ✅ 완료

정본만으로 종점이 해소되므로 **이 계획에서는 넣지 않는다.**
파생 엣지는 계보 다양성에는 기여하지만, 그것은 `gate-weighting-plan.md` 의 소관이고
판단 기준도 다르다(정본성 vs 다양성). 함께 결정하는 편이 낫다.

참고로 정본 2개(2.4%) 대비 파생 36개(0.0%)는 종점만 더 낮출 뿐,
초궁극체 도달률은 **오히려 정본 쪽이 높다**(40.4% vs 39.3%) — §4.

`docs/graph-provenance.json` 에 엣지 4건의 출처 게임을 기록했다.
하베스트 로스터 게이트를 거치지 않은 수기 정본 엣지이므로 `passesStrictGate` 대신
`"via": "evolves-from-bold"` 로 표기한다.

### T-4 재발 방지 — `audit-canon-edges.js` 확장 — ⬜ 미착수

현재 감사는 **incoming 엣지만** 대조해서 이 부류(나가는 엣지 누락)를 구조적으로 못 잡는다.
추가할 것:
- 스테이지별 out-degree 0 노드 집계
- 최상위(`superultimate`)가 아닌 종점에 대해 **정본(볼드+`refd`) 후계가 그래프에 있는지** 대조
- 스테이지 인접 필터 내장 (`parent-stage-mismatch` 사전 차단)
- 하베스트 시 `wikimon-names.yaml` 별칭 역방향 충돌 검사 (§5 재발 방지)

## 4. 검증

```bash
node --test                                    # 골든 포함 전수
node scripts/audit-canon-edges.js --offline    # 회귀 없음 확인
```

**실측 결과 (2026-09-02 / 20,000 표본)**

| | 완전체 종점 | 궁극체 | 초궁극체 |
|---|---|---|---|
| 적용 전 | **11.0%** | 53.4% | 33.3% |
| T-1 정본 엣지 2개만 | 2.4% | 55.0% | 40.4% |
| **T-1 + T-2 (최종)** | **0.0%** | 57.1% | **40.5%** |
| (참고) 기각한 파생 36개 안 | 0.0% | 58.4% | 39.3% |

검증 통과:
- `node --test` **141/141**
- `validateGraph` 위반 **0**
- `sprite_status.py --check` **경고 없음** (materialize 후)
- `evolution-graph.json` diff 32줄 추가만, 재포맷 없음

- 엣지 **2줄로 종점의 78% 소멸**
- 초궁극체 도달률 33.2% → 40.4%.
  `global-graph-plan.md` §7 기준선 41.4%(최대 사용량 구간)에 사실상 도달
- 정본이 파생보다 초궁극체 도달률이 높은 이유: 정본 라인은 상위 계보가 이어지는데
  파생 엣지는 **자기도 종점인 궁극체**로 흩어진다
- T-1 후 잔존 종점: `karatenmon`, `lucemon_falldownmode` (T-2 대상)
- `validateGraph` 위반 0
- 골든 테스트는 **frozen snapshot** 을 읽으므로 데이터 변경에 영향받지 않는다
  (`test/daily.test.js:1871`: *"Future data changes are NOT reflected here — by design"*)

## 5. 후속 (범위 밖) — `vamdemon` / `myotismon` 노드 중복

```
myotismon  (뱀파이몬)  ← 부모 1 (devimon)   → 자식 9
vamdemon   (묘티스몬)  ← 부모 11            → 자식 0 (T-1 후 1)
```

도트를 확대 대조했다 — 둘 다 파란/금색 갑주 + 빨간 망토 + 뿔 가면, 동일 개체다.
역스캔에서 **양쪽이 같은 대상 목록을 돌려준 것**이 독립 증거다.

**근본 원인**: `vamdemon` 은 #24 의 235종 하베스트가 만든 중복이다.
`docs/graph-provenance.json` 에 `{"id":"vamdemon","title":"Vamdemon","koSource":"translit"}`.
하베스트가 `docs/wikimon-names.yaml:11` 의 `"Vamdemon": "myotismon"` 매핑을 확인하지 않았다.

**병합한다면 생존 id 는 `myotismon`** — 근거 셋:
1. `wikimon-names.yaml:11` 이 `"Vamdemon" → "myotismon"` 을 정본으로 선언
2. 도트 2프레임 + 초상 110×132 (vs `vamdemon` 은 1프레임 + 54×54)
3. 자식 9개를 이미 보유 — 이설할 엣지가 부모 11개로 더 적다

**다른 중복은 없다** — 별칭 테이블 전수 + 한글명 중복 + `dotSource` 중복 3중 스캔 결과
이 한 건뿐. 한글명이 서로 달라(묘티스몬 vs 뱀파이몬) 이름 대조로는 안 잡히는 케이스였다.

**데이터 위생 문제이지 종점 해소의 전제가 아니다.** 별도로 다룬다.

## 6. 독립성 실측 (2026-09-02)

같은 ctx, 20,000 표본에서 완전체 종점률:

| | 종점률 |
|---|---|
| 현행 | 11.0% |
| `lazy-route-plan` 적용 시 | 11.2% |
| `gate-weighting-plan` 적용 시(W=8) | 9.6% |

계획 적용 여부와 무관하다. 코드도 안 겹친다 — 종점 판정은
`childrenOf.get(id).length === 0` 이고 가중치·시드와 접점이 없다. **병행 가능.**

## 7. 열린 질문

- **Q-1. 파생 엣지를 넣을지 (T-3).** 정본만으로 종점은 해소된다. 파생은 다양성 목적이고
  판단 기준이 다르므로 `gate-weighting-plan.md` 와 함께 결정하는 편이 낫다
- ~~**Q-2. `Tengumon` 레벨.**~~ **해소** — `|l1=Ultimate`, Evolves From 에
  `'''[[Karatenmon]]'''` 볼드. 양방향 정본 확인
- ~~**Q-3. 도트 확보 실패 시.**~~ **해소** — 둘 다 vpet 풀에서 확보
- **Q-5 (신규). `tengumon` 도트의 픽셀 밀도.** 2x 업스케일이라 픽셀이 2×2 블록이다.
  크기는 이웃과 맞지만 화풍이 다르다. 선택지: (a) 현행 유지 (b) 14×14 원본으로
  되돌리고 작게 표시 (c) 더 나은 소스가 나올 때까지 노드 보류.
  **사람이 실제 메뉴바에서 보고 판단할 사안이다**
- **Q-4. `when` 조건.** T-1 은 `when: null` 로 넣는다. 조건을 걸 자리인지는
  `gate-weighting-plan.md` 가 끝난 뒤 판단하는 편이 낫다

## 8. NOT in scope

- **노드 중복 병합** → §5
- **파생 엣지 일괄 추가** → §3 T-3, 보류
- 성장기 종점 7건 / 성숙기 종점 7건 — 실제 게임상 종점일 수 있어 별도 검증 필요.
  단 `keramon → platinumscumon`(성숙기 종점)은 실측에 잡히므로 후속 1순위
- 궁극체 종점 46건 — 정상이다(D7 로 인정된 설계)
- 런타임 변경 일체 → `gate-weighting-plan.md` / `lazy-route-plan.md`
