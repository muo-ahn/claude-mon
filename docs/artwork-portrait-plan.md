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
