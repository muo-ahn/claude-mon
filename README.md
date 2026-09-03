# ClaudeMon (프로토타입)

> **도트 이미지가 레포에 포함된다.** 클론 직후 `node scripts/materialize-sprites.js --write` 한 번이면 팩이 채워진다 — 아래 [스프라이트 팩](#스프라이트-팩-spritespacks) 참고. 도트의 출처와 저작권은 [에셋 출처](#에셋-출처)를 읽어라.

그날 사용한 토큰량에 따라 성장·진화하는 Claude Code 마스코트. statusline과 macOS 메뉴바 앱 두 곳에서 렌더링된다. 스프라이트는 팩(pack) 단위로 교체·확장할 수 있다.

## 설치

### 요구 사항

- **Node.js** (LTS 권장) — `hook.js`, `statusline.js`, `daily-tokens.js` 실행용. 외부 의존성 없이 stdlib만 쓰므로 `npm install`은 필요 없다.
- **macOS + Swift 툴체인** — 메뉴바 앱을 쓸 경우에만. Xcode 또는 Command Line Tools(`xcode-select --install`)에 포함된 `swiftc`가 필요하다. statusline만 쓸 거라면 생략 가능하다.
- **스프라이트 도트 이미지** — 레포에 포함된다(`sprites/nodes/`). 별도 준비 없이 [클론](#1-클론) 단계의 materialize 명령만 실행하면 된다.

### 1. 클론

```bash
git clone https://github.com/muo-ahn/claude-mon.git
cd claude-mon
node scripts/materialize-sprites.js --write
```

마지막 줄이 정본 도트(`sprites/nodes/`)를 각 팩 디렉터리로 복사한다. 메뉴바와 statusline이 실제로 읽는 것은 `sprites/packs/<pack>/<노드 id>-N.png`이므로, 이 단계를 건너뛰면 프레임이 없어 한 단계 아래로 폴백한다. 복사본은 `.gitignore`가 차단하므로 커밋되지 않는다.

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
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "node /절대/경로/claude-mon/hook.js tool-failure" }] }
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
- 실패한 도구 호출도 세고 싶으면 `PostToolUseFailure`에 `hook.js tool-failure` 훅을 등록한다(`PostToolUse`가 아니다 — Claude Code는 도구 호출 성공에만 `PostToolUse`를 발화하고, 실패는 별도 이벤트 `PostToolUseFailure`로 보낸다. `PostToolUse`에 걸면 성공할 때마다 실패로 집계된다). 블랙 계열 진화(`failureRatioPct` 게이트)가 이 값에 의존하므로 위 설치 스니펫에 기본 포함했다.
- 새 세션부터 적용된다. 등록 후 Claude Code 세션을 새로 열면 statusline에 마스코트가 나타난다.

### 3. (선택) 메뉴바 앱 빌드 — macOS

statusline 대신/과 함께 메뉴바에 애니메이션 마스코트를 띄우려면 앱을 직접 빌드한다:

```bash
./menubar/build-app.sh          # ~/Applications/Claudemon.app 생성
open -a ~/Applications/Claudemon.app --args "$PWD/sprites"
```

빌드 스크립트는 아이콘(`.icns`) 생성 → 컴파일 → 번들 조립 → ad-hoc 서명 → LaunchServices 등록까지 한다. 설치 위치는 `CLAUDEMON_INSTALL_DIR`로 바꿀 수 있다.

- **왜 `.app` 번들인가.** macOS는 알림의 발신 앱 이름과 좌측 아이콘을 *배너를 올린 앱 번들*에서 가져온다. 번들이 없으면 알림을 kitty를 거쳐 쏘는 수밖에 없고, 그러면 모든 배너가 "kitty" 이름과 kitty 아이콘으로 찍힌다. [데스크톱 알림](#데스크톱-알림) 참고.
- **번들은 반드시 `~/Applications` 같은 정식 위치여야 한다.** 실측(macOS 26): `/private/tmp` 같은 임시 위치나 레포 안에서 실행하면 `UNUserNotificationCenter`가 권한 요청을 다이얼로그도 없이 `UNErrorDomain Code=1`로 즉시 거부한다.
- 맨 실행파일로 띄우고 싶으면 `swiftc -O -o menubar/claudemon-menubar menubar/claudemon-menubar.swift` 로도 여전히 동작한다. 마스코트·메뉴는 정상이고 알림만 앱 경로를 못 쓴다.
- 빌드 산출물(`menubar/claudemon-menubar`, `menubar/Claudemon.icns`)은 `.gitignore`로 제외되어 있으므로 각자 빌드해야 한다.
- 앱은 accessory(백그라운드 상주) 모드로 뜨며 Dock 아이콘 없이 메뉴바에만 나타난다. `active-session.sh`로 현재 포커스된 세션을 추적하고, 30초마다 `daily-tokens.js`를 호출해 토큰 집계를 갱신한다.
- 로그인 시 자동 실행은 아래 [LaunchAgent 등록](#로그인-시-자동-실행-launchagent) 참고.
- 팩 디렉터리가 비어 있으면 표시가 비거나 fallback되므로, [클론](#1-클론) 단계의 `node scripts/materialize-sprites.js --write`를 먼저 실행한다.

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
		<string><홈>/Applications/Claudemon.app/Contents/MacOS/claudemon-menubar</string>
		<string><레포>/sprites</string>
		<string>--no-cutin</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CLAUDEMON_PROJECT_ROOT</key>
		<string><레포></string>
	</dict>
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
- `CLAUDEMON_PROJECT_ROOT`는 번들로 실행할 때 **필수**다. 앱은 `projectRoot`를 `실행파일디렉터리/..`로 파생하는데, 번들에서는 그게 `Contents/`를 가리켜 `daily-tokens.js`를 찾지 못하고 토큰 집계가 조용히 멈춘다.
- 스프라이트 경로는 번들이 아니라 **레포**를 가리키게 둔다. 스프라이트를 고칠 때 앱을 재빌드하지 않아도 되고, worktree에서 빌드했더라도 그 worktree가 사라져도 앱이 안 깨진다.

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

Node 내장 러너만 쓴다 (의존성 없음, `package.json`도 없다). 현재 커버 범위는 `lib/daily.js`의 몬 로테이션 — 팩 유효성(`listValidPacks`), 로테이션 후보 판정(`listRotationPacks`), 해시 분산(`hashString`), 셔플 덱 로테이션(`selectMon` — 사이클 내 1회씩 배치·멱등·에폭 이전 음수 `dayIndex`·풀 크기 변경·N배수 일수 분포 균등성)과 연속 중복 방지(`prevMon` 가드), 분기 루트 추첨(`selectRoute` — 하루 고정·조건 게이트·lazy binding), 전역 그래프 검증(`validateGraph` — 역인덱스 구성·종점 파생·골든 스냅샷 동등성), 몬 등장 이력(`mon-history.json` — append/제자리 갱신/쓰기 생략/60개 트림/degrade) — 과 조건 엔진(`lib/evolve.js`의 `checkCondition`/`conditionMet` — 조건 타입 전체 + `all` 합성), 그리고 토큰 집계(transcript 신원 dedupe, 서브에이전트 합산, 단계 임계값)다. 실제로 났던 버그를 재현하는 테스트들이라, 각 방어 장치를 하나씩 되돌리면 대응하는 테스트가 실패하는 것까지 확인했다.

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
- **최상위 단계에 도달하지 못하는 팩은 로테이션 후보에서 빠진다 — 단, 계보가 그보다 아래에서 끝나는 종점 라인은 예외다(D7).** 전역 그래프(`evolution-graph.json`)에서 종점은 "다음 칸의 노드 중 나를 부모(`evolvesFrom`)로 지목한 것이 없음"으로 파생된다. 종점에 닿은 라인은 그 스테이지에서 머무는 것 자체가 "도달"이라 로테이션에서 빠지지 않는다.
- `errorRatePct`/`consecutiveDaysActive`/`milestone`/`toolSuccessCount`/`globalToolSuccessCount` 조건 타입은 커스텀 팩 호환을 위해 `lib/evolve.js`에 남아있지만 기본 `evolution-tree.json`에서는 `dailyOutputTokens`만 사용한다.
- `evolution-tree.json`의 `regression` 블록은 제거되었다 — 일일 리셋 자체가 퇴화 역할을 대신한다.

## 데스크톱 알림

터미널이 앞에 없을 때 "네 차례" 를 알리는 배너다. 마스코트 상태(메뉴바 아이콘·진화 컷인)와는 완전히 별개다.

| 이벤트 | 문구 | urgency |
|---|---|---|
| 권한 프롬프트 / 입력 대기 | 입력 대기 | `critical` |
| 위임한 작업 완료 | 작업 완료 | `normal` |
| 턴 종료 (30초 이상 걸린 턴만) | 턴 종료 | `normal` |

짧은 턴은 사용자가 지켜보고 있었을 가능성이 크므로 배너를 쏘지 않는다 (`CLAUDEMON_NOTIFY_MIN_TURN_MS`, 기본 30000). 입력 대기는 이 문턱을 무시한다. 전체를 끄려면 `CLAUDEMON_NOTIFY=0`.

### 3단 전달 경로

`lib/notify.js`가 위에서부터 시도하고, 실패하면 다음으로 내려간다.

| 순위 | 경로 | 조건 |
|---|---|---|
| 1 | **Claudemon.app** — 파일드롭 큐 → `UNUserNotificationCenter` | 앱이 살아 있고(하트비트 10초 이내) 알림 권한이 있을 때 |
| 2 | **kitty OSC 99** 이스케이프 시퀀스 | 클라이언트가 kitty이고, tmux 안이면 `allow-passthrough`가 on/all일 때 |
| 3 | **사운드** (`afplay`, critical은 Sosumi) | 위 둘이 모두 안 될 때 |

1번을 최우선으로 두는 이유는 아이콘만이 아니다. 앱 경로는 터미널을 방정식에서 지우고(Ghostty·Terminal.app·맨 tty 모두 동작), 권한이 실제로 켜져 있는지를 **보고할 수 있다** — 이스케이프 시퀀스 경로는 그걸 알 방법이 없다.

- **큐**: `$CLAUDEMON_DIR/notify-queue/<epoch ms>-<seq>-<pid>-<rand>.json`. `.tmp`로 쓴 뒤 rename한다(앱이 0.5초마다 폴링하므로 반쯤 쓰인 파일을 읽을 수 있다). 앱은 `.json`만 집어가고, 파일명 정렬로 도착 순서를 얻는다. 60초보다 오래된 요청은 버린다 — 앱이 내려가 있던 사이의 "입력 대기" 를 지금 띄우는 것은 정보가 아니라 노이즈다.
- **하트비트**: `$CLAUDEMON_DIR/menubar-alive.json`. 앱이 2초마다 pid·시각·권한 상태를 쓴다. 앱이 살아 있어도 권한이 없으면 배너가 안 뜨므로 `notify.js`는 두 조건을 함께 본다.
- **권한 상태는 메뉴에 노출된다** (`알림 권한: 허용됨 / 거부됨 / 미결정`). 권한이 조용히 꺼져 있는 것이 이 기능의 가장 흔한 고장이다.

### 알림이 안 뜰 때

1. **메뉴바 메뉴에서 `알림 권한`** 을 본다. `거부됨`이면 시스템 설정 → 알림 → Claudemon에서 켠다.
2. **첫 실행의 권한 요청 결과는 신뢰할 수 없다.** 실측(macOS 26): 권한 다이얼로그가 떠 있는 동안 `requestAuthorization` 콜백이 `UNErrorDomain Code=1`로 먼저 반환되고, 그 뒤 허용을 누르면 권한은 정상 기록된다. 즉 **첫 실행에서 허용을 눌렀는데 안 되면 앱을 한 번 재시작**하면 된다. 앱이 콜백 대신 `getNotificationSettings` 폴링으로 상태를 판정하는 이유가 이것이다.
3. **tmux + kitty로 2번 경로를 쓰는 경우** `allow-passthrough`가 켜져 있어야 한다. tmux는 모르는 이스케이프 시퀀스를 DCS passthrough 봉투에 담아야만 통과시키고, off면 시퀀스를 조용히 삼킨다.
   ```bash
   tmux show-options -gv allow-passthrough   # on 또는 all 이어야 한다
   echo 'set -g allow-passthrough on' >> ~/.tmux.conf
   ```
4. **1·2번 경로가 다 막혔는데 소리도 안 나면** `CLAUDEMON_NOTIFY=0`이 걸려 있는지 본다.

## 진화 연출 (메뉴바 앱)

단계가 오르는 순간은 하루 최대 5번뿐인데, 16pt 아이콘 안에서 조용히 바뀌면 사실상 관측되지 않는다. 그래서 메뉴바 앱은 두 곳에서 동시에 연출한다.

| 위치 | 내용 |
|---|---|
| 메뉴바 아이콘 | 흰 실루엣이 old ↔ new 형태를 오가는 디지볼브 (~4.5초) |
| 화면 우상단 코너 | borderless 오버레이 창에 [큰 화면용 도트](#큰-화면용-도트-3종) 208pt + "`<이름>` 진화!" 라벨 (~3.5초) |

컷인 창은 클릭을 통과시키고(`ignoresMouseEvents`) 모든 스페이스·전체화면 위에 뜬다. 진화 연출에는 macOS 알림을 쓰지 않는다 — 알림은 [별도 경로](#데스크톱-알림)이고 용도가 다르다(자리를 비운 사이의 "네 차례" 신호).

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

**도트 이미지가 레포에 들어있다.** 커밋되는 것은 정본뿐이다 — 전역 그래프 노드 도트 `sprites/nodes/`(750장), 공용 알 `sprites/shared/`, 그리고 `sprites/nodes/`로 재생성할 수 없는 팩 전용 도트(`pack.json`의 레거시 `tree`가 쓰는 스테이지 프레임, `idle-*`/`limit80-*`/`limit95-*` 오버라이드, `portrait-*` 컷인).

`sprites/packs/` 안의 나머지 `<노드 id>-N.png`는 `scripts/materialize-sprites.js`가 `sprites/nodes/`에서 복사한 산출물이라 커밋하지 않는다(`.gitignore`가 `*.png`/`*.gif`를 차단하고 `sprites/nodes/`·`sprites/shared/`만 예외로 뺀다). 노드 id와 팩 역할 이름이 접두를 공유하기 때문에(예: 노드 id `ultimate-chaosdukemon`) glob으로는 둘을 가를 수 없다 — 그래서 **팩 전용 도트를 새로 추가할 때는 `git add -f`가 필요하다.** 이미 추적 중인 파일은 영향을 받지 않는다.

ROM 립 원본 시트(`sprites/sheets/`)도 커밋하지 않는다. 자작 픽셀아트나 별도 라이선스 에셋으로 팩을 갈아끼우고 싶다면 아래 규격만 맞추면 된다.

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

`listValidPacks`(팩이 로드 가능한가)와 `listRotationPacks`(오늘의 몬으로 뽑을 후보인가)는 다른 질문이다. 후자는 전자에 조건 하나를 더 얹는다 — 다음 둘 중 하나를 만족해야 한다.

1. **전역 그래프에 로키 노드가 있는 팩** — `evolution-graph.json`의 `byId`에 팩 디렉터리 이름과 같은 `id`를 가진 child-stage 노드가 있으면 된다. 그 노드에서 역방향으로 `evolvesFrom`을 따라 digitama까지 도달하거나, 전방으로 최상위 또는 종점까지 도달하면 로테이션 후보다.
2. **레거시 팩(그래프에 없는 경우)** — `pack.json`의 `stageNames`에 전역 최상위 단계(현재 `superultimate`)의 이름이 있어야 한다. 그래프에 없이 `stageNames`만으로 동작하던 예전 방식 그대로다.

그래프에 로키 노드도 없고 `stageNames` 최상위 이름도 없는 팩은 로테이션에 들지 않는다 — 이것이 커스텀 팩 저작의 공개 계약이다.

- **(D7, 2026-08-19)** 예전에는 "최상위 단계까지 진화하지 못하는 계보는 로테이션에서 뺀다"는 조건이 전역 최상위(`superultimate`) 도달을 뜻했다. 정사에서 초궁극체를 가진 계보는 소수라 이 조건이 편입 가능한 갈래를 구조적으로 제한했다(가오몬·레나몬처럼 분기가 0개인 팩이 그 결과다). D7이 그 계약을 완화해 궁극체 이하 종점도 인정했고, Phase B(2026-08-20)에서 전역 그래프로 전환하면서 종점 판정이 `terminal: true` 플래그에서 **"다음 칸에서 나를 부모로 지목한 노드가 없음"**(역인덱스 `childrenOf`에서 파생)으로 바뀌었다. 종점에 닿은 라인은 로테이션 자격을 그대로 유지한다. 근거와 기각된 대안은 `docs/evolution-routes.md` §8 D7, `docs/global-graph-plan.md` §B-1 참고.
- 후보에서 빠져도 팩 자체는 유효하다 — 명시적으로 지정하거나 `guilmon` 폴백으로 걸리면 그대로 렌더된다.
- **가오몬이 D7로 로테이션에 복귀했다.** 미라지가오가몬 궁극체 노드가 종점으로 판정된다("다음 칸에 나를 부모로 지목한 노드가 없음" — 초궁극체 시트가 photobucket 워터마크 리핑이라 여전히 확보 못한 상태). 화면에서는 `stageId`가 그 스테이지 위로 올라가지 않고(clamp, `lib/daily.js:1158-1162`), `daily.json`의 `terminalFrom`이 라인이 끝난 지점을 알린다.
- **부수효과: 로테이션 풀 크기가 9 → 10으로 바뀐다.** 셔플 덱의 시드가 `hashString(\`${cycle}|${N}\`)`이라(아래 [매일 랜덤 몬 선택](#매일-랜덤-몬-선택-libdailyjs) 참고) N이 바뀌면 향후 모든 사이클이 재셔플된다 — 설계된 동작이지만 사용자 체감은 로테이션 순서 전면 변경이다.
- 후보가 늘어나는 만큼 반대 방향도 열려 있다: 초궁극체까지 이어지는 계보를 새로 추가하면 그대로 후보가 된다. 케라몬 팩(→ 아마게몬)과 팔코몬 팩(→ 크로노몬 홀리 모드)이 그렇게 들어왔다.

### 랜덤 진화 (분기 루트)

디지몬은 같은 종족이라도 성장 배경에 따라 다른 형태로 진화한다. claudemon도 하루 단위로 **루트**를 뽑는다 — 오늘의 마스코트는 (팩, 루트) 쌍이다.

**전역 진화 그래프는 `evolution-graph.json`에 있다.** 전체 노드(314개, 2026-08-20 Wikimon `Digimon Story` 오버월드 립 235종 편입 이후)가 단일 배열에 있고, 각 노드는 `{ id, name, stage, sprite, evolvesFrom: [{from, when}] }`다. **관계를 자식이 소유한다** — 부모가 `evolutions`로 내보내지 않고, 자식이 `evolvesFrom`으로 부모 목록을 받는다. `sprite`가 그대로 파일 prefix라서(노드 `id`가 prefix다) 프레임은 `sprites/nodes/<id>-0.png` 또는 `scripts/materialize-sprites.js`가 팩 디렉터리로 복사한 `<pack>/<id>-0.png`에서 읽는다.

**`evolvesFrom`은 부모별로 조건을 갖는다.**

```json
{
  "id": "beelzebumon", "name": "베르제브몬", "stage": "ultimate", "sprite": "beelzebumon",
  "evolvesFrom": [
    { "from": "myotismon", "when": null },
    { "from": "mummymon",  "when": { "type": "topSharePct", "gte": 60 } },
    { "from": "infermon",  "when": null }
  ]
}
```

런타임(`lib/daily.js`)은 로드 시 **역인덱스 `childrenOf: 부모 id → [{ node, when }]`** 를 구성한다. 다음 칸 후보는 "현재 노드를 `evolvesFrom`의 부모로 지목한 노드들"이다(파생).

- **조건 게이트.** 역인덱스 배열을 순서대로 검사해 조건(`when`)을 만족하는 첫 엣지의 조건 그룹을 승자로 삼는다. 같은 조건 그룹 안에서 후보가 여럿이면 `hashString(dateKST|rookie|stage)` 타이브레이크로 결정적으로 하나를 고른다.
- **`when: null`은 무조건 엣지다.** 조건을 만족한 엣지가 없으면 전체 후보로 폴백한다 — 나를 부모로 지목한 노드가 1개 이상이면 반드시 진화한다. 이것이 도달 보장이다.
- **종점 판정은 파생된다.** "다음 칸에 나를 부모로 지목한 노드가 없음"(`childrenOf`에 없거나 빈 배열)이 종점이다. 플래그가 필요 없다.
- **순서 = 우선순위.** `evolution-graph.json`의 **노드 배열 순서**가 분기 우선순위 정본이다. 역인덱스 구성 시 조건부 엣지(`when !== null`)를 무조건 엣지보다 앞으로 안정 정렬해, 무조건 엣지가 항상 조건을 충족해 조건부 분기를 죽이는 것을 막는다(자세한 이유는 `docs/global-graph-plan.md` 결정 1번).
- **종점 도달 시 화면 표시.** `route`의 종점 이후 칸은 같은 종점 노드로 채워지지만, `daily.json`의 `stageId`는 그 스테이지 위로 올라가지 않는다(clamp). `terminalFrom: "<stageId>"`가 라인이 끝난 지점을 알려준다.
- **`when`이 지원하는 조건 타입** (`lib/evolve.js` `checkCondition`): `sessionCount`(그날 세션 수, `gte`), `topSharePct`(최다 세션이 그날 output에서 차지하는 %, `gte`/`lte`), `failureRatioPct`(`global.json`의 **누적** 도구 실패율 %, `gte`/`lte` — 일일 값이 아니다), `dailyOutputTokens`, 기타. 여러 조건을 한꺼번에 걸려면 `"when": { "all": [ {...}, {...} ] }`(중첩 가능).
- **팩 경계를 넘는 엣지를 추가한 뒤에는 `node scripts/materialize-sprites.js --write`를 실행한다.** 스프라이트는 `sprites/nodes/`에 있지만 메뉴바는 `sprites/packs/<pack>/`에서 읽으므로, 팩이 새로 렌더하게 된 노드의 파일을 복사해야 한다. 안 돌리면 조건이 발동하는 날 프레임이 없어 한 단계 아래로 폴백한다. `python3 scripts/sprite_status.py --check` (exit code 0 확인)가 이 누락을 잡는다.

**Lazy binding.** 오늘 이미 도달한 단계는 그날 안에 절대 바뀌지 않는다(눈앞의 형태가 흔들리지 않는다). 아직 도달하지 않은 상위 단계는 30초마다 도는 재계산 때마다 **그 시점의 신호**로 다시 평가된다 — 아직 오르지 않은 단계라면, 거기 도달하기 전까지 조건을 채우기만 하면 그 분기가 반영된다. 재계산은 결정론적이라 신호가 그대로면 결과도 바이트 단위로 그대로다.

`daily.json`에 `route`(단계별 `{id, name, sprite}`)가 추가된다. 메뉴바 앱은 `route[단계].sprite`를 프레임 prefix로, `route[단계].name`을 표시 이름으로 쓰고, 루트가 바뀌면 프레임 세트를 다시 읽는다. 그래프에 없는 팩은 `route: null`이라 기존 `stageNames` 경로로 그대로 동작한다.


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

1. **전역 그래프에 노드를 추가한다.** `evolution-graph.json`에 로키(성장기, `stage: "child"`) 노드와 그 계보(유아기·유년기·알 역방향, 성숙기 이상 전방)를 추가한다. 최소 예시(궁극체 종점 라인):
   ```json
   {
     "id": "rookie_name", "name": "로키이름", "stage": "child", "sprite": "rookie_name",
     "evolvesFrom": [{ "from": "baby_name", "when": null }]
   },
   {
     "id": "adult_name", "name": "성숙기이름", "stage": "adult", "sprite": "adult_name",
     "evolvesFrom": [{ "from": "rookie_name", "when": null }]
   }
   ```
   조건은 `evolvesFrom` 항목마다 붙인다. 부모가 여럿이면 `[{ from: "a", when: null }, { from: "b", when: {...} }]`.
   종점은 명시 플래그 없이 "다음 칸에서 나를 부모로 지목한 노드가 없음"으로 파생된다.

2. **도트 파일을 `sprites/nodes/`에 넣는다.** 최소 `<노드 id>-0.png`. 초상도 함께 넣으면(`portrait-<노드 id>-0.png`) 메뉴바 드롭다운 헤더가 원본 해상도로 표시된다.

3. **`sprites/packs/<새팩이름>/` 디렉터리를 만든다.** 팩 디렉터리 이름은 로키 노드의 `id`와 같아야 한다(이것이 `selectMon`이 오늘의 팩을 고르는 방법이다). 최소 `idle-0.png`를 넣는다. `pack.json`에 `stageNames`로 표시 이름을 지정한다.

4. **`scripts/materialize-sprites.js`를 실행한다.** 전역 `sprites/nodes/`의 파일을 각 팩 디렉터리로 복사(또는 하드링크)한다. 메뉴바가 실제로 읽는 것은 `<pack>/<id>-N.png`이므로 이 단계를 건너뛰면 프레임이 없어 폴백한다.

5. 별도 등록 명령은 없다 — 다음 `daily-tokens.js` 실행(메뉴바 앱이 ~30초 주기로 호출)부터 자동으로 후보에 들어간다.

**기존 그래프에 엣지만 추가하는 경우에도 4단계(materialize)를 다시 돌려야 한다.** 도트를 새로 만들지 않아도, 팩 경계를 넘는 엣지(`evolvesFrom`에 다른 팩의 노드를 부모로 추가)는 그 팩이 렌더할 수 있는 노드 집합을 넓히므로 프레임이 그 팩 디렉터리에 없다. 건너뛰면 **조건이 발동하는 날에만** 프레임이 없어 한 단계 아래로 폴백한다 — 평소에는 정상으로 보이고 특정 조건의 날에만 퇴화처럼 보이는, 재현이 어려운 형태로 나타난다. `python3 scripts/sprite_status.py --check` (exit code 확인)가 이 누락을 잡는다. 엣지를 추가했으면 이 검사를 돌려라.

> 갖고 있는 스프라이트 시트를 잘라 프레임을 만들 때는 `scripts/extract_pack_*.py`를 참고 예시로 쓸 수 있다(시트 크롭 좌표를 팩 규격 PNG로 변환).

### 새 노드 대량 편입 도구 (2026-08-20)

도트 부족이 아니라 **어떤 종을 편입할지 정사대로 판정하는 것**이 병목이 되면서, 위 1~4단계를 대량으로 돌리기 위한 도구 둘이 추가됐다.

- **`scripts/harvest-wikimon-canon.js`** — 종 목록(또는 `--from-graph`로 현재 그래프 전체)에 대해 Wikimon raw wikitext에서 세대·한글명·`Evolves From` 부모 목록과 각 부모의 출처 게임을 뽑아 JSON으로 산출한다. 신규 노드를 `evolution-graph.json`에 편입할 때의 입력 자료다. `--roster-mode strict|relaxed`로 로스터 게이트 완화 여부를 조절하며, 어느 모드든 각 엣지에 `games`와 `passesStrictGate`(항상 strict 기준)를 같이 남겨 사후 소급 적용/철회가 가능하다(§ [Q5 참고](docs/evolution-routes.md)).
- **`scripts/fetch-wikimon-dots.py`** — Wikimon이 종별로 호스팅하는 Digimon Story 오버월드 도트(`<Title>_dst_map.png`, 없으면 `_dsle_map.png` 폴백)를 내려받아 이 레포의 노드 도트 규격(`sprites/nodes/<id>-0.png`, 32×32 RGBA)으로 정규화한다. 파일 존재 여부와 실제 다운로드 URL은 MediaWiki API(`wikimon.net/api.php`)로만 확인하며, 없는 파일을 추측해서 만들지 않는다. `source: "vpet_*"`를 지정하면 컬러 vpet 도트 세트(848종)로 확장할 수도 있다 — dst/dsle_map 337종보다 큰 풀이 필요할 때의 경로다.

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

`portrait-*`는 원래 spine 4단계(`adult`/`perfect`/`ultimate`/`superultimate`)에만 있었다. [랜덤 진화](#랜덤-진화-분기-루트)는 매일 루트를 다시 뽑으므로 분기가 3개인 팩은 대부분의 날을 spine이 아닌 형태로 보내는데, 그 형태들에는 초상이 하나도 없어 아이콘을 눌러도 뻥튀긴 32px가 나왔다 — 큰 화면이 "종종" 깨져 보이던 경로가 이것이다. 지금은 **전역 그래프(`evolution-graph.json`)에 있는 모든 분기 노드**가 자기 초상을 갖는다 (53쌍 / 51시트).

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

## 에셋 출처

이 레포의 코드는 MIT(`LICENSE`)다. **도트 이미지는 그 라이선스의 대상이 아니다.**

- `sprites/nodes/` — [Wikimon](https://wikimon.net)이 호스팅하는 `Digimon Story` 오버월드 도트를 `scripts/fetch-wikimon-dots.py`로 내려받아 32×32 RGBA로 정규화한 것이다.
- `sprites/packs/`의 팩 전용 도트와 `portrait-*` — 닌텐도 DS `Digimon World DS` ROM에서 `scripts/rip_dwds_sprites.py`로 추출했다.

두 출처 모두 원저작권은 **반다이남코(Bandai Namco)**에 있다. 개인적으로 쓰는 마스코트 표시 용도로 포함했을 뿐이며, 재배포·상업적 이용을 허락하지 않는다. 권리자의 요청이 있으면 삭제한다.

## 알려진 제한

- 프로토타입 단계다. 메뉴바 앱(`menubar/`)은 macOS 전용이며 직접 빌드해야 한다.
- 진화는 output 토큰 총량 기준이라, 실제 코드 산출량이 아니라 대화가 길어져도 단계가 오른다.
- `limit80`/`limit95` 오버라이드는 statusline HUD의 사용량 캐시에 의존하므로, 해당 데이터가 없으면 동작하지 않는다.
