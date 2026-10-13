# 노드 확장 계획 — 역방향 인덱스 방식

**2026-09-18 라운드 1 완료** — 5종 편입 (Mamemon + 4종), 도달률 47.3%→49.4% (+2.1%p)

## 실행 요약

역방향 인덱스 방식으로 293종 후보 발굴 → 도트·한글명 있고 고아 안 되는 4종 편입.

| 지표 | main | 편입 후 | 변화 |
|---|---|---|
| 노드 | 320 | 325 | +5 (mamemon 1 + 4종) |
| 엣지 | 1,127 | 1,195 | +68 |
| 루트 | 1 | 1 | 고아 0 ✓ |
| 도달률 | 47.3% | 49.4% | +2.1%p |
| 종점 | {ultimate 42, superultimate 30} | 동일 | ±0 |

## 편입 종 (5종)

| 종 | 스테이지 | 한글명 | 자식 수 | 부모 |
|---|---|---|---|---|
| Mamemon | perfect | (기존) | 15 | 기존 편입 유지 |
| Tanemon | baby | 시드몬 | 7 | digitama |
| Caprimon | baby | 카프리몬 | 5 | digitama |
| Floramon | child | 플로라몬 | 12 | tanemon |
| Palmon | child | 팔몬 | 24 | tanemon |

**제외 12종**:
- tunomon (tsunomon 중복, 편집거리 1)
- wormmon, strikedramon, lopmon, kotemon (한글명 없음)
- pagumon (agumon 유사, 편집거리 1)
- penmon, dracumon, hyokomon, otamamon, buraimon, butenmon, ancientbeatmon (부모 부재, 고아 회피)

## 규칙 적용

| 규칙 | 내용 | 근거 |
|---|---|---|
| R9 | 스테이지 스킵 금지 | 기존 |
| R10 | 종점은 ultimate/superultimate | 기존 |
| R11 | 궁극체 종점은 초궁극체 후계 필요 | 2026-09-18 사용자 결정 |
| **R12** | **편입 후 digitama 미도달 노드 0개** | 2026-09-18, 고아 17개 회귀 실측 |
| **R13** | **조건 상속 (신규 엣지만): 대상 노드의 모든 기존 엣지가 동일한 when을 가질 때, 신규 엣지(main에 없던 (from,to) 쌍)도 상속** | 2026-09-18, Floramon→Raremon 케어미스 leak 실측. 기존 엣지는 변경 안 함 |

### R13 상세 (조건 상속 — 신규 엣지만)

**적용 대상**: 편입 시 대상 노드(예: numemon)의 모든 **기존 엣지**(main에 있던 엣지)가 동일한 `when` 조건을 가질 때, **신규 엣지**(main에 없던 (from,to) 쌍)도 같은 조건 상속.

**신규 엣지 판정**: main 브랜치에 없던 `(from, to)` 쌍만. 기존 엣지의 `when`은 이 규칙으로 바꾸지 않는다.

**실측 근거** (2026-09-18):
- numemon: 기존 17개 엣지 모두 `{"type":"outputPerTurn","gte":15000}`
- raremon: 기존 8개 엣지 모두 동일
- scumon: 기존 6개 엣지 모두 동일
- → Floramon/Palmon 신규 엣지 4개를 `when: null`로 추가 시 케어미스 leak (테스트 실패)

**기존 엣지 6건 사고** (2026-09-18): 초기 스크립트가 기존 엣지까지 조건부로 바꿔버림 (knightchessmon_white→rizegreymon 등 6건). 이것은 요청하지 않은 동작 변경이므로 되돌림. 스크립트를 신규 엣지만 처리하도록 수정.

**예외: Gerbemon** — 케어미스 부모(numemon/raremon/scumon) 3개만 조건부, 정규 부모는 무조건.  
→ 신규 엣지가 케어미스 노드로 가는 경우에만 조건 상속, 정규 대상은 `when: null` 유지.

**적용 결과**: 13개 신규 엣지 조건 상속 (케어미스 4 + Gerbemon 9), 기존 엣지 변경 0

## 검증 결과

✓ `build-evolution-map.js`: Roots=1 (고아 0), 도달률 49.4% (8,455/17,114) ≥ main 47.3%  
✓ `audit-canon-edges.js --terminals --check`: R10 위반 0건  
✓ `node --test`: 163개 **전량 통과** (케어미스 조건 상속 후)

## 다음 라운드 시작점

### 미편입 후보 현황

| 범주 | 종 수 | 사유 | 해소 방법 |
|---|---|---|---|
| 부모 부재 (고아 회피) | 7 | Penmon, Dracumon, Hyokomon, Otamamon, Buraimon, Butenmon, Ancient Beatmon | vpet 풀(848종)에서 부모 조달 |
| 한글명 없음 | 4 | Wormmon, Strikedramon, Lopmon, Kotemon | Wikimon 인포박스 재조회 또는 음역 금지 원칙 유지 |
| 중복 (편집거리 1) | 2 | Pagumon(agumon 유사), Tunomon(tsunomon 중복) | 제외 유지 |
| 도트 없음 | 276 | 역방향 인덱스 후보 중 도트 미보유 | vpet 소스 지정 후 `fetch-wikimon-dots.py` 조달 |

### 작업 경로

1. **부모 조달 (vpet 풀)**: 7종의 부모를 특정 → vpet 도트 조달 → 다단계 편입
2. **한글명 보완**: harvest 재실행 또는 수동 확인 (음역 추측 금지)
3. **도트 조달**: 276종에 대해 `fetch-wikimon-dots.py --species` + `source: "vpet_*"` 실행
4. **재검증**: R9~R13 전체 + 고아 0 + 도달률 ≥ 49.4% 확인

### 제약 조건

- baby는 digitama 부모 (보편 관례)
- 편집거리 1 · 길이차 ≤1 중복 가드 유지
- 조건 상속 (R13) — 케어미스/조건부 대상 엣지에만 적용

## 방법론 기록

### 역방향 인덱스 발굴

**핵심**: 기존 노드의 캐시된 wikitext `Evolves From` 섹션에서 미편입 부모 발견.

**장점**:
1. 자식이 이미 그래프에 있어 R10·R11 자동 만족
2. 네트워크 비용 0 (캐시만 사용)
3. 실제 인게임 진화 관계 반영

**단점**:
1. 부모가 없으면 고아 노드 발생 → vpet 풀로 연결 필요
2. 스테이지 분포 불균형 (child 64 / perfect 113 / ultimate 8)

**스크립트**: `scripts/reverse-index-candidates.js`  
**입력**: `/Users/saladlab/Dev/claude-mon/.omc/wikimon-cache/*.wikitext`  
**출력**: `docs/reverse-index-candidates.json`

### 중복 가드 (편집거리 기반)

```javascript
function isDuplicateEnhanced(title, spriteId) {
  if (graphIds.has(spriteId)) return true;
  
  for (const existingId of graphIds) {
    const dist = editDistance(spriteId, existingId);
    const lengthDiff = Math.abs(spriteId.length - existingId.length);
    
    // 편집거리 1 & 길이차 ≤1 & 길이 ≥5
    if (dist === 1 && lengthDiff <= 1 && spriteId.length >= 5) {
      return true; // tunomon/tsunomon, pagumon/agumon 검출
    }
  }
  return false;
}
```

**검출 사례**: tunomon/tsunomon (거리 1, 길이차 1), pagumon/agumon (거리 1, 길이차 1), kotemon/koemon (거리 1, 길이차 1)

### 조건 상속 알고리즘

1. 대상 노드의 evolvesFrom 조건별 그룹화
2. 조건이 2종류 이상이고 `null` 포함 시:
   - 다른 조건이 모두 동일하면 → null 엣지에 조건 상속
   - 예외: Gerbemon은 케어미스 부모만 조건부
3. 적용 결과: 19개 엣지 조건 상속

**스크립트**: `scripts/fix-caremiss-conditions.js`

## 참고 파일

- 역방향 후보: `docs/reverse-index-candidates.json`
- 정본 데이터: `docs/dot-candidates-canon.json` (harvest --roster-mode relaxed)
- 편입 스크립트: `scripts/fix-and-reingest.js`
- 조건 상속 스크립트: `scripts/fix-caremiss-conditions.js`
