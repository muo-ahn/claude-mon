# ClaudeMon (프로토타입)

> **도트 이미지는 이 레포에 포함되지 않는다.** 스프라이트는 각자 준비해서 `sprites/packs/`에 넣는다 — 아래 [스프라이트 팩](#스프라이트-팩-spritespacks) 참고.

그날 사용한 토큰량에 따라 성장·진화하는 Claude Code 마스코트. statusline과 macOS 메뉴바 앱 두 곳에서 렌더링된다. 스프라이트는 팩(pack) 단위로 교체·확장할 수 있다.

## 설치

### 요구 사항

- **Node.js** (LTS 권장) — `hook.js`, `statusline.js`, `daily-tokens.js` 실행용. 외부 의존성 없이 stdlib만 쓰므로 `npm install`은 필요 없다.
- **macOS + Swift 툴체인** — 메뉴바 앱을 쓸 경우에만. Xcode 또는 Command Line Tools(`xcode-select --install`)에 포함된 `swiftc`가 필요하다. statusline만 쓸 거라면 생략 가능하다.
- **스프라이트 도트 이미지** — 레포에 포함되지 않는다. [스프라이트 팩](#스프라이트-팩-spritespacks)을 참고해 직접 준비한다.

### 1. 클론

```bash
git clone https://github.com/muo-ahn/claude-mon.git
cd claude-mon
```

아래 예시에서 `/절대/경로/claude-mon`은 클론한 디렉터리의 절대 경로(`pwd`로 확인)로 바꾼다.

### 2. statusline + hook 등록

`~/.claude/settings.json`에 추가한다(기존 설정이 있으면 `statusLine`/`hooks` 키를 병합):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /절대/경로/claude-mon/statusline.js",
    "padding": 0
  },
  "hooks": {
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claude-mon/hook.js tool-success" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claude-mon/hook.js turn-start" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claude-mon/hook.js turn-end" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claude-mon/hook.js session-start" }] }
    ]
  }
}
```

- `PostToolUse`만 등록해도 진화는 동작한다. `UserPromptSubmit`/`Stop`/`SessionStart`는 [working 플래그](#working-플래그)(작업 중/대기 중 표시)를 정확히 하기 위한 것으로 선택 사항이다.
- 실패한 도구 호출도 세고 싶으면 `PostToolUse`에 `hook.js tool-failure` 훅을 하나 더 추가한다.
- 새 세션부터 적용된다. 등록 후 Claude Code 세션을 새로 열면 statusline에 마스코트가 나타난다.

### 3. (선택) 메뉴바 앱 빌드 — macOS

statusline 대신/과 함께 메뉴바에 애니메이션 마스코트를 띄우려면 앱을 직접 빌드한다:

```bash
cd menubar
swiftc -O -o claudemon-menubar claudemon-menubar.swift
./claudemon-menubar &
```

- 빌드 산출물(`menubar/claudemon-menubar`)은 `.gitignore`로 제외되어 있으므로 각자 빌드해야 한다.
- 앱은 accessory(백그라운드 상주) 모드로 뜨며 Dock 아이콘 없이 메뉴바에만 나타난다. `active-session.sh`로 현재 포커스된 세션을 추적하고, 30초마다 `daily-tokens.js`를 호출해 토큰 집계를 갱신한다.
- 로그인 시 자동 실행하려면 `launchd` LaunchAgent(`~/Library/LaunchAgents/`)로 등록하거나 시스템 설정 → 로그인 항목에 추가한다.
- 스프라이트가 하나도 없으면 표시가 비거나 fallback되므로, 먼저 [스프라이트 팩](#스프라이트-팩-spritespacks)을 최소 하나 채운다.

### 상태 저장 위치

상태 파일은 기본적으로 `~/.claude/claudemon/` 아래에 생성된다(`CLAUDEMON_DIR` 환경변수로 오버라이드 가능). 디렉터리는 자동 생성되며, 초기화 방법은 [상태 초기화](#상태-초기화) 참고.

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
- `test/daily.test.js` — 몬 로테이션 회귀 테스트

## 테스트

```bash
node --test
```

Node 내장 러너만 쓴다 (의존성 없음, `package.json`도 없다). 현재 커버 범위는 `lib/daily.js`의 몬 로테이션 — 후보 판정(`listValidPacks`), 해시 분산(`hashString`), 연속 중복 방지(`selectMon`/`prevMon`)다. 실제로 났던 버그를 재현하는 테스트들이라, 각 방어 장치를 하나씩 되돌리면 대응하는 테스트가 실패하는 것까지 확인했다.

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

## 진화 연출 (메뉴바 앱)

단계가 오르는 순간은 하루 최대 5번뿐인데, 16pt 아이콘 안에서 조용히 바뀌면 사실상 관측되지 않는다. 그래서 메뉴바 앱은 두 곳에서 동시에 연출한다.

| 위치 | 내용 |
|---|---|
| 메뉴바 아이콘 | 흰 실루엣이 old ↔ new 형태를 오가는 디지볼브 (~4.5초) |
| 화면 우상단 코너 | borderless 오버레이 창에 [고해상도 초상](#고해상도-초상-portrait-stage) 160pt + "`<이름>` 진화!" 라벨 (~3.5초) |

컷인 창은 클릭을 통과시키고(`ignoresMouseEvents`) 모든 스페이스·전체화면 위에 뜬다. macOS 알림은 쓰지 않는다.

- **배경 패널은 장식이 아니다.** 모프 단계가 순백색 실루엣이라 패널이 없으면 뒤에 흰 창이 있을 때 통째로 사라진다. 검정 alpha 0.6 라운드 패널 + 흰 alpha 0.18 테두리를 깔았고, 색은 시스템 semantic color가 아닌 고정 리터럴이라 라이트/다크 모드와 무관하게 대비가 보장된다.
- 창을 띄울 화면은 `NSScreen.main`으로 고르면 안 된다. 그건 키보드 포커스를 따라가므로 멀티모니터 환경에서 메뉴바가 없는 외부 디스플레이에 렌더링돼 영영 보이지 않는다. 메뉴바를 소유한 화면은 언제나 origin `(0,0)`이다.
- 연출 중 또 진화하면 generation 카운터로 이전 타이머를 무효화한다.

### 연출 미리보기

진화는 손으로 재현할 수 없으므로 전용 플래그가 있다. 기동 직후 컷인을 1회 재생하고 이후 정상 상주한다.

```bash
pkill -f "claudemon-menubar /Users"
nohup /절대/경로/claude-mon/menubar/claudemon-menubar \
  /절대/경로/claude-mon/sprites --demo-cutin perfect ultimate >/dev/null 2>&1 &
```

스테이지 인자를 생략하면 `child ultimate`로 재생한다. 스프라이트 루트 경로는 **`--demo-cutin`보다 앞에** 와야 한다 — 이 플래그 뒤의 인자는 스테이지 이름으로 해석된다.

## 일일 토큰 집계 (`daily-tokens.js`)

```bash
node daily-tokens.js
```

- 소스: `~/.claude/projects/<프로젝트>/` 아래 **모든 깊이**의 `*.jsonl` (Claude Code 대화 transcript, `$CLAUDEMON_PROJECTS_DIR`로 오버라이드 가능). 메인 대화는 `<session>.jsonl`이고 서브에이전트는 `<session>/subagents/agent-<id>.jsonl`에 자기 턴만 따로 기록하므로, 한 단계만 훑으면 서브에이전트가 쓴 토큰이 전부 누락된다. 각 줄은 JSON 오브젝트 하나이며, 다음 필드를 읽는다(그 외 필드는 무시, 파싱 실패 줄은 조용히 skip):
  - 최상위 `timestamp` (ISO 8601, UTC)
  - `message.role === "assistant"` 인 줄만 대상
  - `message.usage.output_tokens` (숫자)
  - dedupe 키로 `message.id`(없으면 최상위 `uuid`)

  실제 Claude Code가 쓰는 줄과 같은 구조이며, 최소 형태는 다음과 같다:
  ```json
  {"timestamp":"2026-07-24T01:40:00.000Z","message":{"role":"assistant","id":"msg_abc","usage":{"output_tokens":5000}}}
  ```
- KST(UTC+9) 기준 **오늘 0시 이후** timestamp인 assistant 항목만 합산한다.
- 같은 `message.id`가 여러 줄에 중복 등장할 수 있어(스트리밍/재기록) id별로 dedupe하고 그중 최댓값만 더한다.
- **transcript 단위 dedupe**: 같은 세션이 프로젝트 디렉터리 두 곳에 동시에 기록될 수 있다 — 같은 레포를 실제 경로와 worktree/심볼릭 경로로 열면 `-Users-...` 디렉터리가 각각 생기고, 양쪽 파일이 같은 메시지를 그대로 반복한다. 그래서 프로젝트 디렉터리 아래 상대 경로(`<session>.jsonl` 또는 `<session>/subagents/agent-<id>.jsonl`)를 transcript의 신원으로 보고, 같은 신원의 사본이 여럿이면 **가장 큰 사본만** 센다(사본은 항상 가장 완전한 사본의 prefix이거나 같다). 일일 합계와 `sessionTokens`가 이 동일한 집계에서 함께 나오므로 둘이 어긋날 수 없다.
- `sessionTokens`의 키는 세션 id이고, 서브에이전트 transcript는 자신을 띄운 세션에 합산된다(별도 세션으로 나타나지 않는다).
- **증분 스캔**: 매 실행마다 전체 파일을 재파싱하지 않는다. `$CLAUDEMON_DIR/token-scan-cache.json`에 파일별 `{ offset, contribution, mtimeMs }`를 저장해 다음 실행에서 새로 추가된 바이트만 읽는다. `mtime`이 오늘 KST 0시 이전인 파일은 아예 열지 않고 skip.
- 날짜가 바뀌면(`dateKST` 변경) 파일별 `contribution`을 0으로 리셋하되 `offset`은 그대로 유지한다(이전 내용을 다시 읽지 않기 위함).
- 출력: `$CLAUDEMON_DIR/daily.json`
  ```json
  { "dateKST": "2026-07-24", "outputTokens": 83002, "stageId": "child", "mon": "guilmon", "prevMon": "agumon", "sessionTokens": { "<session_id>": 5000 }, "updatedAt": "2026-07-24T01:40:35.208Z" }
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
| `digitama` | 진화 1단계(알) | 선택 — 없으면 공용 알 스프라이트로 대체 |
| `baby` / `child` / `adult` / `perfect` / `ultimate` | 진화 2~6단계 | 권장 |
| `limit80` | 사용량 80% 이상일 때 오버라이드(지친 모습) | 선택 |
| `limit95` | 사용량 95% 이상일 때 오버라이드(뻗은 모습) | 선택 |

- **알(digitama)은 종족 무관이라 팩마다 따로 그릴 필요가 없다.** `sprites/shared/digitama-0.png`가 있으면 메뉴바 앱과 `lib/daily.js`의 로테이션 후보 판정 둘 다 그 공용 스프라이트를 우선 사용하고, 팩 자체의 `digitama-0.png`는 공용 파일이 없을 때만 쓰이는 폴백이다 (`scripts/make_shared_digitama.py` 참고).
- `idle-0.png`가 있어야 메뉴바 앱이 실제로 그 팩으로 **전환**한다 (없으면 전환을 건너뛰고 이전 팩을 유지). **로테이션 후보 등록**도 같은 조건을 요구한다 — `idle-0.png`가 없는 디렉터리를 후보로 뽑아봐야 화면은 어제 몬 그대로이므로, `lib/daily.js`의 `listValidPacks`는 `idle-0.png` + digitama(공용 또는 팩 자체)를 둘 다 확인한다.
- `.`으로 시작하는 디렉터리는 후보에서 제외된다. `sprites/packs/`는 평범한 디렉터리라 무관한 도구가 상태 파일을 남길 수 있는데(`.omc/state`), 그런 디렉터리가 후보에 끼면 이름순 정렬에서 뒤 팩들의 인덱스를 통째로 밀어 로테이션이 어긋난다.
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

- `computeDailyTokens`가 실행될 때마다 `sprites/packs/` 아래에서 유효 팩 목록(`.`으로 시작하지 않고, `idle-0.png`가 있고, 자체 `digitama-0.png` 또는 공용 `sprites/shared/digitama-0.png`가 있는 디렉터리, 이름순 정렬)을 스캔하고, `dateKST` 문자열의 해시(`hashString` — 문자코드 누적 + murmur3 fmix32 finalizer, `Math.random` 미사용)를 팩 개수로 나눈 나머지로 그날의 팩을 고른다.
- finalizer가 있어야 하는 이유: 누적 해시만 쓰면 하루 차이 날짜의 해시가 정확히 `+1`이라 인덱스가 알파벳 순서를 하루 한 칸씩 걷는 꼴이 된다. 그러면 앞쪽에 정렬되는 후보가 하나 늘어날 때 인덱스가 한 칸 밀리면서 일일 `+1`과 상쇄돼 **이틀 연속 같은 몬**이 나온다(실제로 `.omc` 때문에 파피몬이 이틀 연속 나온 적 있다). fmix32로 인접 입력을 흩어놓아 이 결합을 끊는다.
- **연속 중복 방지(`prevMon`)**: 해시를 잘 섞어도 균등 분포라면 `1/N` 확률로 어제와 같은 팩이 뽑힌다. 밖에서 보면 우연한 중복과 로테이션 고장이 구분되지 않으므로, `daily.json`의 `prevMon`(직전에 실제로 표시된 팩)과 오늘 뽑힌 팩이 같으면 이름순 다음 팩으로 한 칸 민다. 후보가 1개뿐이면 밀 곳이 없으므로 그대로 둔다.
- 같은 KST 날짜 안에서는 몇 번을 재실행해도 같은 팩이 나오고(멱등), `daily.json`에 오늘 날짜의 `mon`이 이미 있으면 도중에 새 팩이 추가돼도 당일은 그 값을 그대로 유지한다. `prevMon`도 그날 내내 함께 보존된다(30초마다 덮어써도 유실되지 않아야 내일 가드가 비교 대상을 갖는다). 날짜가 바뀌면 그때의 `mon`이 다음 날의 `prevMon`이 되고 해시로 재계산한다.
- 며칠 쉬었다 실행해도 `prevMon`은 "마지막으로 실제 표시된 팩"이라 가드가 그대로 동작한다. `daily.json`이 없거나 깨졌으면 `prevMon`은 `null`이고 가드는 그냥 건너뛴다.
- 유효 팩이 하나도 없으면 `mon: "guilmon"`으로 fallback한다(해당 팩 파일이 실제로 있어야 표시된다).

### 새 팩 등록하기

1. `sprites/packs/<새팩이름>/` 디렉터리를 만든다.
2. 최소 `idle-0.png`를 넣는다 — 팩 자체의 `digitama-0.png` 없이도 `sprites/shared/digitama-0.png`(공용 알)가 있으면 로테이션 후보 + 전환이 동작한다. 공용 알을 아직 안 만들었다면 `python3 scripts/make_shared_digitama.py`로 먼저 생성한다. 이후 나머지 단계·프레임을 채워나가면 된다.
3. (선택) 표시 이름을 바꾸고 싶으면 `pack.json`을 추가한다.
4. 별도 등록 명령은 없다 — 다음 `daily-tokens.js` 실행(메뉴바 앱이 ~30초 주기로 호출)부터 자동으로 후보에 들어간다.

> 갖고 있는 스프라이트 시트를 잘라 프레임을 만들 때는 `scripts/extract_pack_*.py`를 참고 예시로 쓸 수 있다(시트 크롭 좌표를 팩 규격 PNG로 변환).

### 진화체 스프라이트 (`adult`/`perfect`/`ultimate`)

`scripts/extract_pack_<mon>.py`가 쓰는 Battle Spirit 시트에는 성장기(Rookie) 본인의 모션만 있고 진화체 프레임이 없다. 그래서 상위 3단계는 원래 "성장기가 강한 포즈를 취한 그림"으로 대체돼 있었고, 이름은 `pack.json`의 `stageNames`를 따라 그레이몬/메탈그레이몬/워그레이몬으로 표시되는데 도트는 아구몬인 불일치가 있었다.

`scripts/extract_pack_evolved_dwds.py`가 이 세 단계를 **Digimon World DS** 시트에서 다시 뽑는다 — DWDS에는 게임 내 모든 진화체의 필드(보행) 스프라이트가 32×32 언저리 크기로 들어있다.

1. 시트를 `sprites/sheets/dwds/<이름>.png`로 넣는다. 필요한 이름은 스크립트의 `PICKS` 표 참고(예: `greymon`, `metalgreymon`, `wargreymon`).
2. `python3 scripts/extract_pack_evolved_dwds.py [팩이름 ...]` — 인자를 생략하면 표에 있는 7개 팩을 모두 처리한다.

프레임 위치는 손으로 좌표를 재지 않는다. 밴드를 시트 아래로 훑으면서 **그 밴드 안에서만** 지배적인 색(시트 배경색 + 셀 패널색)을 배경으로 잡아 분할하고, 크기가 고르고 등간격이며 밴드 경계에 잘리지 않은 작은 스프라이트가 가장 많이 나오는 밴드를 필드 스프라이트 행으로 고른다. 사람이 정한 값은 `PICKS`의 프레임 인덱스 2개(정면 포즈 — 행 안에서의 위치가 시트마다 다르다)뿐이다.

한계: 임프몬 라인의 스컬사탄몬은 DWDS에 없어 완전체를 뱀파이몬으로 대체했다(`sprites/packs/impmon/pack.json`의 이름도 그에 맞춰져 있다). 원본이 32px보다 큰 프레임은 축소되므로 픽셀이 1:1로 유지되지 않는다 — 실행 시 해당 파일 목록을 출력한다.

### 고해상도 초상 (`portrait-<stage>`)

32px 스프라이트는 메뉴바 16pt에서 실루엣만 남는다. 성장기까지는 그걸로도 구분되지만 완전체·궁극체처럼 장식과 무기가 많은 디자인은 형태가 뭉개져 어떤 몬인지 알 수 없다. 메뉴바 두께는 macOS 제약이라 못 키우므로, [진화 컷인](#진화-연출-메뉴바-앱)과 [드롭다운 헤더](#드롭다운)에서 쓸 큰 그림을 따로 둔다.

| 항목 | 값 |
|---|---|
| 파일명 | `portrait-<stage>-0.png`, `portrait-<stage>-1.png` |
| stage | `adult` / `perfect` / `ultimate` |
| 크기 | 원본 해상도 그대로 (~66×98 ~ 174×162). **32px로 줄이지 않는다** — 표시 크기는 앱이 정한다 |
| 프레임 | `-1`은 선택. 없으면 정지 이미지로 처리된다 |

- **두 프레임의 캔버스 크기는 반드시 같아야 한다.** 다르면 프레임이 교대될 때 스프라이트가 튄다. 추출 스크립트는 두 포즈의 union bbox로 패딩해 맞춘다.
- 초상이 없는 단계(`digitama`/`baby`/`child`, 또는 아직 추출하지 않은 팩)는 32px 스프라이트를 **4배 nearest-neighbor로 확대**해 폴백한다. 초상이 하나도 없어도 컷인과 드롭다운 헤더는 정상 동작한다.
- 앱은 확대·드로잉 전 구간에서 `imageInterpolation = .none`을 강제한다. 이게 빠지면 픽셀아트가 전부 뿌옇게 뭉개진다.

`scripts/extract_portraits_dwds.py`가 같은 DWDS 시트의 **상단 배틀 포즈**에서 뽑는다(위 스크립트가 쓰는 건 하단 필드 스프라이트다). 시트 준비 방법과 `PICKS` 표는 위 절과 동일하다.

```bash
python3 scripts/extract_portraits_dwds.py [팩이름 ...]
```

배경색은 시트 가장자리 샘플링으로 검출한다 — 전역 dominant color를 쓰면 캐릭터 외곽선 회색이 배경으로 오검출된다. 포즈 행은 y-range가 실제로 겹칠 때만 같은 행으로 묶는다(행간이 9~14px인 시트가 있어 gap을 허용하면 두 행이 병합된다). 크레딧 텍스트·로고는 "행당 포즈 2개 이상" 조건으로 걸러진다. 2프레임 자동 선택이 실패하는 8개 시트는 `POSE_OVERRIDES`에 육안 확인한 인덱스를 명시해뒀다.

한계: 메가가르고몬은 원본 시트에 유사 포즈밖에 없어 두 프레임이 거의 같다.

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
- `turn-start`/`tool-success`/`tool-failure`/`session-start`/`turn-end` 이벤트 → `state.awaitingUserSince = null`로 해제(응답 확인/작업 재개). `turn-end`(`Stop` 훅)는 턴이 실제로 끝날 때만 발화하고 권한 프롬프트 대기 중에는 막혀 있으므로, 권한 거부처럼 `tool-success`/`tool-failure`가 오지 않는 경로에서 대기 상태가 남는 것을 막아준다.
- `SessionEnd` 훅 → `hook.js session-end` 호출 → `state.endedAt`에 종료 시각을 기록하고, 7일 지난 세션 파일을 정리한다(현재 세션 파일은 제외).
- `session-start`/`turn-start` 이벤트 → `state.endedAt = null`로 해제.

> 이 두 이벤트는 `Notification`/`SessionEnd` 훅을 등록해야 동작한다 — 등록 스니펫은 [설치](#설치) 참고. 이 값들이 상태 판정에 어떻게 쓰이는지는 [세션 상태 판정과 표시](#세션-상태-판정과-표시-메뉴바) 참고.

## 세션 상태 판정과 표시 (메뉴바)

메뉴바 앱은 세션 상태 파일의 사실 필드(`working`, `awaitingUserSince`, `endedAt`, `pid`)로부터 세션 상태를 5가지로 판정한다. 위에서부터 처음 맞는 조건 하나로 결정된다.

1. `endedAt`이 기록됨 → `dead`
2. 기록된 `pid`가 살아있지 않음 → `dead`
3. `awaitingUserSince`가 기록됨 → `waiting_user` (권한 프롬프트는 턴 중간에도 뜰 수 있어 working보다 우선한다)
4. `working = true`인데 세션 파일이 10분 넘게 갱신되지 않음 → `stalled`
5. `working = true` → `working`
6. 그 외 → `idle`

### 전역 상태(메뉴바 아이콘)

메뉴바 아이콘은 모든 세션을 종합한 상태 하나를 표시한다.

- `dead` 세션은 전역 집계에서 제외한다(죽은 세션이 살아있는 세션을 가리면 안 되므로).
- 남은 세션 중 가장 긴급한 것을 표시한다: `waiting_user > stalled > working > idle`.

### 스프라이트 프레임 매핑

신규 프레임은 추가되지 않는다 — 기존 [프레임 세트(prefix) 목록](#프레임-세트prefix-목록)을 재사용한다.

| 상태 | 사용 프레임 | 모션 |
|---|---|---|
| working | 현재 진화 단계 프레임 | 애니메이션 |
| idle | 현재 진화 단계 프레임 | 정지 |
| waiting_user | 팩의 범용 `idle-N` 프레임 | 애니메이션 |
| stalled | `limit80-N` 프레임 | 정지 |
| dead | (아이콘에 반영 안 됨 — 드롭다운에만 표시) | — |

최종 프레임 우선순위: `limit95 > waiting_user > stalled > limit80 > 진화 단계`. `limit80` 프레임이 팩에 없으면 stalled는 진화 단계 프레임으로 폴백한다(기존 팩과 호환).

`waiting_user`가 범용 `idle-N`을 쓰는 이유: `idle` 상태는 진화 단계 프레임의 *정지*로 이미 표시되므로, 범용 `idle` 프레임은 원래 쓰이지 않던 슬롯이었다. 그 슬롯을 재사용해 셋을 시각적으로 구분한다.

### 드롭다운

첫 항목은 텍스트가 아니라 커스텀 뷰 헤더다 — [고해상도 초상](#고해상도-초상-portrait-stage) 150pt + 이름 + 단계 + 오늘 토큰. 진화 컷인을 놓쳐도 아이콘을 눌러 언제든 지금 형태를 크게 볼 수 있다.

세션별 라벨: `● 작업 중` / `! 입력 대기` / `⏸ 멈춤` / `○ 대기` / `× 종료`

- `× 종료`(dead)는 종료 후 5분간만 표시되고 사라진다.
- 정렬은 긴급도 순이다.
- 요약 줄에 입력 대기 세션이 있으면 먼저 알린다.

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
