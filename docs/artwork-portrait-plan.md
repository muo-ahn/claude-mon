# Artwork Portrait Implementation Plan

## 목표
저해상도 도트의 nearest-neighbor 뻥튀기 문제를 공식 일러스트로 해결.

## 문제 정의
- 320 노드 중 232개(72%)가 40-63px 이하 도트를 3~6x nearest-neighbor로 확대
- 208px 초상 박스에서 픽셀 격자가 노골적으로 드러남
- 특히 성장기(아구몬 35px, 길몬 46px, 레나몬 48px, 테리어몬 49px)와 유년기 전체(32px)가 최악

## 설계 결정

### 1. 자산 슬롯
- **기존 유지**: `<id>-N.png` (메뉴바 아이콘), `portrait-<id>-N.png` (픽셀 초상)
- **신규**: `artwork-<id>-0.png` (일러스트, 단일 프레임)
- 킬 스위치: `CLAUDEMON_ARTWORK_PORTRAIT=0`으로 종전 동작 복귀

### 2. Swift 우선순위
```
artwork (매끄러운 보간) → portrait (nearest-neighbor) → 도트 업스케일 (nearest-neighbor)
```

### 3. 보간 전략
- **픽셀아트** (도트, portrait): `imageInterpolation = .none`, 정수배 스케일
- **일러스트** (artwork): 매끄러운 보간 (`.high` 또는 `.default`), 분수배 허용

### 4. 소스
Wikimon `api.php` `prop=imageinfo` `File:<제목>.jpg`:
- 제목은 `docs/graph-provenance.json`의 `title` 필드 사용
- `scripts/harvest-wikimon-canon.js`의 제목 해소 (redirects=1)
- 호스트 검증 완료: Agumon 750², Renamon 940², Slashangemon 994², Koromon/Guilmon 320², Terriermon 700²

### 5. 흰 배경 처리
**TBD - 표본 측정 후 결정:**
- 옵션 A: 알파화 (엣지 flood fill)
- 옵션 B: 흰 카드 위에 얹기 (그대로)
- 20종 표본으로 실제 다운로드 후 품질 비교

## 표본 선정 (20종)
해상도 분포를 고려한 대표 종:
- 유년기 (32px): koromon, gigimon
- 성장기 (<50px): agumon, guilmon, renamon, terriermon
- 성숙기: greymon, garurumon, angemon, birdramon
- 완전체: metalgreymon, weregarurumon, angewomon, garudamon
- 궁극체: wargreymon, metalgarurumon, holydramon
- 초궁극체: omegamon, alphamon
- 특수: slashangemon, kyukimon

## 작업 순서

### Phase 1: 표본 구현 (20종) ✅ 완료
1. ✅ 계획서 작성
2. ✅ 표본 목록 최종 확정 (20종 선정)
3. ✅ 배경 처리 방법 결정 (flood_fill tolerance=30 채택)
4. ✅ `scripts/fetch-wikimon-dots.py`에 `--artwork` 모드 추가
   - `resolve_artwork_species()` 함수
   - `normalize_artwork()` 함수 (flood_fill 배경 제거)
   - argparse `--artwork` 플래그
   - `fetch_and_write()` artwork 분기
5. ✅ 표본 13종 실제 다운로드 성공
   - 7종 파일명 불일치 (redirects 필요, Phase 2에서 해결)
6. ✅ Swift 코드 수정:
   - `artworkFrames: [String: [NSImage]]` 딕셔너리 추가
   - `portraitImage(forStage:)` 반환 타입 변경 `(NSImage?, Bool)` (artwork → portrait → dot 우선순위)
   - `drawAspectFit(_:in:pixelArt:)` 파라미터 추가 (artwork는 `.high` 보간, 픽셀아트는 `.none`)
   - `PixelArtView.isPixelArt` 프로퍼티 추가
   - `loadFrames()` artwork 로딩 추가 (`CLAUDEMON_ARTWORK_PORTRAIT` 킬 스위치)
   - evolution cut-in과 menu header 모두 `isPixelArt` 설정
7. ✅ 빌드 성공 (경고 없음)
8. ✅ 중간 판단: **표본 품질 양호, Phase 2 진행 가능**

### Phase 2: 전량 실행 (320종)
9. ⬜ 전량 다운로드
10. ⬜ 최종 검증 및 커밋

## 검증 기준
- `node --test test/` 전량 통과
- `python3 scripts/sprite_status.py --check` 깨지지 않음
- `menubar/build-app.sh` 빌드 성공
- 시각 검증: 표본 20종의 초상 품질 확인

## 제약사항
- 메뉴 구성부 (`buildMenu`, 드롭다운 항목) 수정 금지 (다른 워크스트림 충돌)
- `sprites/nodes/`에는 `artwork-*.png`만 추가
- 본체 `/Users/saladlab/Dev/claude-mon` 수정 금지
- `.omc/wikimon-cache` 재사용 (재다운로드 금지)
- Push, PR 금지

## 측정 결과

### 표본 다운로드 (20종 시도)
- 성공: 13종 (65%)
- 실패: 7종 (파일명 불일치 - redirects 또는 별칭 필요)
- 모든 성공 케이스: RGB 모드 + 흰 배경

### 해상도 분포
| 범위 | 개수 | 예시 |
|------|------|------|
| 320x320 | 5 | kyukimon, hanumon, bearmon, garudamon, apocalymon |
| 480-500 | 2 | gizamon, flaremon |
| 739-900 | 4 | betamon, angemon, airdramon, kabuterimon |
| 985-1800 | 2 | birdramon, chaosmon |

### 배경 처리 비교 (5종 표본 측정)
| 전략 | 투명도 | 파일 크기 | 품질 |
|------|--------|----------|------|
| flood_fill (tol=30) | 54-68% | 기준 | **채택**: 깔끔한 엣지, 디테일 보존 |
| white_bg | 0% | -0.5% | 거부: 흰 배경이 208px 박스에서 노출 |
| aggressive (tol=50) | 56-68% | +0.1% | 불필요: flood_fill과 거의 동일 |

**결정**: `flood_fill (tolerance=30)` 채택
- 기존 vpet 도트 처리와 동일한 edge flood fill 방식
- 흰 배경의 절반 이상 제거, 디테일 손실 없음
- 파일 크기 증가 없음

### 파일 크기 분포 (flood_fill 적용 후)
- 320px: 98-116 KB
- 480-500px: 274 KB
- 739-900px: 529-779 KB
- 전체 평균: ~360 KB per artwork

### Phase 3: 커버리지 확장 (evolution-graph 전체) ✅ 완료
14. ✅ 대상 집합 수정: graph-provenance.json → evolution-graph.json (319종)
15. ✅ 우선순위 <100px 27종 추가 다운로드
    - 유년기 9종: koromon, tokomon, tsunomon, wanyamon, gigimon, yaamon, pokomon, gummymon, chibomon
    - 성장기 주력: agumon, gabumon, guilmon, renamon, terriermon, veemon, impmon
    - 기타: kuramon, ravemon, ravemon-bm, gaomon, falcomon, vilemon, prairiemon, flamedramon, kurisarimon, garurumon, exveemon
16. ✅ 제목 매핑 자동화 (wikimon-names.yaml + enumerate_species_files)
17. ✅ 검증: 163/163 테스트 통과, 빌드 성공

## 최종 결과

### 커버리지
- **대상**: evolution-graph.json 319종 (digitama 제외)
- **성공**: 265/319종 (83.1%)
- **누락**: 54종
  - portrait ≥100px (선명, 낮은 우선순위): 50종
  - Dot 계열 2종 (의도된 예외): dotmiragegaogamon, dotshinegreymon
  - portrait 없음: 2종

### 용량 (416px 캡)
- 265종 합계: **45 MB**
- 평균: 170 KB/종, 중앙값: 157 KB
- 최대: dinohumon 470 KB
- 최소: pandamon 26 KB

### 해상도 개선 효과
| 그룹 | 기존 | artwork | 개선 |
|------|------|---------|------|
| 유년기 9종 | 32px | 320px | 10x |
| 성장기 주력 | 35-49px | 416px | 8-12x |
| portrait <100px | 35-98px | 320-416px | 3-12x |

### Dot 계열 처리
- **DotAgumon, DotFalcomon**: Wikimon 파일 없음 (graph-provenance 외부, 실패 아님)
- **DotMirageGaogamon, DotShineGreymon**: portrait 44px 보유, artwork 없음
- **의도된 예외**: "Dot" 컨셉 라인으로 픽셀 도트 유지가 정합적

### 제목 해소 (graph-provenance 외부 27종)
1. wikimon-names.yaml aliases: veemon (V-mon), vilemon (Evilmon), kurisarimon (Chrysalimon), exveemon (XV-mon)
2. 첫 글자 대문자: agumon → Agumon
3. enumerate_species_files(redirects=1, prop=images) fallback
4. 성공률: 27/27 (100%)

## Phase 4: 카드 스캔 편입 사고 및 판정기 도입 (2026-09-22)

### 사고
Phase 3 종료 시점 265종 중 76종(28.7%)이 디지몬 카드 게임 스캔(카드 틀·기술표·
`BANDAI` 각인 포함) 또는 그와 동급으로 문제적인 프로모션 씬이었다. 사용자가 슬래시엔젤몬
· 마메티라몬을 육안으로 지적하며 발각. 원인은 `resolve_artwork_species()`의 폴백 경로
(`File:<title>.jpg` 직결 실패 시 `enumerate_species_files`로 나열한 뒤
`jpg_candidates[0]` — 페이지에 걸린 **첫 번째 jpg를 이름 검증 없이** 채택)였다:
- AncientGarurumon → `AncientGarurumon Collectors Ultimate Card.jpg` (파일명에 "Card" 명시)
- Mugen Dramon → `All Digimon Are Here Art.jpg` (9종 프랜차이즈 콜라주, 대상 종 자체가 안 나옴)
- Falcomon (2006 Anime Version) → `Agumon falcomon digimonweb.jpg` (2종 개그 프로모)
- Grace Novamon → `DSTS Stats Gracenovamon.jpg` (게임 HUD 스탯 오버레이)

### 판정 기준 — 실측
`sprites/nodes/artwork-*.png` 265장 전수를 알파 채널 기준 **불투명 비율**
(alpha==255 픽셀 비율)로 측정, 오름차순 정렬:
- 정상 일러스트 184종: **15.5%–54.9%** 불투명
- 카드 스캔/스크린샷류 76종: **90.9%–100%** 불투명
- 갭(54.9% → 90.9%)이 전체 분포에서 가장 넓다. **`ARTWORK_MAX_OPAQUE_RATIO = 0.85`**
  채택 (갭 중앙).

가로세로비(카드 틀 특유의 0.68–0.75, 세로 416)는 **게이트에서 제외**했다 — 같은
비율대에 정상 일러스트 4종(tsunomon/ancienttroiamon/ancientwisemon/pandamon,
51–58% 불투명)이 섞여 있고, 반대로 76종 중 3종(darktyranomon/sunflowmon/yaamon)은
정사각/와이드 비율이면서도 배경이 없는 풀블리드 씬이라 불투명도가 높다. 육안 확인
결과 이 3종도 실제로 포트레이트로 부적절해(다중 캐릭터 씬) 게이트에 포함하는 것이
맞았다. **불투명도 단독이 아스펙트+불투명도 조합보다 더 깨끗하게 갈랐다.**

### 애매 구간(60–85%, 5종) 육안 판정
| 종 | 불투명 | 실제 내용 | 판정 |
|---|---|---|---|
| poyomon | 67.2% | 흰 유령 캐릭터, 텍스트/틀 없음 | **유지** |
| gracenovamon | 61.0% | 게임 HUD (HP/SP 수치, 캐릭터명 배너) | **제거** |
| falcomon_2006animeversion | 61.1% | 시계+올빼미 개그 씬, 대사창·저작권 각인 | **제거** |
| mugendramon | 77.4% | "All Digimon Are Here Art" 9종 콜라주, 로고 | **제거** |
| belphemon_ragemode | 78.3% | 애니 전투 씬 스크린샷 (단일 캐릭터지만 배경/움직임 흐림) | **제거** |

### 재탐색 — 전량 성공 (80/80)
제거된 76종(게이트) + 4종(육안)에 대해 같은 Wikimon 페이지의 다른 업로드 중
깨끗한 일러스트를 재탐색했다. `pick_artwork_source()`가 후보를 순위대로
다운로드→`normalize_artwork`→게이트 통과 여부를 판정하는 방식(`pick_portrait_source`와
동일 패턴)으로, **80/80 전량 대체 성공** — 예상(호스트 지시 4번, "제거 후 재탐색,
없으면 픽셀 초상으로 남김")과 달리 픽셀 초상으로 폴백한 종은 **0종**.

재탐색 중 발견한 부가 결함과 조치:
- **파일명 재구성 회피**: Mugen Dramon 재탐색이 처음엔 `Mugendramon All Digimon
  Are Here Art.jpg`(같은 콜라주의 종별 크롭 재업로드)를 다시 채택했다 — exact-filename
  denylist를 정규화 문자열 substring 매치로 바꿔 해결.
- **"model" 랭킹 가중치 도입**: 이번 재탐색 76건 중 파일명에 "model"이 들어간
  후보는 예외 없이 전부 깨끗한 3D 렌더였다. 일반 이름 후보는 알파벳 순으로
  이겨버려 콜라주가 먼저 뽑히는 사고가 있었다 — `ARTWORK_PREFERRED_NAME_TOKENS`로
  랭킹 우선순위를 줬다. **근거는 이번 76건 재탐색 표본 한정**이며, 반례가 나오면
  재검토 필요.
- **id/제목 로마자 불일치 3건**: hyogamon(위키 제목 Hyougamon), myotismon(위키
  제목 Vamdemon), flamedramon(Fladramon), yaamon(Yarmon) — `docs/graph-provenance.json`의
  `title` 필드가 위키 실제 제목과 달라 `_artwork_matches_title()`이 후보를 전부
  걸러내며 "불가"로 오판했다. `docs/wikimon-names.yaml`의 `exceptions`가 정확히
  이 문제를 위한 매핑인데 **`fetch-wikimon-dots.py`는 이 파일을 전혀 참조하지
  않는다** (JS 스크립트 3개만 참조) — 이번엔 4종을 손으로 올바른 제목을 넣어
  우회했지만, 근본 수정(YAML 파싱을 파이썬 스크립트에도 연결)은 범위 밖이라
  **잔여 리스크로 남긴다** (아래 참조).

### 영구 게이트 (scripts/fetch-wikimon-dots.py)
- `ARTWORK_MAX_OPAQUE_RATIO = 0.85` + `_looks_like_card_scan()`: 정규화된 이미지의
  불투명 비율 게이트. 근거 주석 포함.
- `ARTWORK_CARD_CODE_RE` / `ARTWORK_REJECT_NAME_TOKENS`: 파일명 사전 필터(랭킹
  힌트일 뿐 하드 컷 아님) — `Bo-136.jpg`류 카드 코드, "stats"/"card"/"collectors" 등.
- `ARTWORK_FILENAME_DENYLIST`: 게이트를 통과하지만(60–85%) 육안으로 비-포트레이트가
  확인된 4건의 원본 자산명(정규화 substring 매치).
- `ARTWORK_NON_ART_TOKENS`: vpet/dot/sprite/map/로고/국기 등 하드 제외.
- `resolve_artwork_species()`가 종당 후보 **1개가 아니라 최대 5개**를 순위 매겨
  반환하도록 재작성, `pick_artwork_source()`가 게이트 실패 시 다음 후보로 폴백.

### 최종 커버리지 (변경 없음)
- artwork 파일 수: **265장 (변동 없음)** — 80종 전량 교체 성공, 순삭제 0
- 카드 스캔: **0장** (`_looks_like_card_scan()` 265장 전수 재검사로 확인)
- 최대 불투명도: 76.1%(moonmillenniumon, 크리스탈 실루엣 아이콘) — 게이트(85%)에
  여유 있게 미달
- `<100px` 픽셀 초상 폴백 종 수: **변동 없음** (전량 대체 성공으로 신규 폴백 0건)

### 잔여 리스크
1. **id/제목 로마자 불일치가 fetch-wikimon-dots.py 전역에 남아 있다.** hyogamon 외에도
   `docs/wikimon-names.yaml`의 `exceptions`(ravemon/varodurumon 포함)가 커버하는
   불일치는 `--artwork`뿐 아니라 `--portrait`/`dot_file` 없는 기본 경로에도 같은
   방식으로 영향을 줄 수 있다. 이 스크립트는 그 YAML을 전혀 읽지 않는다(JS 3종만
   읽음) — 다음에 `--artwork --force`로 이 3종을 건드리면 다시 "불가" 오판이
   재발한다. 이번엔 재탐색 스크립트에서 수동으로 올바른 제목을 넣어 우회했을 뿐,
   `resolve_artwork_species`/`resolve_portrait_species`/`resolve_species` 공통
   진입점에 YAML 로딩을 연결하는 근본 수정은 하지 않았다.
2. **`ARTWORK_PREFERRED_NAME_TOKENS`("model") 가중치는 76건 표본 한정 근거.**
   "model"이 아닌 이름의 후보가 나쁠 수 있다는 반례가 이번엔 없었지만, 표본이
   늘면 재검증 필요.
3. **`ARTWORK_FILENAME_DENYLIST`는 자산명 기준이라 새 업로드는 못 막는다.** Wikimon에
   위 4종의 문제 자산이 다른 이름으로 재업로드되면 이 목록은 무력하다 — 최종
   방어선은 여전히 육안 검토다.
