# Route Reasons — 진화 경로 이유 기록 및 표시

## 목표
사용자가 "어떤 이유로 이 진화체가 되었는지" 알 수 있도록, 매일의 스테이지별 선택 이유를 `~/.claude/claudemon/daily.json`에 기록하고 메뉴바 드롭다운에 표시한다.

## 제약사항

### 1. Swift 타입 호환성
- `route` 필드는 Swift에서 `[String: [String: String]]`으로 캐스팅됨
- 객체·불리언·숫자를 `route` 안에 넣으면 전체 route가 `[:]`로 날아감
- **해결**: 이유는 `routeReasons`라는 최상위 형제 필드로 분리

### 2. JSON 형태 불변
- `route`의 JSON 형태는 바이트 동일 유지 (골든 스냅샷 3840 케이스 × 7칸)
- `routeReasons`는 새 필드이므로 기존 테스트와 무관

### 3. 핀 왕복 (Pin Round-trip)
- `daily.json`은 30초마다 재작성됨
- `computeDailyTokens`가 `previous.routeReasons`를 읽어 이미 핀된 스테이지의 이유는 echo
- 새로 뽑힌 스테이지만 생성
- prefix 워크(digitama/baby)도 핀 대상

### 4. A-2 Truncation
- `route`가 도달한 스테이지까지만 노출되는 스포일러 규칙
- `routeReasons`에도 동일 적용

### 5. Swift 수정 범위
- 드롭다운/메뉴 구성부만 수정
- `portraitImage(forStage:)`, `loadImageSequence`, `drawAspectFit`, `PixelArtView`는 **절대 건드리지 말 것**

## 기록할 정보

각 스테이지별로:
```typescript
{
  parentId: string,           // 부모 노드 id (forward walk) 또는 자식 노드 id (prefix walk)
  candidates: [               // 후보 목록
    {
      id: string,             // 후보 노드 id
      name: string,           // 한글명
      weight: number,         // 가중치 (8 또는 1)
      when: object | null     // 조건 (null이면 무조건 엣지)
    }
  ],
  totalWeight: number,        // 전체 가중치 합
  chosenId: string,           // 당첨 후보 id
  probability: number,        // 당첨 확률 (chosen.weight / totalWeight)
  ctx: {                      // 추첨 시점의 컨텍스트
    dailyUserTurns: number,
    outputPerTurn: number,
    sessionCount: number,
    topSharePct: number,
    failureRatioPct: number
  },
  method: "random" | "hash",  // 추첨 방식
  fallback: boolean           // 모든 조건 불충족으로 균등 weight 1 폴백 여부
}
```

## 구현 계획

### 1. lib/daily.js 수정

#### 1.1 새 함수: `recordRouteReason`
```javascript
function recordRouteReason(stage, parentId, candidates, chosenNode, ctx, useRandom) {
  // 후보 목록에서 fallback 여부 판정
  const allConditional = candidates.every(c => c.when !== null && c.when !== undefined);
  const allWeightOne = candidates.every(c => c.weight === 1);
  const fallback = allConditional && allWeightOne;
  
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  const chosenWeight = candidates.find(c => c.node.id === chosenNode.id)?.weight || 1;
  
  return {
    parentId,
    candidates: candidates.map(c => ({
      id: c.node.id,
      name: c.node.name,
      weight: c.weight,
      when: c.when
    })),
    totalWeight,
    chosenId: chosenNode.id,
    probability: chosenWeight / totalWeight,
    ctx: { ...ctx },
    method: useRandom ? "random" : "hash",
    fallback
  };
}
```

#### 1.2 `selectRoute` 수정
- `routeReasons` 객체를 함께 구성
- prefix walk와 forward walk 각각에서 `recordRouteReason` 호출
- locked 스테이지는 이유도 함께 재사용

#### 1.3 `computeDailyTokens` 수정
- `selectRoute`에 `previous.routeReasons` 전달
- 반환된 `routeReasons` 객체를 truncation 후 저장
- truncation 로직: `route`와 동일하게 `reachedIdx`까지만

### 2. menubar/claudemon-menubar.swift 수정

#### 2.1 `readDailyState` 수정
- 반환 타입에 `routeReasons: [String: [String: Any]]?` 추가
- JSON 파싱 시 `routeReasons` 읽기 (방어적 파싱, 없으면 nil)

#### 2.2 `rebuildMenu` 수정
- 헤더 메뉴 아이템 바로 아래에 route reasons 표시
- 각 스테이지별로 한 줄씩:
  ```
  완전체 · 큐키몬 ← 에이프몬 (후보 7 중 추첨, swarm ×8, 확률 38%)
  ```
- 표시 순서: digitama → baby → ... → 현재 스테이지
- 조건이 없으면 `무조건 엣지` 또는 표시 생략

#### 2.3 표시 형식
```swift
func formatRouteReason(_ stageId: String, _ reason: [String: Any], _ route: [String: [String: String]]) -> String? {
    guard let stageName = route[stageId]?["name"],
          let candidates = reason["candidates"] as? [[String: Any]],
          let totalWeight = reason["totalWeight"] as? Int,
          let chosenId = reason["chosenId"] as? String,
          let probability = reason["probability"] as? Double else { return nil }
    
    let stageLabel = stageLabels[stageId] ?? stageId
    let candidateCount = candidates.count
    
    // 조건 충족 여부 확인
    let metConditions = candidates.filter { c in
        guard let weight = c["weight"] as? Int else { return false }
        return weight == 8  // CONDITION_EDGE_WEIGHT
    }
    
    let conditionText: String
    if metConditions.isEmpty {
        conditionText = "무조건 엣지"
    } else {
        // when 조건에서 키 이름 추출 (예: {"swarm": {"min": 15}} -> "swarm")
        let conditionKeys = metConditions.compactMap { c -> String? in
            guard let when = c["when"] as? [String: Any] else { return nil }
            return when.keys.first
        }
        let uniqueConditions = Array(Set(conditionKeys))
        if uniqueConditions.count == 1 {
            conditionText = "\(uniqueConditions[0]) ×8"
        } else if uniqueConditions.count > 1 {
            conditionText = "조건 충족 ×8"
        } else {
            conditionText = ""
        }
    }
    
    let probPct = Int(probability * 100)
    
    if conditionText.isEmpty {
        return "\(stageLabel) · \(stageName) (후보 \(candidateCount) 중 추첨, 확률 \(probPct)%)"
    } else {
        return "\(stageLabel) · \(stageName) (후보 \(candidateCount) 중 추첨, \(conditionText), 확률 \(probPct)%)"
    }
}
```

### 3. 테스트

#### 3.1 기존 테스트 회귀
- `node --test test/` 전량 통과 확인
- `route` 직렬화 형태 불변 검증

#### 3.2 새 테스트 추가
1. **핀 왕복 테스트**: 이미 핀된 스테이지의 이유가 재실행에서 동일하게 echo되는지
2. **Truncation 테스트**: routeReasons에도 A-2 truncation이 적용되는지
3. **Fallback 경로 테스트**: 모든 조건 불충족 시 균등 weight 1 폴백 기록

### 4. 빌드 및 검증
- `menubar/build-app.sh` 빌드 성공
- `menubar/claudemon-menubar --dump-state`로 표시 경로 확인
- 앱 재기동/설치는 호스트가 처리

## 남은 리스크

1. **조건 키 표시**: evolution-graph.json 실측 결과, 조건 형식은 `{ type: 'sessionCount', gte: 5 }` 단일 레벨이거나 `{ all: [...] }` 배열 형태. 중첩 조건(`and`/`or`)은 그래프에 **실제로 존재**하므로 (예: veemon의 all 조건), 현재 구현(`when.keys.first`)은 `"all"`을 반환한다. 이는 사용자에게 의미 없으므로 향후 `all` 배열 내부를 순회해 실제 조건 타입들을 나열하거나 "복합 조건"으로 표시하는 개선 필요.
   - 현재 동작: `"all ×8"` 표시 (부정확하지만 fallback은 false로 정상)
2. **메뉴 높이**: 최대 7칸(digitama~superultimate)이므로 현재는 문제없음
3. **child 스테이지**: rookie는 로테이션으로 정해지는 시작점이라 이유가 없다 (draw가 없음). 드롭다운에서 빈 칸으로 표시되며, 향후 "오늘의 시작점(로테이션)" 같은 설명 추가 고려 가능. 현재는 구조적으로 정상.
4. **한글 조건명**: 영문 키 그대로 표시 (예: "sessionCount ×8"). 기술 용어 번역의 혼란 방지.
