# ClaudeMon (프로토타입)

> **도트 이미지는 이 레포에 포함되지 않는다.** 스프라이트는 각자 준비해서 `sprites/packs/`에 넣는다 — 아래 [스프라이트 팩](#스프라이트-팩-spritespacks) 참고.

디지몬풍 진화 시스템을 가진 Claude Code statusline 마스코트.

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

## 구조

- `evolution-tree.json` — 진화 단계/조건/스프라이트 정의 (수정해서 커스텀 팩 제작 가능)
- `lib/state.js` — 상태 persist. 전역용 `load()`/`save()`는 `~/.claude/claudemon/state.json`, 세션별용 `loadSession(sessionId)`/`saveSession(state)`는 `~/.claude/claudemon/sessions/<session_id>.json`, 전 세션 누적용 `loadGlobal()`/`saveGlobal(global)`는 `~/.claude/claudemon/global.json`
- `lib/evolve.js` — 조건 평가, 진화/퇴화 로직
- `lib/daily.js` — 일일(KST) output 토큰 집계 로직 + 증분 스캔 캐시
- `hook.js` — Claude Code hook에서 호출, 카운터 갱신 (working 플래그 등 행동용 상태에 계속 사용됨)
- `daily-tokens.js` — 일일 토큰 집계 CLI. 메뉴바 앱이 주기적으로(30초 간격) 호출해 `daily.json`을 갱신한다
- `statusline.js` — 실제 statusline에 렌더링되는 스크립트

## 진화 단계 (일일 KST 토큰 소모량 기준)

메뉴바 마스코트의 진화 단계는 **그날(KST, 자정 리셋) 소모한 output 토큰 총량**으로만 결정된다. 세션/전역 tool-success 카운터(`hook.js`, `lib/state.js`)는 여전히 `working` 플래그 등 행동 상태 용도로 유지되지만 더 이상 진화 단계에 영향을 주지 않는다.

| 단계 | 조건 (`dailyOutputTokens`) |
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

**레포에는 도트 이미지가 들어있지 않다.** 저작권 문제로 스프라이트 PNG는 커밋하지 않으며(`.gitignore`로 차단), 각자 원하는 도트를 준비해서 로컬에 넣는다 — 자작 픽셀아트, 라이선스가 확보된 에셋 등 무엇이든 파일명 계약만 지키면 된다.

메뉴바 마스코트는 팩 단위로 스프라이트를 묶는다. 각 팩은 `sprites/packs/<팩이름>/` 아래에 아래 파일명 계약을 지켜야 한다(모두 32x32 RGBA PNG):

```
digitama-0.png, digitama-1.png
baby-0.png,     baby-1.png
child-0.png,    child-1.png
adult-0.png,    adult-1.png
perfect-0.png,  perfect-1.png
ultimate-0.png, ultimate-1.png
limit80-0.png,  limit80-1.png
limit95-0.png,  limit95-1.png
idle-0.png,     idle-1.png
```

- `digitama-0.png`가 존재하는 디렉터리만 "유효 팩"으로 인식된다. 나머지 파일이 일부 빠져도 스캔 자체는 통과하지만, 해당 프레임을 쓰는 화면에서는 표시가 깨질 수 있으니 전체 세트를 채우는 걸 권장한다.
- 팩 디렉터리에 `pack.json`을 두면 표시 이름과 단계별 진화 계보 이름을 지정할 수 있다(레포에 포함된 `sprites/packs/*/pack.json` 참고).
- 갖고 있는 스프라이트 시트에서 프레임을 잘라낼 때는 `scripts/extract_pack_*.py`를 참고용 예시로 쓸 수 있다(시트 크롭 좌표를 팩 규격 PNG로 변환하는 스크립트).

### 매일 랜덤 몬 선택 (`lib/daily.js`)

- `computeDailyTokens`가 실행될 때마다 `sprites/packs/` 아래에서 유효 팩 목록(디렉터리명 정렬)을 스캔하고, `dateKST` 문자열의 단순 해시(`hashString` — 문자코드 누적, `Math.random` 미사용) 를 유효 팩 개수로 나눈 나머지로 오늘의 팩을 고른다.
- 같은 KST 날짜 안에서는 몇 번을 재실행해도 같은 팩이 나오고(멱등), `daily.json`에 오늘 날짜의 `mon`이 이미 있으면 도중에 새 팩이 추가돼도 당일은 그 값을 그대로 유지한다. 날짜가 바뀌면 다시 해시로 재계산한다.
- 유효 팩이 하나도 없으면 `mon: "guilmon"`으로 fallback한다.

### 커스텀 팩 추가

1. `sprites/packs/<새팩이름>/`을 만들고 위 파일명 계약대로 9종 × 2프레임 PNG를 채운다.
2. `digitama-0.png`만 있으면 스캔 대상에 포함되므로, 최소한 그 파일부터 넣고 나머지를 채워나가도 된다.
3. 별도 등록 절차는 없다 — 다음 `daily-tokens.js` 실행부터 자동으로 로테이션 후보에 들어간다.

## working 플래그

세션이 지금 Claude Code 응답을 생성 중인지(작업 중) 아니면 사용자 입력을 기다리는지(대기 중) 구분하는 플래그.

- `UserPromptSubmit` 훅 → `hook.js turn-start` 호출 → `state.working = true`
- `Stop` 훅 → `hook.js turn-end` 호출 → `state.working = false`, `state.lastTurnEndAt` 기록
- 세션 시작 시(`hook.js session-start`) → `state.working = false`
- `tool-success`/`tool-failure` 이벤트도 안전망으로 `state.working = true`를 함께 설정한다(턴 경계 이벤트가 누락돼도 실제 도구 호출 중임을 반영).

`working`/`lastTurnEndAt`은 세션 상태 파일(`~/.claude/claudemon/sessions/<session_id>.json`)에 저장되며, 카운터에는 영향을 주지 않는다.

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

- pixel-sprite 아님, 텍스트/이모지 기반 (실사용 시 `claude-code-mascot-statusline`처럼 진짜 픽셀아트로 교체 권장)
- consecutiveDaysActive 로직은 자정 기준 단순 비교라 타임존 이슈 있을 수 있음
- 궁극체(prMergedCount) 마일스톤은 아직 git/PR 연동 안 됨 — 수동으로 `hook.js pr-merged` 호출 필요
