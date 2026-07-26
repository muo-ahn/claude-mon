# ClaudeMon (프로토타입)

> **도트 이미지는 이 레포에 포함되지 않는다.** 스프라이트는 각자 준비해서 `sprites/packs/`에 넣는다 — 아래 [스프라이트 팩](#스프라이트-팩-spritespacks) 참고.

그날 사용한 토큰량에 따라 성장·진화하는 Claude Code 마스코트. statusline과 macOS 메뉴바 앱 두 곳에서 렌더링된다. 스프라이트는 팩(pack) 단위로 교체·확장할 수 있다.

## 설치

`~/.claude/settings.json`에 추가:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /절대/경로/claudemon/statusline.js",
    "padding": 0
  },
  "hooks": {
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claudemon/hook.js tool-success" }] }
    ]
  }
}
```

에러 발생 시 hook 이벤트를 `tool-failure`로 바꿔 별도 등록.

`notification`/`session-end` 이벤트도 같은 방식으로 등록한다:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claudemon/hook.js notification" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claudemon/hook.js session-end" }] }
    ]
  }
}
```

등록하면 `Notification`(권한 대기/입력 유휴 시 발화)은 `state.awaitingUserSince`를, `SessionEnd`는 `state.endedAt`을 기록한다 — 자세한 동작은 [대기/종료 기록](#대기종료-기록-awaitingusersinceendedat) 참고.

## 구조

- `evolution-tree.json` — 진화 단계/조건/스프라이트 정의 (수정해서 커스텀 팩 제작 가능)
- `lib/state.js` — 상태 persist. 전역용 `load()`/`save()`는 `~/.claude/claudemon/state.json`, 세션별용 `loadSession(sessionId)`/`saveSession(state)`는 `~/.claude/claudemon/sessions/<session_id>.json`, 전 세션 누적용 `loadGlobal()`/`saveGlobal(global)`는 `~/.claude/claudemon/global.json`
- `lib/evolve.js` — 조건 평가, 진화/퇴화 로직
- `lib/daily.js` — 일일(KST) output 토큰 집계 로직 + 증분 스캔 캐시
- `hook.js` — Claude Code hook에서 호출, 카운터 갱신 (working 플래그 등 행동용 상태에 계속 사용됨)
- `daily-tokens.js` — 일일 토큰 집계 CLI. 메뉴바 앱이 주기적으로(30초 간격) 호출해 `daily.json`을 갱신한다
- `statusline.js` — 실제 statusline에 렌더링되는 스크립트

## 진화 단계 (일일 KST 토큰 소모량 기준)

진화 단계는 **그날(KST, 자정 리셋) 소모한 output 토큰 총량**으로만 결정된다. 세션/전역 tool-success 카운터(`hook.js`, `lib/state.js`)는 여전히 `working` 플래그 등 행동 상태 용도로 유지되지만 더 이상 진화 단계에 영향을 주지 않는다.

단계는 6개(`digitama` → `baby` → `child` → `adult` → `perfect` → `ultimate`)이며, 스프라이트 파일명도 이 stage id를 그대로 쓴다.

| 단계 전이 | 조건 (`dailyOutputTokens`) |
|---|---|
| digitama → baby | 오늘 output 토큰 ≥ 1 |
| baby → child | 오늘 output 토큰 ≥ 30,000 |
| child → adult | 오늘 output 토큰 ≥ 100,000 |
| adult → perfect | 오늘 output 토큰 ≥ 300,000 |
| perfect → ultimate | 오늘 output 토큰 ≥ 1,000,000 |

- 매일 KST 자정에 합계가 0으로 리셋된다(고정 오프셋 UTC+9, DST 없음).
- `errorRatePct`/`consecutiveDaysActive`/`milestone`/`toolSuccessCount`/`globalToolSuccessCount` 조건 타입은 커스텀 팩 호환을 위해 `lib/evolve.js`에 남아있지만 기본 `evolution-tree.json`에서는 `dailyOutputTokens`만 사용한다.
- `evolution-tree.json`의 `regression` 블록은 제거되었다 — 일일 리셋 자체가 퇴화 역할을 대신한다.

## 일일 토큰 집계 (`daily-tokens.js`)

```bash
node daily-tokens.js
```

- 소스: `~/.claude/projects/*/*.jsonl` (Claude Code 대화 transcript, `$CLAUDEMON_PROJECTS_DIR`로 오버라이드 가능). 각 줄의 최상위 `timestamp`(ISO, UTC)와 `message.usage.output_tokens`(assistant 항목)를 본다. 파싱 실패 줄은 조용히 skip.
- KST(UTC+9) 기준 **오늘 0시 이후** timestamp인 assistant 항목만 합산한다.
- 같은 `message.id`가 여러 줄에 중복 등장할 수 있어(스트리밍/재기록) id별로 dedupe하고 그중 최댓값만 더한다.
- **증분 스캔**: 매 실행마다 전체 파일을 재파싱하지 않는다. `$CLAUDEMON_DIR/token-scan-cache.json`에 파일별 `{ offset, contribution, mtimeMs }`를 저장해 다음 실행에서 새로 추가된 바이트만 읽는다. `mtime`이 오늘 KST 0시 이전인 파일은 아예 열지 않고 skip.
- 날짜가 바뀌면(`dateKST` 변경) 파일별 `contribution`을 0으로 리셋하되 `offset`은 그대로 유지한다(이전 내용을 다시 읽지 않기 위함).
- 출력: `$CLAUDEMON_DIR/daily.json`
  ```json
  { "dateKST": "2026-07-24", "outputTokens": 83002, "stageId": "child", "mon": "guilmon", "updatedAt": "2026-07-24T01:40:35.208Z" }
  ```
- 메뉴바 앱은 이 파일을 ~30초 주기로 폴링해서 스프라이트를 갱신한다. 증분 스캔이므로 재실행 비용은 대체로 수십 ms 이내.

## 스프라이트 팩 (`sprites/packs/`)

**레포에는 도트 이미지가 들어있지 않다.** 스프라이트 PNG는 커밋하지 않으며(`.gitignore`가 `*.png`/`*.gif`를 차단), 각자 원하는 도트를 준비해서 로컬에 넣는다 — 자작 픽셀아트든 라이선스를 확보한 에셋이든, 아래 규격만 맞추면 된다. 리포지토리에는 규격 정의(`pack.json`)와 추출 스크립트 예시(`scripts/`)만 포함된다.

마스코트는 팩(pack) 단위로 스프라이트를 묶는다. 팩 하나는 `sprites/packs/<팩이름>/` 디렉터리이고, `<팩이름>`이 곧 팩의 식별자(예: `daily.json`의 `mon` 값)가 된다. 폴더 이름은 소문자 영문·숫자·하이픈을 권장한다.

### 이미지 규격

| 항목 | 값 |
|---|---|
| 포맷 | PNG (RGBA, 투명 배경) |
| 권장 크기 | 32×32 px (메뉴바에서 16pt = retina 1:1로 표시) |
| 프레임 명명 | `<prefix>-0.png`, `<prefix>-1.png`, … 0부터 연속 번호 |
| 프레임 수 | prefix당 최소 1장. 여러 장을 넣으면 애니메이션으로 순환 재생된다 |

- 크기는 32×32가 아니어도 로드되지만, 표시 시 16pt 정사각형으로 스케일되므로 **정사각형 도트**가 아니면 찌그러진다. 픽셀이 선명하려면 32×32(또는 16의 배수)를 권장한다.
- 각 prefix는 `-0`부터 시작해 번호가 끊기는 지점까지 읽는다. 예를 들어 `idle-0.png`, `idle-1.png`, `idle-2.png`가 있으면 3프레임 애니메이션, `idle-0.png` 하나만 있으면 정지 이미지다.

### 프레임 세트(prefix) 목록

| prefix | 용도 | 필수 여부 |
|---|---|---|
| `idle` | 대기(작업 안 하는 중) 기본 프레임 | **필수** — 팩 로드/전환의 최소 조건 |
| `digitama` | 진화 1단계(알). 로테이션 후보 등록 조건 | **필수(로테이션용)** |
| `baby` / `child` / `adult` / `perfect` / `ultimate` | 진화 2~6단계 | 권장 |
| `limit80` | 사용량 80% 이상일 때 오버라이드(지친 모습) | 선택 |
| `limit95` | 사용량 95% 이상일 때 오버라이드(뻗은 모습) | 선택 |

- **두 개의 필수 조건이 다르다:**
  - `digitama-0.png`가 있어야 [매일 랜덤 선택](#매일-랜덤-몬-선택-libdailyjs)의 **로테이션 후보**로 등록된다 (`lib/daily.js`).
  - `idle-0.png`가 있어야 메뉴바 앱이 실제로 그 팩으로 **전환**한다 (없으면 전환을 건너뛰고 이전 팩을 유지). 팩을 만들 땐 두 파일을 함께 넣는 게 안전하다.
- 진화 단계 프레임(`baby`…`ultimate`)이 비어 있으면 해당 단계에서 자동으로 `idle` 프레임으로 폴백한다. `limit80`/`limit95`가 없으면 사용량이 높아도 현재 단계 프레임을 그대로 쓴다.

### 팩 메타데이터 (`pack.json`, 선택)

팩 디렉터리에 `pack.json`을 두면 메뉴바에 표시할 이름과 단계별 이름을 지정할 수 있다. 없으면 폴더 이름을 그대로 표시한다.

```json
{
  "name": "표시이름",
  "stageNames": {
    "digitama": "알",
    "baby": "...",
    "child": "...",
    "adult": "...",
    "perfect": "...",
    "ultimate": "..."
  }
}
```

### 매일 랜덤 몬 선택 (`lib/daily.js`)

- `computeDailyTokens`가 실행될 때마다 `sprites/packs/` 아래에서 유효 팩 목록(`digitama-0.png` 보유 디렉터리, 이름순 정렬)을 스캔하고, `dateKST` 문자열의 단순 해시(`hashString` — 문자코드 누적, `Math.random` 미사용)를 팩 개수로 나눈 나머지로 그날의 팩을 고른다.
- 같은 KST 날짜 안에서는 몇 번을 재실행해도 같은 팩이 나오고(멱등), `daily.json`에 오늘 날짜의 `mon`이 이미 있으면 도중에 새 팩이 추가돼도 당일은 그 값을 그대로 유지한다. 날짜가 바뀌면 다시 해시로 재계산한다.
- 유효 팩이 하나도 없으면 `mon: "guilmon"`으로 fallback한다(해당 팩 파일이 실제로 있어야 표시된다).

### 새 팩 등록하기

1. `sprites/packs/<새팩이름>/` 디렉터리를 만든다.
2. 최소 `idle-0.png`와 `digitama-0.png`를 넣는다 — 이 둘만 있어도 로테이션 후보 + 전환이 동작한다. 이후 나머지 단계·프레임을 채워나가면 된다.
3. (선택) 표시 이름을 바꾸고 싶으면 `pack.json`을 추가한다.
4. 별도 등록 명령은 없다 — 다음 `daily-tokens.js` 실행(메뉴바 앱이 ~30초 주기로 호출)부터 자동으로 후보에 들어간다.

> 갖고 있는 스프라이트 시트를 잘라 프레임을 만들 때는 `scripts/extract_pack_*.py`를 참고 예시로 쓸 수 있다(시트 크롭 좌표를 팩 규격 PNG로 변환).

## working 플래그

세션이 지금 Claude Code 응답을 생성 중인지(작업 중) 아니면 사용자 입력을 기다리는지(대기 중) 구분하는 플래그.

- `UserPromptSubmit` 훅 → `hook.js turn-start` 호출 → `state.working = true`
- `Stop` 훅 → `hook.js turn-end` 호출 → `state.working = false`, `state.lastTurnEndAt` 기록
- 세션 시작 시(`hook.js session-start`) → `state.working = false`
- `tool-success`/`tool-failure` 이벤트도 안전망으로 `state.working = true`를 함께 설정한다(턴 경계 이벤트가 누락돼도 실제 도구 호출 중임을 반영).

`working`/`lastTurnEndAt`은 세션 상태 파일(`~/.claude/claudemon/sessions/<session_id>.json`)에 저장되며, 카운터에는 영향을 주지 않는다.

## 대기/종료 기록 (`awaitingUserSince`/`endedAt`)

세션이 사용자 응답을 기다리는 중인지, 종료됐는지를 나타내는 사실(fact) 필드. `hook.js`는 이 값을 기록만 하고, 상태 판정(예: stalled/dead 여부)은 하지 않는다.

- `Notification` 훅 → `hook.js notification` 호출 → `state.awaitingUserSince`에 대기 시작 시각(ISO)을 기록. 이미 값이 있으면 덮어쓰지 않는다(최초 대기 시각 유지).
- `turn-start`/`tool-success`/`tool-failure`/`session-start` 이벤트 → `state.awaitingUserSince = null`로 해제(응답 확인/작업 재개).
- `SessionEnd` 훅 → `hook.js session-end` 호출 → `state.endedAt`에 종료 시각을 기록하고, 7일 지난 세션 파일을 정리한다(현재 세션 파일은 제외).
- `session-start`/`turn-start` 이벤트 → `state.endedAt = null`로 해제.

> 이 두 이벤트는 `Notification`/`SessionEnd` 훅을 등록해야 동작한다 — 등록 스니펫은 [설치](#설치) 참고.

## 멀티세션 지원

여러 Claude Code 세션을 동시에 띄우면 마스코트가 세션별로 따로 성장한다.

- `hook.js`/`statusline.js`는 stdin으로 전달되는 Claude Code hook/statusline payload에서 `session_id`를 읽는다.
- `session_id`가 있으면 `~/.claude/claudemon/sessions/<session_id>.json`에 저장하고, 없으면(수동 실행 등) 기존 전역 `state.json`으로 fallback한다.
- 세션 상태 파일에는 기존 필드 외에 `sessionId`, `pid`(hook 실행 시 부모 프로세스 PID), `cwd`, `updatedAt`이 추가로 저장된다. `pid`는 메뉴바 앱 등이 "포커스된 터미널의 claude PID → 세션 파일"을 매칭하는 데 쓰인다.
- `CLAUDEMON_DIR` 환경변수로 루트 디렉터리를 오버라이드하면 세션 파일도 `$CLAUDEMON_DIR/sessions/` 아래에 생성된다.

## 상태 초기화

```bash
# 전역 상태
rm ~/.claude/claudemon/state.json

# 특정 세션 상태
rm ~/.claude/claudemon/sessions/<session_id>.json

# 모든 세션 상태
rm -rf ~/.claude/claudemon/sessions/

# 전역 누적 카운터 (더 이상 진화에 쓰이지 않지만 working 상태 등에 남아있음)
rm ~/.claude/claudemon/global.json

# 일일 토큰 집계 결과 + 증분 스캔 캐시 (다음 실행 시 처음부터 재집계됨)
rm ~/.claude/claudemon/daily.json ~/.claude/claudemon/token-scan-cache.json
```

## 알려진 제한

- 프로토타입 단계다. 메뉴바 앱(`menubar/`)은 macOS 전용이며 직접 빌드해야 한다.
- 진화는 output 토큰 총량 기준이라, 실제 코드 산출량이 아니라 대화가 길어져도 단계가 오른다.
- `limit80`/`limit95` 오버라이드는 statusline HUD의 사용량 캐시에 의존하므로, 해당 데이터가 없으면 동작하지 않는다.
