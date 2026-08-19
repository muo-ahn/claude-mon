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
- 로그인 시 자동 실행은 아래 [LaunchAgent 등록](#로그인-시-자동-실행-launchagent) 참고.
- 스프라이트가 하나도 없으면 표시가 비거나 fallback되므로, 먼저 [스프라이트 팩](#스프라이트-팩-spritespacks)을 최소 하나 채운다.

### 로그인 시 자동 실행 (LaunchAgent)

`~/Library/LaunchAgents/com.muo.claudemon-menubar.plist` — 경로는 절대경로여야 하고 `<홈>`·`<레포>`를 각자 값으로 바꾼다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.muo.claudemon-menubar</string>
	<key>ProgramArguments</key>
	<array>
		<string><레포>/menubar/claudemon-menubar</string>
		<string><레포>/sprites</string>
		<string>--no-cutin</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string><홈>/Library/Logs/claudemon-menubar.log</string>
	<key>StandardErrorPath</key>
	<string><홈>/Library/Logs/claudemon-menubar.log</string>
</dict>
</plist>
```

```bash
# 등록 + 즉시 기동. 이미 수동으로 띄운 인스턴스가 있으면 먼저 죽인다(아이콘이 두 개 생긴다)
pkill -f "claudemon-menubar /Users"
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.muo.claudemon-menubar.plist

launchctl print gui/$(id -u)/com.muo.claudemon-menubar   # 상태 확인
launchctl kickstart -k gui/$(id -u)/com.muo.claudemon-menubar   # 재빌드 후 재기동
launchctl bootout gui/$(id -u)/com.muo.claudemon-menubar        # 해제
```

- `ProcessType`은 `Interactive`여야 한다. 기본값이면 launchd가 백그라운드 등급으로 강등해 메뉴바 UI 응답이 느려질 수 있다.
- `KeepAlive`는 넣지 않는 게 좋다. 켜면 `pkill`로 죽인 순간 launchd가 **plist에 적힌 인자로** 즉시 되살리므로, `--demo-cutin`처럼 다른 플래그로 띄워 확인하는 절차와 계속 충돌한다.
- `node`는 PATH가 아니라 `/opt/homebrew/bin` → `/usr/local/bin` → `/usr/bin` 순서로 절대경로 탐색하므로(`findNodeBinary()`), launchd의 빈약한 PATH에서도 토큰 집계가 동작한다. 단 nvm/mise로만 설치한 node는 이 목록에 없어 집계가 조용히 멈춘다 — 그 경우 심볼릭 링크를 걸어준다.
- 실행 인자를 바꿨으면 `bootout` → `bootstrap`을 다시 해야 한다. `kickstart`는 기존 plist 그대로 재기동할 뿐이다.

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

Node 내장 러너만 쓴다 (의존성 없음, `package.json`도 없다). 현재 커버 범위는 `lib/daily.js`의 몬 로테이션 — 팩 유효성(`listValidPacks`), 로테이션 후보 판정(`listRotationPacks`), 해시 분산(`hashString`), 셔플 덱 로테이션(`selectMon` — 사이클 내 1회씩 배치·멱등·에폭 이전 음수 `dayIndex`·풀 크기 변경·N배수 일수 분포 균등성)과 연속 중복 방지(`prevMon` 가드), 분기 루트 추첨(`selectRoute` — 하루 고정·조건 게이트·lazy binding), 팩 트리 검증(`validatePackTree`), 몬 등장 이력(`mon-history.json` — append/제자리 갱신/쓰기 생략/60개 트림/degrade) — 과 조건 엔진(`lib/evolve.js`의 `checkCondition`/`conditionMet` — 조건 타입 전체 + `all` 합성), 그리고 토큰 집계(transcript 신원 dedupe, 서브에이전트 합산, 단계 임계값)다. 실제로 났던 버그를 재현하는 테스트들이라, 각 방어 장치를 하나씩 되돌리면 대응하는 테스트가 실패하는 것까지 확인했다.

## 진화 단계 (일일 KST 토큰 소모량 기준)

진화 **단계**(digitama → ... → superultimate로 오르는 것)는 **그날(KST, 자정 리셋) 소모한 output 토큰 총량**으로만 결정된다. 세션/전역 tool-success 카운터(`hook.js`, `lib/state.js`)는 여전히 `working` 플래그 등 행동 상태 용도로 유지되고, 단계 자체를 밀어 올리는 데는 쓰이지 않는다.

다만 같은 단계 안에서 **어느 분기**로 진화하는지는 이 카운터에서 파생된 지표(세션 수·집중도·도구 실패율)가 결정한다 — [랜덤 진화](#랜덤-진화-분기-루트) 참고. "단계"와 "분기"는 서로 다른 결정이다.

단계는 7개(`digitama` → `baby` → `child` → `adult` → `perfect` → `ultimate` → `superultimate`)이며, 스프라이트 파일명도 이 stage id를 그대로 쓴다.

| 단계 전이 | 조건 (`dailyOutputTokens`) |
|---|---|
| digitama → baby | 오늘 output 토큰 ≥ 1 |
| baby → child | 오늘 output 토큰 ≥ 30,000 |
| child → adult | 오늘 output 토큰 ≥ 100,000 |
| adult → perfect | 오늘 output 토큰 ≥ 300,000 |
| perfect → ultimate | 오늘 output 토큰 ≥ 1,000,000 |
| ultimate → superultimate | 오늘 output 토큰 ≥ 2,000,000 |

- 매일 KST 자정에 합계가 0으로 리셋된다(고정 오프셋 UTC+9, DST 없음).
- `superultimate`(초궁극체, 2M) 임계값은 실측으로 정했다. 집계를 고친 뒤 16일치를 재계산했을 때 1M+는 4일, 2M+는 1일(최고 2.75M)이었다 — 1M이 4일에 한 번꼴이 되면서 궁극체의 희소성이 사라진 자리를 메우는 단계다.
- **최상위 단계에 도달하지 못하는 팩은 로테이션 후보에서 빠진다** — 아래 [로테이션 후보 요건](#로테이션-후보-요건) 참고.
- `errorRatePct`/`consecutiveDaysActive`/`milestone`/`toolSuccessCount`/`globalToolSuccessCount` 조건 타입은 커스텀 팩 호환을 위해 `lib/evolve.js`에 남아있지만 기본 `evolution-tree.json`에서는 `dailyOutputTokens`만 사용한다.
- `evolution-tree.json`의 `regression` 블록은 제거되었다 — 일일 리셋 자체가 퇴화 역할을 대신한다.

## 진화 연출 (메뉴바 앱)

단계가 오르는 순간은 하루 최대 5번뿐인데, 16pt 아이콘 안에서 조용히 바뀌면 사실상 관측되지 않는다. 그래서 메뉴바 앱은 두 곳에서 동시에 연출한다.

| 위치 | 내용 |
|---|---|
| 메뉴바 아이콘 | 흰 실루엣이 old ↔ new 형태를 오가는 디지볼브 (~4.5초) |
| 화면 우상단 코너 | borderless 오버레이 창에 [큰 화면용 도트](#큰-화면용-도트-3종) 208pt + "`<이름>` 진화!" 라벨 (~3.5초) |

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

### 컷인 끄기

우상단 오버레이는 의도적으로 시선을 끌기 때문에 집중 중에는 방해가 된다. 둘 중 하나로 끈다. 메뉴바 아이콘의 디지볼브 플래시와 드롭다운 초상은 영향받지 않는다 — 그건 봐야 보이는 연출이라 몰입을 깨지 않는다.

```bash
# 플래그 (모든 것보다 우선)
nohup .../claudemon-menubar .../sprites --no-cutin >/dev/null 2>&1 &

# 환경변수 (플래그를 넘길 수 없는 로그인 항목·래퍼용). 0/false/off/no 인식
CLAUDEMON_CUTIN=0 nohup .../claudemon-menubar .../sprites >/dev/null 2>&1 &
```

`--demo-cutin`은 환경변수를 무시하고 다시 켠다(미리보기가 조용히 실패하면 디버깅이 어렵다). 단 `--no-cutin`이 함께 있으면 그쪽이 이긴다.

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

### `mon-history.json`

- 위치: `$CLAUDEMON_DIR/mon-history.json`. 오늘의 팩이 확정된 직후(`daily.json`을 쓰기 전) `computeDailyTokens`가 기록한다.
- 형식: `{ "version": 1, "entries": [{ "date": "2026-08-17", "mon": "agumon" }, ...] }`, `entries`는 과거 → 최신 순.
- 상한 60개짜리 링버퍼다 — 초과분은 오래된 것부터 버린다.
- **관찰용이다.** `selectMon`의 `avoidMon` 가드는 이 파일이 아니라 여전히 `daily.json`의 `prevMon`만 본다 — 셔플 덱으로 바꾼 뒤 실제 등장 빈도가 고르게 나오는지 사후 확인하려는 용도로만 쓴다.
- 쓰기 최소화: 30초 폴링마다 호출되지만, 마지막 항목의 날짜·팩이 이번 것과 둘 다 같으면 파일 I/O 자체를 하지 않는다. 날짜는 같은데 팩만 다르면(수동으로 `daily.json`의 `mon`을 바꿔치기한 경우) 새 행을 추가하는 대신 마지막 항목을 제자리에서 갱신한다. 파일이 없거나 손상됐거나 `version`이 다르면 조용히 빈 이력으로 취급한다(`daily.json`/캐시와 동일한 degrade 정책). 이력 쓰기가 실패해도 `daily.json` 갱신이나 30초 폴링 루프에는 영향이 없다.

## 스프라이트 팩 (`sprites/packs/`)

**레포에는 도트 이미지가 들어있지 않다.** 스프라이트 PNG는 커밋하지 않으며(`.gitignore`가 `*.png`/`*.gif`를 차단), 각자 원하는 도트를 준비해서 로컬에 넣는다 — 자작 픽셀아트든 라이선스를 확보한 에셋이든, 아래 규격만 맞추면 된다. 리포지토리에는 규격 정의(`pack.json`)와 추출 스크립트 예시(`scripts/`)만 포함된다.

마스코트는 팩(pack) 단위로 스프라이트를 묶는다. 팩 하나는 `sprites/packs/<팩이름>/` 디렉터리이고, `<팩이름>`이 곧 팩의 식별자(예: `daily.json`의 `mon` 값)가 된다. 폴더 이름은 소문자 영문·숫자·하이픈을 권장한다.

### 이미지 규격

| 항목 | 값 |
|---|---|
| 포맷 | PNG (RGBA, 투명 배경) |
| 권장 크기 | 32×32 px (메뉴바에서 16pt = retina 1:1로 표시). 큰 화면용 `large-*`/`portrait-*`는 원본 해상도를 유지한다 — [큰 화면용 도트 3종](#큰-화면용-도트-3종) 참고 |
| 프레임 명명 | `<prefix>-0.png`, `<prefix>-1.png`, … 0부터 연속 번호 |
| 프레임 수 | prefix당 최소 1장. 여러 장을 넣으면 애니메이션으로 순환 재생된다 |

- 크기는 32×32가 아니어도 로드되지만, 표시 시 16pt 정사각형으로 스케일되므로 **정사각형 도트**가 아니면 찌그러진다. 픽셀이 선명하려면 32×32(또는 16의 배수)를 권장한다.
- 각 prefix는 `-0`부터 시작해 번호가 끊기는 지점까지 읽는다. 예를 들어 `idle-0.png`, `idle-1.png`, `idle-2.png`가 있으면 3프레임 애니메이션, `idle-0.png` 하나만 있으면 정지 이미지다.

### 프레임 세트(prefix) 목록

| prefix | 용도 | 필수 여부 |
|---|---|---|
| `idle` | 대기(작업 안 하는 중) 기본 프레임 | **필수** — 팩 로드/전환의 최소 조건 |
| `digitama` | 진화 1단계(알) | 선택 — 없으면 공용 알 스프라이트로 대체 |
| `baby` / `child` / `adult` / `perfect` / `ultimate` / `superultimate` | 진화 2~7단계 | 권장 |
| `limit80` | 사용량 80% 이상일 때 오버라이드(지친 모습) | 선택 |
| `limit95` | 사용량 95% 이상일 때 오버라이드(뻗은 모습) | 선택 |
| `large-<stage>` | 큰 화면용 원본 해상도 필드 도트 | 선택 — 없으면 32px 도트를 정수배 확대해 폴백 |
| `portrait-<stage>` | 큰 화면용 배틀 포즈 초상 | 권장 — 없으면 `large-<stage>`, 그것도 없으면 정수배 확대 |

- **알(digitama)은 종족 무관이라 팩마다 따로 그릴 필요가 없다.** `sprites/shared/digitama-0.png`가 있으면 메뉴바 앱과 `lib/daily.js`의 로테이션 후보 판정 둘 다 그 공용 스프라이트를 우선 사용하고, 팩 자체의 `digitama-0.png`는 공용 파일이 없을 때만 쓰이는 폴백이다 (`scripts/make_shared_digitama.py` 참고).
- `idle-0.png`가 있어야 메뉴바 앱이 실제로 그 팩으로 **전환**한다 (없으면 전환을 건너뛰고 이전 팩을 유지). **로테이션 후보 등록**도 같은 조건을 요구한다 — `idle-0.png`가 없는 디렉터리를 후보로 뽑아봐야 화면은 어제 몬 그대로이므로, `lib/daily.js`의 `listValidPacks`는 `idle-0.png` + digitama(공용 또는 팩 자체)를 둘 다 확인한다.
- `.`으로 시작하는 디렉터리는 후보에서 제외된다. `sprites/packs/`는 평범한 디렉터리라 무관한 도구가 상태 파일을 남길 수 있는데(`.omc/state`), 그런 디렉터리가 후보에 끼면 이름순 정렬에서 뒤 팩들의 인덱스를 통째로 밀어 로테이션이 어긋난다.
- 진화 단계 프레임이 비어 있으면 **바로 아래 단계의 프레임**을 물려받는다(예: `superultimate` 도트를 아직 안 넣었으면 `ultimate` 도트로 표시). 아래로 내려가도 아무 것도 없으면 마지막 폴백이 `idle`이다. 알(`digitama`)은 종족 무관 공용 스프라이트라 위 단계의 폴백원이 되지 않는다 — 예전에는 모든 미보유 단계가 곧바로 `idle`로 폴백했는데, 그러면 새 단계를 트리에 먼저 추가한 순간 진화하자마자 성장기로 *퇴화한 것처럼* 보였다. `limit80`/`limit95`가 없으면 사용량이 높아도 현재 단계 프레임을 그대로 쓴다.

### 로테이션 후보 요건

`listValidPacks`(팩이 로드 가능한가)와 `listRotationPacks`(오늘의 몬으로 뽑을 후보인가)는 다른 질문이다. 후자는 전자에 조건 하나를 더 얹는다 — **`pack.json`의 `stageNames`에 트리 최상위 단계(현재 `superultimate`)의 이름이 있어야 한다.**

- 최상위 단계까지 진화하지 못하는 계보는 한 달 중 가장 무거운 날에 천장 한 칸 아래에 머무른다. 그런 팩은 도달할 수 없는 단계를 붙여 보여주는 대신 로테이션에서 빼둔다.
- 후보에서 빠져도 팩 자체는 유효하다 — 명시적으로 지정하거나 `guilmon` 폴백으로 걸리면 그대로 렌더된다.
- 기준값은 `evolution-tree.json`의 마지막 단계에서 읽으므로(`topStageId()`), 나중에 단계를 더 추가하면 기준도 함께 올라간다.
- 현 기본 팩 10개 중 1개(가오몬)가 후보에서 빠져 있다. 초궁극체 미라지가오가몬 버스트 모드의 DWDS 시트는 로컬에 있지만 photobucket 워터마크 박힌 저해상도 리핑이라 도트를 구할 수 없다. `pack.json`의 `superultimate` 이름이 비어 있다 — 나중에 대체 시트를 확보하면 이름 한 줄을 넣는 것으로 다시 후보가 된다.
- 후보가 줄어드는 만큼 반대 방향도 열려 있다: 초궁극체까지 이어지는 계보를 새로 추가하면 그대로 후보가 된다. 케라몬 팩(→ 아마게몬)과 팔코몬 팩(→ 크로노몬 홀리 모드)이 그렇게 들어왔다.

### 랜덤 진화 (분기 루트)

디지몬은 같은 종족이라도 성장 배경에 따라 다른 형태로 진화한다. claudemon도 하루 단위로 **루트**를 뽑는다 — 오늘의 마스코트는 (팩, 루트) 쌍이다.

**트리는 `pack.json`의 `tree`에 있다.** stage id → 노드 배열이고, 각 노드는 `{ id, name, sprite, evolutions }`다. 각 단계 배열의 **첫 노드가 그 단계의 spine**(아무 것도 개입하지 않을 때의 형태)이다. `sprite`가 그대로 파일 prefix라서 분기 도트는 `adult-geogreymon-0.png`처럼 저장되고, spine은 기존 `adult-0.png`를 그대로 쓴다.

**`evolutions`는 우선순위가 있는 조건 목록이다.**

```json
{
  "id": "geogreymon",
  "name": "지오그레이몬",
  "sprite": "adult-geogreymon",
  "evolutions": [
    { "to": "rizegreymon",  "when": { "type": "sessionCount", "gte": 5 } },
    { "to": "metalgreymon", "when": null }
  ]
}
```

- **순서 = 우선순위, 첫 매칭 승리.** 위에서부터 조건을 검사해 처음 만족하는 엣지로 넘어간다.
- **`when: null`(또는 필드 자체가 없음)은 무조건 엣지다.** 최상위 단계가 아닌 모든 노드는 **마지막 엣지가 반드시 `when: null`**이어야 한다 — 이게 도달 보장이다("2M 토큰을 찍으면 반드시 초궁극체에 닿는다"). `validatePackTree`(`lib/daily.js`, `node --test`에 포함)가 이 규칙과 함께 존재하지 않는 `to`, 단계 스킵, 알 수 없는 조건 `type`을 검사한다. 위반이 있어도 런타임은 죽지 않고 조용히 전체 후보로 폴백한다 — 검증은 여기서 잡는다.
- **같은 우선순위에서 조건을 통과한 후보가 둘 이상이면** `hashString(dateKST|팩|단계)` tie-break로 결정적으로 하나를 고른다(둘 다 `when: null`이면 둘 다 동률로 참여한다) — 이것 때문에 재실행해도 그날은 같은 결과가 나온다.
- **`when`이 지원하는 조건 타입** (`lib/evolve.js` `checkCondition`): `sessionCount`(그날 세션 수, `gte`), `topSharePct`(최다 세션이 그날 output에서 차지하는 %, `gte`/`lte`), `failureRatioPct`(`global.json`의 **누적** 도구 실패율 %, `gte`/`lte` — 일일 값이 아니다), `dailyOutputTokens`, `toolSuccessCount`, `globalToolSuccessCount`, `errorRatePct`, `consecutiveDaysActive`, `milestone`. 여러 조건을 한꺼번에 걸려면 `"when": { "all": [ {...}, {...} ] }`(중첩 가능) — 옛 2항 `and` 문법도 계속 동작한다.
- **`next: ["id", ...]`도 계속 지원한다** — 하위 호환용이며, 각 항목이 `{ to: id, when: null }`로 정규화된다(무조건 엣지만 표현 가능). 기존 팩은 무수정으로 그대로 동작한다. 한 노드에 `evolutions`가 있으면 `next`는 무시된다.

**Lazy binding.** 오늘 이미 도달한 단계는 그날 안에 절대 바뀌지 않는다(눈앞의 형태가 흔들리지 않는다). 아직 도달하지 않은 상위 단계는 30초마다 도는 재계산 때마다 **그 시점의 신호**로 다시 평가된다 — 아직 오르지 않은 단계라면, 거기 도달하기 전까지 조건을 채우기만 하면 그 분기가 반영된다. 재계산은 결정론적이라 신호가 그대로면 결과도 바이트 단위로 그대로다.

`daily.json`에 `route`(단계별 `{id, name, sprite}`)가 추가된다. 메뉴바 앱은 `route[단계].sprite`를 프레임 prefix로, `route[단계].name`을 표시 이름으로 쓰고, 루트가 바뀌면 프레임 세트를 다시 읽는다. 트리가 없는 팩은 `route: null`이라 기존 `stageNames` 경로로 그대로 동작한다.


### 팩 메타데이터 (`pack.json`, 선택)

팩 디렉터리에 `pack.json`을 두면 메뉴바에 표시할 이름과 단계별 이름을 지정할 수 있다. 없으면 폴더 이름을 그대로 표시한다. 표시용이지만 완전히 선택은 아니다 — 최상위 단계 이름은 로테이션 후보 판정에도 쓰인다(위 [로테이션 후보 요건](#로테이션-후보-요건)).

```json
{
  "name": "표시이름",
  "stageNames": {
    "digitama": "알",
    "baby": "...",
    "child": "...",
    "adult": "...",
    "perfect": "...",
    "ultimate": "...",
    "superultimate": "..."
  }
}
```

### 매일 랜덤 몬 선택 (`lib/daily.js`)

- `computeDailyTokens`가 실행될 때마다 `sprites/packs/` 아래에서 로테이션 후보 목록(`.`으로 시작하지 않고, `idle-0.png`가 있고, 자체 `digitama-0.png` 또는 공용 `sprites/shared/digitama-0.png`가 있고, `pack.json`이 최상위 단계 이름을 선언한 디렉터리, 이름순 정렬)을 스캔하고, **시드 기반 셔플 덱**으로 그날의 팩을 고른다: `dateKST`를 `MON_DECK_EPOCH_KST`(`2026-01-01`) 기준 일수(`dayIndex`, 에폭 이전이면 음수)로 바꾼 뒤 후보 개수 `N`으로 나눈 몫(`cycle`)·나머지(`pos`, 항상 0..N-1)를 구하고, `hashString(\`${cycle}|${N}\`)`을 시드로 이름순 후보 목록을 mulberry32 기반 결정적 Fisher-Yates로 섞은 "그 사이클의 덱"에서 `deck[pos]`를 오늘의 픽으로 쓴다. 팩 개수가 바뀌면 시드도 바뀌므로(N이 시드에 포함) 팩 추가/삭제 시 해당 사이클 전체가 다시 섞인다.
- 예전 방식(`hashString(dateKST) % N`)을 버린 이유: murmur3 fmix32로 해시를 잘 섞어도 `% N`의 나머지 분포 자체가 균등하지 않아, 개별 팩의 장기 등장 빈도가 최대 2배까지 벌어졌다(실측: 90일간 9개 팩 기준 keramon 18회 vs veemon 6회, 기대값 10회). 셔플 덱은 사이클(N일)마다 각 팩이 정확히 한 번씩 배치되므로 이 편향이 구조적으로 없다.
- **연속 중복 방지(`prevMon`)**: 덱 자체가 한 사이클 안의 중복은 없애지만, 사이클 경계(이전 사이클의 마지막 자리와 다음 사이클의 첫 자리가 우연히 같은 팩일 수 있다)와 사용자가 `daily.json`의 `mon`을 수동으로 갈아끼운 경우는 덱만으로 못 막는다. 그래서 `daily.json`의 `prevMon`(직전에 실제로 표시된 팩)과 오늘 뽑힌 팩이 같으면 덱의 다음 자리(`deck[(pos+1)%N]`)로 한 칸 민다. 후보가 1개뿐이면 밀 곳이 없으므로 그대로 둔다.
- 보장되는 것: 한 사이클(N일) 안에 각 팩이 정확히 1회 등장 + 연속 이틀 중복 없음(위 `prevMon` 가드). 보장되지 않는 것: 같은 팩이 재등장하기까지의 최소 간격 — 사이클 k의 마지막 자리와 k+1의 첫 자리에 우연히 같은 팩이 오면 사이클 경계를 넘어 2~3일 만에 재등장할 수 있다.
- 같은 KST 날짜 안에서는 몇 번을 재실행해도 같은 팩이 나오고(멱등 — 시드 기반 셔플이라 `Math.random`은 쓰지 않는다), `daily.json`에 오늘 날짜의 `mon`이 이미 있으면 도중에 새 팩이 추가돼도 당일은 그 값을 그대로 유지한다. `prevMon`도 그날 내내 함께 보존된다(30초마다 덮어써도 유실되지 않아야 내일 가드가 비교 대상을 갖는다). 날짜가 바뀌면 그때의 `mon`이 다음 날의 `prevMon`이 되고 덱에서 재계산한다.
- 며칠 쉬었다 실행해도 `prevMon`은 "마지막으로 실제 표시된 팩"이라 가드가 그대로 동작한다. `daily.json`이 없거나 깨졌으면 `prevMon`은 `null`이고 가드는 그냥 건너뛴다.
- 후보가 하나도 없으면 `mon: "guilmon"`으로 fallback한다(해당 팩 파일이 실제로 있어야 표시된다). 후보가 정확히 하나면 덱을 만들 것도 없이 그 팩을 그대로 반환한다.
- 어떤 팩이 실제로 며칠에 한 번 나왔는지는 `mon-history.json`에 관찰용으로 남는다 — 아래 [`mon-history.json`](#mon-historyjson) 참고.

### 새 팩 등록하기

1. `sprites/packs/<새팩이름>/` 디렉터리를 만든다.
2. 최소 `idle-0.png`를 넣는다 — 팩 자체의 `digitama-0.png` 없이도 `sprites/shared/digitama-0.png`(공용 알)가 있으면 로테이션 후보 + 전환이 동작한다. 공용 알을 아직 안 만들었다면 `python3 scripts/make_shared_digitama.py`로 먼저 생성한다. 이후 나머지 단계·프레임을 채워나가면 된다.
3. `pack.json`을 추가한다 — 표시 이름 지정용이지만, `stageNames`에 최상위 단계(`superultimate`) 이름이 없으면 로테이션 후보로 뽑히지 않는다.
4. 별도 등록 명령은 없다 — 다음 `daily-tokens.js` 실행(메뉴바 앱이 ~30초 주기로 호출)부터 자동으로 후보에 들어간다.

> 갖고 있는 스프라이트 시트를 잘라 프레임을 만들 때는 `scripts/extract_pack_*.py`를 참고 예시로 쓸 수 있다(시트 크롭 좌표를 팩 규격 PNG로 변환).

### ROM에서 직접 립하기 (`scripts/rip_dwds_sprites.py`)

필요한 개체의 시트가 spriters-resource·spritedatabase 등 어디에도 없을 때(아무도 안 뜯었을 때) 쓰는 마지막 수단이다. Digimon World Dawn/Dusk의 NDS ROM에서 워터마크 없는 원본 그래픽을 직접 뽑아 위 [진화체 스프라이트](#진화체-스프라이트-adultperfectultimatesuperultimate) 흐름이 읽는 `sprites/sheets/dwds/<이름>.png`와 같은 자리에 편입할 수 있는 재료를 만든다.

**ROM도 ndstool도 이 레포에는 없다** — 사용자 본인이 소유한 ROM 덤프를 준비해서 로컬에만 둔다(레포에 커밋하지 않는다, 다운로드 금지). Tinke(Windows/.NET GUI)는 macOS에서 못 쓰므로 대신 `pip3 install ndspy pillow`로 설치되는 순수 Python 파서를 쓴다.

이 파이프라인의 원칙은 기존 `--contact` 관례와 동일하다 — **인덱스나 팔레트·셀 조합을 추측해서 확정하지 않는다.** ROM/그래픽 포맷의 바이트 구조(NDS FAT/FNT, Nitro G2D 헤더)는 스펙대로 정확히 파싱하지만, 어떤 그래픽·팔레트·셀이 같은 개체에 속하는지는 게임마다/팩마다 다를 수 있어 후보를 눈으로 골라야 한다.

1. **ROM에서 pak 3개 꺼내기.** `spr_chr.pak`(그래픽/NCGR), `spr_pal.pak`(팔레트/NCLR), `spr_cel.pak`(셀매핑/NCER) — ROM 안 정확한 경로는 리전/덤프마다 다르므로 추측하지 않고 조회한다.
   ```bash
   python3 scripts/rip_dwds_sprites.py list-rom ~/roms/dwds.nds --filter spr_
   python3 scripts/rip_dwds_sprites.py extract-rom ~/roms/dwds.nds <위에서 찾은 경로>/spr_chr.pak /tmp/spr_chr.pak
   # spr_pal.pak, spr_cel.pak도 같은 방식으로
   ```
2. **pak을 개별 그래픽 블록으로 분해.** 이 게임의 pak 컨테이너 자체는 공개 스펙이 없어 컨테이너 헤더를 추측하지 않는다 — 대신 pak 바이트를 훑어 Nitro G2D 매직(NCGR/NCLR/NCER, 자기 크기를 스스로 헤더에 적어 둔다)을 찾아 그 자리에서 정확히 잘라낸다.
   ```bash
   python3 scripts/rip_dwds_sprites.py split-pak /tmp/spr_chr.pak /tmp/chr_split
   python3 scripts/rip_dwds_sprites.py split-pak /tmp/spr_pal.pak /tmp/pal_split
   python3 scripts/rip_dwds_sprites.py split-pak /tmp/spr_cel.pak /tmp/cel_split
   ```
   각 `*_split/`에 `ncgr_0000.bin`, `nclr_0000.bin`, `ncer_0000.bin` ... 이 나온다. 세 pak의 항목 순서가 같은 개체를 가리킨다는 보장은 없다 — 다음 단계에서 사람이 확인한다.
3. **사람이 조합을 눈으로 고르는 지점.** `--contact`와 같은 형식(번호 붙은 스트립, 5칸마다 빨간 눈금)으로 후보를 렌더링한다.
   ```bash
   # 목표 인덱스 N 주변에서 팔레트만 바꿔가며 후보를 나열 (chr/cel은 N으로 고정)
   python3 scripts/rip_dwds_sprites.py contact /tmp/chr_split /tmp/pal_split /tmp/cel_split \
       --index N --vary palette --window 5 --out /tmp/contact-pal.png
   # chr/pal/cel 세 인덱스가 아예 안 맞을 수도 있으니, 셋을 같이 밀어보는 것도 확인
   python3 scripts/rip_dwds_sprites.py contact /tmp/chr_split /tmp/pal_split /tmp/cel_split \
       --index N --vary index --window 5 --out /tmp/contact-idx.png
   ```
   두 PNG를 눈으로 보고 실제로 그 개체처럼 보이는 조합의 인덱스를 고른다.
4. **확정한 조합을 최종 PNG로.**
   ```bash
   python3 scripts/rip_dwds_sprites.py render /tmp/chr_split/ncgr_00NN.bin /tmp/pal_split/nclr_00NN.bin \
       /tmp/cel_split/ncer_00NN.bin /tmp/out.png --cell 0
   ```
   `--cell`로 NCER 안의 다른 포즈(걷기 다른 프레임 등)를 시도해볼 수 있다.
5. **기존 흐름에 편입.** 나온 PNG(들)을 `sprites/sheets/dwds/<이름>.png`로 배치(기존 68장은 그대로 두고 신규 파일만 추가)하면, `scripts/extract_pack_evolved_dwds.py --contact <이름>`부터는 이미 있는 절차 그대로다.

ROM/pak이 없거나 예상한 위치에 없으면 각 서브커맨드는 (더미 출력 없이) 즉시 명확한 에러로 실패한다. `split-pak`이 블록을 하나도 못 찾으면 그 pak이 그래픽용이 아니거나 압축(LZ10/LZ11)돼 있다는 뜻이다 — 이 도구는 압축 해제를 추측하지 않는다.

### 진화체 스프라이트 (`adult`/`perfect`/`ultimate`/`superultimate`)

`scripts/extract_pack_<mon>.py`가 쓰는 Battle Spirit 시트에는 성장기(Rookie) 본인의 모션만 있고 진화체 프레임이 없다. 그래서 상위 3단계는 원래 "성장기가 강한 포즈를 취한 그림"으로 대체돼 있었고, 이름은 `pack.json`의 `stageNames`를 따라 그레이몬/메탈그레이몬/워그레이몬으로 표시되는데 도트는 아구몬인 불일치가 있었다.

`scripts/extract_pack_evolved_dwds.py`가 이 세 단계를 **Digimon World DS** 시트에서 다시 뽑는다 — DWDS에는 게임 내 모든 진화체의 필드(보행) 스프라이트가 32×32 언저리 크기로 들어있다.

1. 시트를 `sprites/sheets/dwds/<이름>.png`로 넣는다. 필요한 이름은 스크립트의 `PICKS` 표 참고(예: `greymon`, `metalgreymon`, `wargreymon`).
2. `python3 scripts/extract_pack_evolved_dwds.py [팩이름 ...]` — 인자를 생략하면 `PICKS`에 있는 9개 팩을 모두 처리한다.

프레임 위치는 손으로 좌표를 재지 않는다. 밴드를 시트 아래로 훑으면서 **그 밴드 안에서만** 지배적인 색(시트 배경색 + 셀 패널색)을 배경으로 잡아 분할하고, 크기가 고르고 등간격이며 밴드 경계에 잘리지 않은 작은 스프라이트가 가장 많이 나오는 밴드를 필드 스프라이트 행으로 고른다. 사람이 정한 값은 `PICKS`의 프레임 인덱스 2개(정면 포즈 — 행 안에서의 위치가 시트마다 다르다)뿐이다.

#### 초궁극체(`superultimate`) 도트

필요한 시트는 3개다. 시트 자체는 커밋되지 않으므로(위 규격 참고) `sprites/sheets/dwds/`에 아래 이름으로 넣어야 추출이 돌아간다.

| 파일명 | 형태 | 쓰는 팩 | 고른 프레임 |
|---|---|---|---|
| `omegamon.png` | 오메가몬 | 아구몬, 파피몬 (공유) | `[5, 6]` |
| `gallantmon_crimson.png` | 듀크몬 크림슨 모드 | 길몬 | `[3, 4]` |
| `imperialdramon_pm.png` | 황제드라몬 팔라딘 모드 | 브이몬 | `[6, 7]` |

아구몬·파피몬의 초궁극체는 둘 다 합체체인 오메가몬이라 같은 시트를 공유한다 — 계보상 사실이고 `pack.json`의 이름도 양쪽 다 오메가몬이다.

**임프몬에는 초궁극체가 없다.** 베르제브몬 블래스트 모드는 캐논에는 있지만 DWDS 시트에 없고(Dawn/Dusk 섹션에도 없다) 같은 계보에 대체할 형태도 없어서 `PICKS`·`pack.json` 모두 `superultimate` 항목을 비워뒀다.

#### 새로 추가한 라인 (전 단계를 DWDS에서)

캐논상 초궁극체는 많지만(수사노오몬·알파몬·샤인그레이몬 버스트 모드·루체몬 사탄 모드…) **DS 도트로 구할 수 있는 건 훨씬 적다.** 확인한 범위: spriters-resource의 DWDS 섹션(에셋 348개)에서 Ultra 등급은 아마게몬·크로노몬 홀리 모드·크로노몬 다크 모드 3종뿐이고, Dawn/Dusk 섹션은 성장기 위주의 부분 립이라 상위 단계가 없다. Lost Evolution·Super Xros Wars 시트는 spriters-resource·spritedatabase 어느 쪽에도 없고, Digimon 위키에 있는 건 카드/공식 일러스트와 디지바이스용 도트뿐이다. 그래서 상위 단계는 계속 DWDS 로스터가 상한이다.

그 3종 중 성장기부터 이어지는 계보가 있는 둘을 팩으로 만들었다. 두 팩 모두 Battle Spirit 시트가 없어 **`idle`·유년기·성장기까지 전 단계를 DWDS에서 뽑는다**(기존 팩은 성숙기 이상만 DWDS).

**케라몬 팩** — 디아블로몬 계보, 초궁극체는 아마게몬.

| 파일명 | 형태 | 단계 | 고른 프레임 |
|---|---|---|---|
| `kuramon.png` | 쿠라몬 | `baby` | `[3, 4]` |
| `keramon.png` | 케라몬 | `child`, `idle` | `[3, 4]` |
| `kurisarimon.png` | 크리사리몬 | `adult` | `[1, 2]` |
| `infermon.png` | 인퍼몬 | `perfect` | `[1, 2]` |
| `diaboromon.png` | 디아블로몬 | `ultimate` | `[3, 4]` |
| `armagemon.png` | 아마게몬 | `superultimate` | `[3, 4]` |

**팔코몬 팩** — 초궁극체는 크로노몬 홀리 모드(DWDS 최종 보스, 게임 안에서 Super Ultimate로 불린다).

| 파일명 | 형태 | 단계 | 고른 프레임 |
|---|---|---|---|
| `tokomon.png` | 토코몬 | `baby` | `[3, 4]` |
| `falcomon.png` | 팔코몬 | `child`, `idle` | `[3, 4]` |
| `peckmon.png` | 펙크몬 | `adult` | `[0, 1]` |
| `yatagaramon.png` | 야타가라몬 | `perfect` | `[0, 1]` |
| `varodurumon.png` | 발두르몬 | `ultimate` | `[0, 1]` |
| `chronomon_hm.png` | 크로노몬 홀리 모드 | `superultimate` | `[6, 7]` |

유년기는 게임 진화표대로 토코몬이다(캐논 유년기 피나몬은 DWDS에 없다). 펙크몬·야타가라몬·발두르몬 시트는 필드 프레임 행이 3칸뿐이라 고를 수 있는 쌍이 `[0, 1]` 하나다.

`idle`은 스테이지 이름이 그대로 파일 prefix라서 `PICKS`에 한 줄 적으면 나온다 — 관례대로 성장기와 같은 프레임을 쓴다. 원본이 32px보다 큰 프레임(디아블로몬·아마게몬·크로노몬 등)은 축소되므로 픽셀이 1:1로 유지되지 않는다 — 실행 시 출력되는 그 목록이 [`large-<stage>`](#큰-화면용-도트-3종)를 따로 떠야 할 대상이다.

로테이션 후보는 이로써 아구몬·팔코몬·파피몬·길몬·케라몬·브이몬 6개다.

한글 이름은 [Wikimon](https://wikimon.net)의 한국어(한국어) 표기를 따른다 — 직역과 다른 것들이 있다: GeoGreymon = **지오**그레이몬, Peckmon = **펙크몬**, Varodurumon = **발두르몬**, Armagemon = **아마게몬**, Flamedramon = **화염드라몬**, Magnamon = **매그너몬**, Imperialdramon = **황제드라몬**.

#### 분기 도트 시트

랜덤 진화의 대체 노드용 시트다. 파일명은 `PICKS`/`pack.json`의 `sprite` 값과 짝을 이룬다.

| 파일명 | 형태 | 쓰는 노드 | 고른 프레임 |
|---|---|---|---|
| `geogreymon.png` | 지오그레이몬 | 아구몬 `adult-geogreymon` | `[0, 1]` |
| `rizegreymon.png` | 라이즈그레이몬 | 아구몬 `perfect-rizegreymon` | `[0, 1]` |
| `blackwargreymon.png` | 블랙워그레이몬 | 아구몬 `ultimate-blackwargreymon` | `[0, 1]` |
| `darkdramon.png` | 다크드라몬 | 파피몬 `ultimate-darkdramon` | `[5, 6]` |
| `blackwargrowlmon.png` | 블랙메가로그라우몬 | 길몬 `perfect-blackmegalogrowlmon` | `[4, 5]` |
| `flamedramon.png` | 화염드라몬 | 브이몬 `perfect-flamedramon` | `[3, 4]` |
| `magnamon.png` | 매그너몬 | 브이몬 `perfect-magnamon` | `[4, 5]` |
| `imperialdramon_dm.png` | 황제드라몬 드래곤 모드 | 브이몬 `ultimate-imperialdramon_dm` | `[4, 5]` |
| `beelzemon.png` | 베르제브몬 | 케라몬 `ultimate-beelzebumon` | `[4, 5]` |

분기는 전부 [DWDS 진화표](https://digimon.neoseeker.com/wiki/Digimon_World_DS_Digivolution_Guide)에 있는 실제 진화 경로다 — 임의로 붙인 조합이 아니다. 게임 표에서 확인한 것 둘: 베르제브몬은 임프몬이 아니라 **인퍼몬(케라몬 라인)** 분기이고, 팔코몬의 유년기는 **토코몬**이다.

블랙워그레이몬 시트는 필드 프레임 행이 3칸뿐이고 감지된 행이 뒷모습이라 도트가 등을 보인다 — 다른 행이 잡히면 교체 여지가 있다.

프레임 인덱스는 눈으로 고른다. 추측하지 않도록 대조용 스트립을 뽑는 모드가 있다 — 새 팩·새 단계를 채울 때도 같은 절차를 쓴다:

```bash
# 감지된 필드 프레임 전체를 인덱스 순서로 한 줄에 나열 (0, 5, 10... 아래 빨간 눈금)
python3 scripts/extract_pack_evolved_dwds.py --contact omegamon /tmp/omegamon-frames.png
# 정면 포즈 2개의 인덱스를 PICKS에 써넣고
python3 scripts/extract_pack_evolved_dwds.py agumon gabumon
```

세 시트 모두 뒤돌아 걷는 프레임이 앞쪽, 정면으로 걷는 프레임이 뒤쪽에 온다 — 고른 쌍이 전부 행의 뒤쪽인 이유다.

시트가 없거나 인덱스가 `PENDING`인 단계는 실행을 멈추지 않고 건너뛴다(예전에는 `FileNotFoundError`로 전체가 죽었다). 그 상태에서는 해당 단계가 `ultimate` 프레임을 물려받아 라벨만 초궁극체로 뜬다.

`feat/portrait-cutin`의 `scripts/extract_portraits_dwds.py`에도 같은 시트 이름을 `PACK_SHEETS`에 추가해야 `portrait-superultimate-*.png`가 나온다.

한계: 임프몬 라인의 스컬사탄몬은 DWDS에 없어 완전체를 뱀파이몬으로 대체했다(`sprites/packs/impmon/pack.json`의 이름도 그에 맞춰져 있다). 원본이 32px보다 큰 프레임은 축소되므로 픽셀이 1:1로 유지되지 않는다 — 실행 시 해당 파일 목록을 출력하고, 그 목록이 [`large-<stage>`](#큰-화면용-도트-3종) 대상이다(108프레임 중 75개).

### 큰 화면용 도트 3종

**도트는 표시 크기별로 3벌을 따로 딴다.** 한 벌을 돌려쓰면 어느 한쪽이 반드시 망가진다 — 32px로 줄인 도트에는 되돌릴 픽셀이 남아 있지 않고, 원본 해상도 그림을 16pt에 밀어넣으면 실루엣만 남는다.

| 종류 | 파일명 | 크기 | 쓰이는 곳 |
|---|---|---|---|
| ① 메뉴바 도트 | `<stage>-0/1.png` | 32×32 고정 | 메뉴바 아이콘 16pt (retina 1:1) |
| ② 원본 필드 도트 | `large-<stage>-0/1.png` | 원본 crop 그대로 (~18×27 ~ 46×41) | ③이 없는 단계의 큰 화면 |
| ③ 배틀 포즈 초상 | `portrait-<stage>-0/1.png` | 원본 crop 그대로 (56×92 ~ 134×204) | [드롭다운 헤더](#드롭다운)·[진화 컷인](#진화-연출-메뉴바-앱) |

`<stage>`는 프레임 prefix와 1:1이므로 **분기 노드도 각자 필요하다** — `ultimate-beelzebumon`이면 `large-ultimate-beelzebumon-0.png` / `portrait-ultimate-beelzebumon-0.png`다. 앱도 같은 규칙으로 읽는다: 오늘 루트가 분기를 가리키면 `portrait-<분기 prefix>`를 찾고, **없어도 spine 초상으로 대체하지 않는다** — 메뉴바에는 블랙워그레이몬이 있는데 드롭다운에는 워그레이몬이 뜨는 것보다, 실제로 표시 중인 32px 도트를 확대하는 편이 낫다.

큰 화면(208pt 정사각 박스)을 그릴 때 앱은 위에서부터 있는 것을 고른다: **`portrait-*` → `large-*` → ①의 정수배 확대(최후 폴백)**. 셋 중 ①만 필수이고, 하나도 없어도 컷인과 드롭다운 헤더는 동작한다.

> 현재 구현 상태: ①과 ③만 있다. `large-*` 저장(`extract_pack_evolved_dwds.py`)과 폴백 순서의 가운데 칸(`portraitImage(forStage:)`)은 아직 없다 — ②는 후속 작업이고, 지금은 `portrait-*` → 정수배 확대 두 단계로 동작한다.

#### 왜 3종인가

메뉴바 두께는 macOS 제약이라 못 키우므로 ①은 32px에 묶여 있다. 성장기까지는 실루엣으로도 구분되지만 완전체·궁극체처럼 장식과 무기가 많은 형태는 16pt에서 뭉개져 어떤 몬인지 알 수 없다. 그래서 아이콘을 누르면 큰 그림을 보여주는데, 여기서 ①을 확대하면 두 가지 문제가 겹쳐 "깨져 보인다".

1. **비정수 축소가 픽셀을 날린다.** DWDS 필드 프레임은 대체로 32px보다 조금 크다 — 현재 `PICKS`가 뽑는 108프레임 중 **75프레임**이 그렇고 긴 변 중앙값이 36px다. `to_sprite`는 이걸 `Image.NEAREST`로 32px에 맞춰 줄이므로 9번째 행 같은 것이 통째로 빠진다(윤곽선이 끊기고 눈이 비대칭이 된다). 그 결과를 5배로 키우면 빠진 줄이 5px 폭의 흠으로 확대된다. ②는 **줄이기 전 crop을 그대로 남겨** 이 부류를 없앤다.
2. **해상도 자체가 모자라다.** ②를 남겨도 36px는 32px의 1.1배다. 208pt 박스에서 5배 확대라는 사실은 변하지 않는다. 형태를 실제로 읽히게 만드는 건 픽셀이 3~5배 많은 ③뿐이다 — **②는 ③이 없는 단계의 차선책이고, ③의 대체가 아니다.**

#### ③의 커버리지

`portrait-*`는 원래 spine 4단계(`adult`/`perfect`/`ultimate`/`superultimate`)에만 있었다. [랜덤 진화](#랜덤-진화-분기-루트)는 매일 루트를 다시 뽑으므로 분기가 3개인 팩은 대부분의 날을 spine이 아닌 형태로 보내는데, 그 형태들에는 초상이 하나도 없어 아이콘을 눌러도 뻥튀긴 32px가 나왔다 — 큰 화면이 "종종" 깨져 보이던 경로가 이것이다. 지금은 **`pack.json` 트리에 있는 모든 분기 노드**가 자기 초상을 갖는다 (53쌍 / 51시트).

남은 폴백 구간과 그 이유:

| 단계 | 상태 |
|---|---|
| `child` | 케라몬·팔코몬·가오몬만 있다. 나머지 7팩은 성장기를 Battle Spirit gif(`scripts/extract_pack_<mon>.py`)에서 뽑는데, 시트 배치가 달라 이 스크립트가 읽지 못한다 |
| `baby` | **불가능.** DWDS의 유아기(쿠라몬·토코몬·와냐몬)에는 배틀 포즈가 없고 ~43×39 필드 애니메이션뿐이다. 원본이 이미 32px급이라 ② 대상이지 ③ 대상이 아니다 |
| `digitama` | 종족 무관 공용 알이라 초상을 두지 않는다 |
| `limit80` / `limit95` | 현재 형태의 기분 오버라이드다. 별도 종이 아니므로 초상을 따로 두지 않는다 |
| 가오몬 `superultimate` | 미라지가오가몬 버스트 모드 시트가 워터마크 리핑이라 포즈 검출이 아예 실패한다 (도트도 같은 이유로 없다) |

새 팩·새 분기를 넣을 때는 ①과 **같은 prefix까지 ③을 함께** 뽑는 것이 기본이고, 시트에 쓸 만한 배틀 포즈가 없을 때만 ②로 대신한다.

#### 공통 규칙

- **한 prefix의 두 프레임은 캔버스 크기가 반드시 같아야 한다.** 다르면 프레임이 교대될 때 스프라이트가 튄다. 추출 스크립트는 두 포즈의 union bbox로 패딩해 맞춘다.
- ②·③은 **32px로 줄이지 않는다.** 표시 크기는 앱이 정하고, `-1` 프레임은 선택이다(없으면 정지 이미지).
- ②는 원본이 32px 이하인 프레임에는 만들지 않는다 — ①과 내용이 같아 파일만 늘어난다. `extract_pack_evolved_dwds.py`가 실행 끝에 축소한 프레임 목록을 출력하므로, **그 목록이 곧 ② 대상 목록**이다.
- `portraitBox`(현재 208pt)보다 큰 에셋을 추가하면 `menubar/claudemon-menubar.swift`의 상수를 다시 재야 한다. 박스가 그림보다 작으면 `drawAspectFit`이 **정수 배율을 못 쓰고 분수로 축소**해(축소 쪽은 `floor`하면 0이 되므로 그대로 둔다) 되살리려던 픽셀을 도로 뭉갠다. 분기 초상을 추가하면서 기준이 keramon `portrait-superultimate`(183×154) → agumon `portrait-perfect-rizegreymon`(134×204)으로 옮겨가 184 → 208이 됐다.
- 앱은 확대·드로잉 전 구간에서 `imageInterpolation = .none`을 강제하고 확대 배율은 `floor`한 정수만 쓴다. 앞이 빠지면 픽셀아트가 뿌옇게 뭉개지고, 뒤가 빠지면 픽셀 폭이 들쭉날쭉해진다.

#### 추출

②는 ①과 같은 하단 필드 스프라이트에서, ③은 같은 시트의 **상단 배틀 포즈**에서 뽑는다. 시트 준비 방법은 위 절과 동일하고, 어떤 prefix가 어떤 시트에서 나오는지는 `PACK_SHEETS`에 있다(`PICKS`와 같은 시트 이름을 쓰되 프레임 인덱스는 공유하지 않는다 — 그쪽은 필드 행 기준이다).

```bash
python3 scripts/extract_portraits_dwds.py [팩이름 ...]

# 프레임 후보를 눈으로 고를 때: 검출된 포즈를 인덱스와 함께 한 줄로 깐다
python3 scripts/extract_portraits_dwds.py --contact greymon /tmp/greymon-poses.png
```

배경색은 시트 가장자리 샘플링으로 검출한다 — 전역 dominant color를 쓰면 캐릭터 외곽선 회색이 배경으로 오검출된다. 포즈 행은 y-range가 실제로 겹칠 때만 같은 행으로 묶는다(행간이 9~14px인 시트가 있어 gap을 허용하면 두 행이 병합된다). 크레딧 텍스트·로고는 "행당 포즈 2개 이상" 조건으로 걸러진다.

2프레임 자동 선택은 51시트 중 **20시트**에서 손을 봐야 했고, 그 인덱스는 `POSE_OVERRIDES`에 육안 확인해 적어뒀다. 실패는 두 종류뿐이다 — ① ±15% 크기 검사를 넘겨 프레임 1을 아예 못 찾거나(어차피 union bbox로 패딩하므로 크기 차이는 실제로는 안 보인다), ② 포즈가 한 행에 다 깔린 시트에서 "다른 행 우선" 규칙이 무력해져 옆칸 호흡 프레임을 집는 경우. `--contact`가 뽑는 스트립에서 인덱스를 읽어 두 개를 적으면 된다(빨강/파랑 라벨이 행 경계다).

시트가 없거나 배틀 포즈가 하나도 없는 단계는 실행을 멈추지 않고 건너뛴 뒤 끝에 목록을 출력한다 — 유아기가 늘 여기 걸린다.

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

첫 항목은 텍스트가 아니라 커스텀 뷰 헤더다 — [큰 화면용 도트](#큰-화면용-도트-3종) 208pt + 이름 + 단계 + 오늘 토큰. 진화 컷인을 놓쳐도 아이콘을 눌러 언제든 지금 형태를 크게 볼 수 있다.

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
