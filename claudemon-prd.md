# PRD: ClaudeMon — 디지몬 테마 Claude Code Statusline 마스코트

**작성자:** 동혁
**상태:** Draft
**대상:** Claude Code plugin (statusline + hooks 기반)

---

## 1. 배경

Claude Code에는 공식 마스코트(Clawd)가 존재하지만 제품에 통합되어 있지 않고, 커뮤니티의 `ccpet`, `claude-code-mascot-statusline` 등은 다마고치/픽셀펫 컨셉에 머물러 있음. 진화(evolution) 시스템, 배틀, 케어 실패에 따른 상태 변화 같은 디지몬 특유의 **성장 서사**를 가진 statusline 마스코트는 부재.

## 2. 목표

- 세션 활동(도구 호출, 코드 작성량, 에러율, context 사용량)을 "먹이/훈련" 파라미터로 매핑
- 일정 조건 충족 시 진화 애니메이션과 함께 다음 단계로 성장
- 방치(장시간 미사용) 또는 나쁜 습관(에러 반복, context 낭비)에 따라 조건 저하 → 퇴화 가능

## 3. Non-goals

- 실제 디지몬 IP 에셋 사용 (저작권 문제 → 오리지널 픽셀 크리처로 대체, "디지몬풍"만 차용)
- 서버 동기화 / 멀티플레이 배틀 (v1 범위 밖)
- 모바일 앱 연동

## 4. 유저 스토리

| As a... | I want to... | So that... |
|---|---|---|
| Claude Code 사용자 | statusline에서 내 파트너의 성장 단계를 확인하고 싶다 | 작업에 재미 요소를 더한다 |
| 헤비 유저 | 코드 품질/생산성이 진화에 반영되길 원한다 | 좋은 습관에 대한 게이미피케이션 보상을 받는다 |
| 플러그인 개발자 | 커스텀 크리처 팩을 만들고 싶다 | 커뮤니티 확장이 가능해진다 |

## 5. 진화 단계 설계

기존 `claude-code-mascot-statusline`의 hook 이벤트(9종 세션 상태)를 파라미터 소스로 재사용.

| 단계 | 조건 (누적) | 비주얼 |
|---|---|---|
| 알 (Digitama) | 세션 시작 직후 | 정적 스프라이트, 흔들림 애니메이션 |
| 유년기 (Baby) | 첫 tool call 성공 | 단순 형태, 2프레임 애니메이션 |
| 성장기 (Child) | tool 성공 20회 누적 | 팔다리 생김, context 70%↑ 시 붉은색 경고 |
| 성숙기 (Adult) | tool 성공 100회 + 에러율 <10% | 형태 분기 시작 (전투형/서포트형) |
| 완전체 (Perfect) | 성숙기 조건 + 세션 7일 연속 유지 | 이펙트 강화 |
| 궁극체 (Ultimate) | 완전체 + 유저 정의 마일스톤 (예: PR merge 수) | 최종 스프라이트, 회귀 불가 배지 |

**퇴화 조건:** 24시간 이상 미사용 시 유년기로 리셋 (다마고치 죽음 대신 "동면" 컨셉 — 삭제 유도 지양).

## 6. 기술 아키텍처

- **State store:** `~/.claude/claudemon/state.json` — 로컬 persist, `ccpet` 방식 참고
- **Hook 연동:** `.claude/settings.json`의 tool-start/tool-success/tool-failure/permission-prompt 등 이벤트 → state 업데이트 스크립트 트리거
- **Statusline 렌더:** Node 스크립트, `mascot-statusline`의 pixel-sprite 렌더링 방식 재사용 (ASCII 아님, 터미널 pixel-art)
- **Pack spec:** 커스텀 크리처 팩 JSON (`sprites/`, `evolution-tree.json`, `thresholds.json`)로 확장 가능하게 설계 — `/create-mascot-pack` 스킬과 호환되는 포맷 채택 고려

## 7. 오픈 이슈

- 진화 조건을 "생산성 지표"로 삼는 것이 오히려 압박감(게이미피케이션 부작용)을 줄 수 있음 → 선택적 토글 필요
- 디지몬풍 네이밍/디자인이 IP 유사성 문제로 걸릴 가능성 → 법적 검토 없이는 공개 배포 시 "OO몬" 네이밍 지양

## 8. 성공 지표 (v1, 재미로 정의)

- GitHub star 수 (진지하게 셀 필요는 없음)
- "완전체까지 진화시켰다"는 스크린샷 인증 게시물 수
