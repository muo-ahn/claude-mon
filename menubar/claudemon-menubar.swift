// ClaudeMon menu bar mascot (PoC)
// Build: swiftc -O -o claudemon-menubar claudemon-menubar.swift
// Run:   ./claudemon-menubar /path/to/sprites
//
// The sprite pack is now DYNAMIC: daily.json carries a "mon" field (which
// digimon pack is active today) alongside its stageId. Frames are loaded
// from <spriteRoot>/packs/<mon>/<prefix>-<n>.png. If the named pack is
// missing or incomplete, this falls back to the "guilmon" pack; if that is
// also unavailable, the last successfully loaded frame set is kept rather
// than crashing. One exception: species-agnostic stages (currently just
// "digitama") load from <spriteRoot>/shared instead, since a Digi-Egg looks
// the same whoever is inside it.
//
// Evolution stage is now a DAILY GLOBAL value, not tied to any one focused
// session: every 2s tick reads $CLAUDEMON_DIR/daily.json (written by
// daily-tokens.js, which this app also spawns every 30s to keep it fresh).
// That file tracks today's (KST) total output tokens across all sessions
// and the stage they map to. Missing/corrupt daily.json falls back to
// "digitama" and never crashes the app.
//
// Session state is judged, not just read: hook.js only records facts
// (working, mtime, pid, awaitingUserSince, endedAt); this file is the sole
// place that turns those facts into one of five states per session --
// dead / waitingUser / stalled / working / idle -- via projectState().
// globalState() then picks the single most urgent state across every
// registered session (waitingUser > stalled > working > idle; dead
// sessions never contribute), and that drives both whether the mascot
// ANIMATES (working or waitingUser) and which sprite set is shown.
//
// The dropdown still resolves and shows the single focused session (via
// active-session.sh, same resolution chain as before: kitty -> tmux ->
// descendant claude pid -> session file), condensed to one line, purely for
// human context — it no longer drives the sprite or the animation state.
// Every live session also gets its own row labeled by its projected state;
// a session that just died stays visible (labeled "종료") for a short
// grace window instead of vanishing immediately.
//
// Sprite overrides layer on top of the plain per-stage frames, highest
// priority first: limit95 (rate limit) > waitingUser > stalled > limit80
// (rate limit) > working/idle (plain stage frames). Rate-limit levels come
// from the HUD cache (<cwd>/.omc/state/hud-stdin-cache.json) belonging to
// whichever registered session's cache was written most recently, since
// the usage limit itself is account-wide and any session's cache is
// equally authoritative. For genericOverrideStages the overrides reuse the
// pack's generic sprite files (Rookie-only); for adult/perfect/ultimate
// they instead tint the current stage frames, since no generic sprite
// matches those species (see framesForLevel).

import AppKit
import UserNotifications

// argv[0] can be relative ("./claudemon-menubar") — resolve against CWD
// once so every derived path is absolute. NOTE: this is main.swift-style
// top-level code, so globals initialize in DECLARATION ORDER — this must
// stay above spriteRoot and everything else that reads it. A relative
// argv[0] previously collapsed projectRoot to "" and silently disabled
// the token aggregator.
let executableDir: String = {
    let raw = CommandLine.arguments[0]
    let abs = (raw as NSString).isAbsolutePath
        ? raw
        : FileManager.default.currentDirectoryPath + "/" + raw
    return ((abs as NSString).standardizingPath as NSString).deletingLastPathComponent
}()

// Picks the sprite-root positional argument out of argv, skipping over the
// headless CLI flags (--dump-state, --dump-limits <path>, --demo-pet, --no-pet, --demo-cutin
// [fromStage] [toStage]) so `claudemon-menubar <root> --dump-state`, the
// flag-only `claudemon-menubar --dump-state` (default root), and
// `claudemon-menubar <root> --demo-cutin` all work. --demo-cutin's own
// arguments are stage names, not a sprite root, so once it's seen the rest
// of argv is skipped entirely rather than misread as a positional path.
let spriteRoot: String = {
    let args = Array(CommandLine.arguments.dropFirst())
    var skipNext = false
    for arg in args {
        if skipNext { skipNext = false; continue }
        if arg == "--dump-limits" { skipNext = true; continue }
        if arg == "--dump-state" || arg == "--demo-pet" || arg == "--no-pet" { continue }
        if arg == "--demo-cutin" { break }
        return (arg as NSString).isAbsolutePath ? arg : URL(fileURLWithPath: arg).standardizedFileURL.path
    }
    return (executableDir as NSString).deletingLastPathComponent + "/sprites"
}()

// Fallback pack used whenever the daily-selected mon's pack is missing or
// incomplete, and whenever daily.json predates the "mon" field entirely.
let defaultMon = "guilmon"

func packPath(for mon: String) -> String {
    return spriteRoot + "/packs/" + mon
}

let resolverScript = executableDir + "/active-session.sh"

// .app 번들로 실행하면 executableDir 이 Contents/MacOS 라 파생 projectRoot 는
// Contents 를 가리키고, dailyTokensScript 가 존재하지 않는 경로가 되어 토큰
// 집계기가 조용히 멈춘다 — 위 executableDir 주석이 적어둔 그 고장이 번들화로
// 그대로 재현된다. CLAUDEMON_DIR 과 같은 방식으로 env 를 우선한다 (launchd plist 가 넣는다).
let projectRoot: String = {
    if let override = ProcessInfo.processInfo.environment["CLAUDEMON_PROJECT_ROOT"],
       !override.isEmpty {
        return override
    }
    return (executableDir as NSString).deletingLastPathComponent
}()

let dailyTokensScript = projectRoot + "/daily-tokens.js"

let claudemonDir: String = {
    ProcessInfo.processInfo.environment["CLAUDEMON_DIR"]
        ?? NSHomeDirectory() + "/.claude/claudemon"
}()

let globalStateFile = claudemonDir + "/state.json"
let dailyStateFile = claudemonDir + "/daily.json"
let sessionsDir = claudemonDir + "/sessions"

// 알림 큐 — hook.js 가 JSON 파일을 떨구고 이 앱이 소비한다. 소켓이 아니라 파일드롭인
// 이유가 두 가지다: 앱이 내려가 있는 동안 도착한 요청이 사라지지 않고, 연결 수명을
// 관리하는 코드가 아예 없어진다. 폴링으로 읽는 것도 이 파일의 나머지와 같은 판단이다
// (focused-session 주석 참고) — 큐 디렉터리는 거의 항상 비어 있어서 0.5초 readdir 은
// 사실상 무비용이다.
let notifyQueueDir = claudemonDir + "/notify-queue"
// notify.js 가 "앱 경로를 쓸 수 있는가" 를 판정하는 근거. 2초 틱마다 갱신한다.
let notifyHeartbeatFile = claudemonDir + "/menubar-alive.json"
// 앱이 죽어 있던 사이에 쌓인 요청은 버린다. 30분 전의 "입력 대기" 를 지금 띄우는 것은
// 정보가 아니라 노이즈다.
let notifyStaleSeconds: TimeInterval = 60
// 알림 방식(알림센터/펫) 같은 사용자 설정. 상태 파일들과 같은 디렉터리라 CLAUDEMON_DIR 을
// 따라간다 — 테스트가 실제 설정을 건드리지 않는다.
let notifySettingsFile = claudemonDir + "/settings.json"

// Ordered low to high: loadFrames() relies on the order to fall back to the
// stage below when a pack has no art for one yet.
let stageIds = ["digitama", "baby", "child", "adult", "perfect", "ultimate", "superultimate"]

// Stages where the pack's generic override sprites (idle-*.png,
// limit80-*.png, limit95-*.png) are safe to use as-is. Those files are all
// drawn from the Rookie (성장기) sheet, so the species only matches while
// currentStageId is still at or before "child". From "adult" onward the
// generic sprites would show the wrong species, so framesForLevel tints the
// current stage frames instead of swapping in the generic sprite.
let genericOverrideStages = ["child"]

// Stages whose sprite is species-agnostic and therefore shared by every pack,
// loaded from <spriteRoot>/shared instead of the pack directory -- a Digi-Egg
// looks the same whoever is inside it. The egg art lives only in shared/;
// packs don't carry their own digitama-*.png (some used to, but those were
// mislabeled Baby-stage dots, not eggs, and have since been removed).
let sharedStages = ["digitama"]
let sharedSpriteDir = spriteRoot + "/shared"

let stageLabels: [String: String] = [
    "digitama": "알",
    "baby": "유년기",
    "child": "성장기",
    "adult": "성숙기",
    "perfect": "완전체",
    "ultimate": "궁극체",
    "superultimate": "초궁극체",
]

// Known packs get a Korean display name; an unrecognized/new pack name is
// shown as-is rather than hidden or blocked.
let monLabels: [String: String] = [
    "guilmon": "길몬",
    "agumon": "아구몬",
    "gabumon": "파피몬",
    "veemon": "브이몬",
    "renamon": "레나몬",
    "terriermon": "테리어몬",
    "impmon": "임프몬",
    "keramon": "케라몬",
    "falcomon": "팔코몬",
    "gaomon": "가오몬",
]

func labelForMon(_ mon: String) -> String {
    return monLabels[mon] ?? mon
}

// Evolution-line names from <pack>/pack.json ("stageNames": {stageId: name}).
// The mascot's DISPLAYED name follows its current stage (아구몬 → 그레이몬 →
// 워그레이몬), not just the pack's rookie name. Missing/invalid pack.json
// degrades to the static per-mon label.
func stageNames(forPack pack: String) -> [String: String] {
    guard let data = FileManager.default.contents(atPath: pack + "/pack.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let names = json["stageNames"] as? [String: String]
    else { return [:] }
    return names
}

// Today's branch through the pack's evolution tree, straight from
// daily.json's "route" (see lib/daily.js selectRoute). Empty means the pack
// has no tree, so every stage renders from its spine files and stageNames --
// exactly the old behaviour.
var activeRouteSprites: [String: String] = [:]
var activeRouteNames: [String: String] = [:]
var activeRouteIds: [String: String] = [:]
var activeRouteKey = ""

// Node ids of the pack's own spine per stage: the tree entries whose
// "sprite" is the plain stage id (their art is <stage>-*.png). A route node
// with one of these ids is the same species as the spine file, so the spine
// file is a safe stand-in; any other id is a branch and must never borrow it.
func spineNodeIds(forPack pack: String) -> [String: Set<String>] {
    guard let data = FileManager.default.contents(atPath: pack + "/pack.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tree = json["tree"] as? [String: [[String: Any]]]
    else { return [:] }
    var spine: [String: Set<String>] = [:]
    for (stage, nodes) in tree {
        for node in nodes where node["sprite"] as? String == stage {
            if let id = node["id"] as? String { spine[stage, default: []].insert(id) }
        }
    }
    return spine
}

func evolvedName(pack: String, mon: String, stageId: String) -> String {
    if let routed = activeRouteNames[stageId] { return routed }
    return stageNames(forPack: pack)[stageId] ?? labelForMon(mon)
}

// Returns true when the route actually changed, which is the signal to
// reload frame sets (a new route can point a stage at different art).
//
// `mon` belongs in the key, not just the sprite list: sprite keys alone
// collide ACROSS packs. A stage that renders from its spine files has
// sprite == stageId, so every pack whose route picked spine the whole way
// down produces the same "digitama>baby>...>superultimate" string -- that is
// 7 of the 10 default packs, and falcomon/impmon have no branches at all so
// they hit it every single day. When the daily rotation moved impmon ->
// falcomon the guard below saw an unchanged key and kept impmon's stage
// NAMES, while the art still switched (switchMonIfNeeded compares mon
// itself). Result: 팔코몬's dots labelled 임프몬.
func applyRoute(_ route: [String: [String: String]], mon: String) -> Bool {
    var sprites: [String: String] = [:]
    var names: [String: String] = [:]
    var ids: [String: String] = [:]
    for (stage, node) in route {
        if let i = node["id"], !i.isEmpty { ids[stage] = i }
        if let s = node["sprite"], !s.isEmpty { sprites[stage] = s }
        if let n = node["name"], !n.isEmpty { names[stage] = n }
    }
    // name has to be in the key too, not just sprite: a terminalFrom clamp
    // (or any other metadata-only route update) can change which stage a
    // name attaches to without touching any sprite string, and a
    // sprite-only key would then see no change and skip the reload.
    let key = ([mon] + stageIds.flatMap { [sprites[$0] ?? $0, names[$0] ?? ""] }).joined(separator: ">")
    guard key != activeRouteKey else { return false }
    activeRouteSprites = sprites
    activeRouteNames = names
    activeRouteIds = ids
    activeRouteKey = key
    return true
}

// MARK: - Usage limit display + behavior overrides
//
// Reads <cwd>/.omc/state/hud-stdin-cache.json, which the OMC HUD writes on
// every statusline render. Schema (bucket keys are NOT fixed — future
// buckets like seven_day_opus/fable are expected, so this walks the
// dictionary dynamically instead of hardcoding keys):
//   { "rate_limits": { "five_hour": {"used_percentage": 15, "resets_at": <epoch s>}, ... } }
//
// No macOS notifications are sent for these — the mascot's sprite set is
// overridden instead (see limitLevel / framesForLevel below).

let rateLimitStaleAfter: TimeInterval = 30 * 60

func intValue(_ any: Any?) -> Int {
    if let n = any as? NSNumber { return n.intValue }
    if let d = any as? Double { return Int(d) }
    return 0
}

func doubleValue(_ any: Any?) -> Double {
    if let n = any as? NSNumber { return n.doubleValue }
    if let i = any as? Int { return Double(i) }
    return 0
}

// five_hour -> "5h", seven_day -> "주간"; keys containing "opus"/"fable" get
// a dedicated label since new per-model weekly buckets are expected; any
// other/unknown key falls back to the raw key so nothing silently vanishes.
func labelForBucket(_ key: String) -> String {
    if key == "five_hour" { return "5h" }
    if key == "seven_day" { return "주간" }
    let lower = key.lowercased()
    if lower.contains("opus") { return "Opus 주간" }
    if lower.contains("fable") { return "Fable 주간" }
    return key
}

func formatResetTime(epochSeconds: Double) -> String {
    let date = Date(timeIntervalSince1970: epochSeconds)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "EEE HH:mm"
    return formatter.string(from: date)
}

// MARK: 쿼터 페이싱
//
//   pace = 잔여% / (리셋까지 남은시간 ÷ 창길이 × 100)
//
// 1.0 이면 리셋 시각에 정확히 100% 를 쓰는 페이스다. 남은 쿼터는 리셋과 함께
// 소멸하므로 잔여%만으로는 "지금 아껴야 하나"를 알 수 없다 — 리셋 30분 전의
// 잔여 30% 와 주 초의 잔여 30% 는 정반대 신호다. 같은 공식과 임계치를
// lib/quota.js 와 ~/.claude/hooks/session_budget_nudge.py 가 공유한다.
// 한쪽만 고치면 메뉴 표시와 훅 경고가 어긋난다.
let paceSurplusThreshold = 2.0
let paceTightThreshold = 1.0
let paceDeficitThreshold = 0.7
let quotaHeadroomFloor = 5.0

// 버킷 키는 고정이 아니므로(모델별 주간 버킷 추가 예상) 문자열로 판정하고,
// 모르는 키는 주간으로 본다 — labelForBucket 과 같은 방침.
func quotaWindowSeconds(_ key: String) -> Double {
    let lower = key.lowercased()
    if lower.contains("five_hour") || lower.contains("5h") { return 5 * 3600 }
    if lower.contains("hour") { return 3600 }
    return 7 * 24 * 3600
}

// 표시용 라벨이 아니라 열거형으로 둔다 — 스프라이트 override 판정이 여기에
// 의존하므로, 한글 라벨 비교로 분기하면 문구를 다듬는 순간 마스코트가 조용히 깨진다.
enum QuotaMode: Int {
    case surplus = 0   // 여유 — 리셋 전에 다 못 쓴다
    case normal = 1    // 적정 — 대략 리셋에 맞춰 소진
    case tight = 2     // 빠듯 — 페이스보다 앞서 소진 중
    case deficit = 3   // 과속 — 이대로면 리셋 전에 바닥
}

func quotaModeLabel(_ mode: QuotaMode) -> String {
    switch mode {
    case .surplus: return "여유"
    case .normal: return "적정"
    case .tight: return "빠듯"
    case .deficit: return "과속"
    }
}

// 잔여가 바닥이면 과속 — 단 pace 가 이미 여유면 제외한다. 잔여 4% 라도 리셋
// 30분 전이면 태우지 않는 쪽이 손해다. 고정 유예 시간으로는 이걸 가를 수 없다:
// 7일 창에서 30분은 0.3% 라 어떤 상수를 골라도 주간 버킷은 늘 유예 밖이다.
func quotaMode(pace: Double, headroom: Double) -> QuotaMode {
    if headroom <= quotaHeadroomFloor && pace < paceSurplusThreshold { return .deficit }
    if pace >= paceSurplusThreshold { return .surplus }
    if pace >= paceTightThreshold { return .normal }
    if pace >= paceDeficitThreshold { return .tight }
    return .deficit
}

struct QuotaPace {
    let pace: Double
    let headroom: Double
    let leftSeconds: Double
    let mode: QuotaMode
}

func quotaPace(key: String, bucket: [String: Any], now: Double) -> QuotaPace? {
    let resetsAt = doubleValue(bucket["resets_at"])
    guard resetsAt > 0 else { return nil }
    let window = quotaWindowSeconds(key)
    // 로컬/서버 시계가 어긋나 남은 시간이 창보다 길게 나오면 창 길이로 자른다.
    let left = min(max(0, resetsAt - now), window)
    let headroom = max(0, 100 - doubleValue(bucket["used_percentage"]))
    let leftFrac = left / window
    let pace = leftFrac <= 0.0005 ? Double.infinity : headroom / (leftFrac * 100)
    return QuotaPace(
        pace: pace,
        headroom: headroom,
        leftSeconds: left,
        mode: quotaMode(pace: pace, headroom: headroom)
    )
}

func formatPace(_ pace: Double) -> String {
    return pace.isFinite ? String(format: "%.1fx", pace) : "∞"
}

func rateLimitLine(key: String, bucket: [String: Any], stale: Bool) -> String {
    let percentage = intValue(bucket["used_percentage"])
    let resetsAt = doubleValue(bucket["resets_at"])
    var line = "\(labelForBucket(key))  \(percentage)% · 리셋 \(formatResetTime(epochSeconds: resetsAt))"
    if let p = quotaPace(key: key, bucket: bucket, now: Date().timeIntervalSince1970) {
        line += " · \(formatPace(p.pace)) \(quotaModeLabel(p.mode))"
    }
    if stale { line += " (오래됨)" }
    return line
}

// Highest used_percentage across all rate-limit buckets. Drives the
// stage-frame override below; unknown/malformed buckets are skipped rather
// than treated as 0 so a single bad entry doesn't mask a real high value.
func maxUsedPercentage(rateLimits: [String: Any]) -> Int {
    var maxPct = 0
    for (_, value) in rateLimits {
        guard let bucket = value as? [String: Any] else { continue }
        let pct = intValue(bucket["used_percentage"])
        if pct > maxPct { maxPct = pct }
    }
    return maxPct
}

// Sprite-set override triggered by usage: "limit95" (collapsed) beats
// "limit80" (tired) beats nil (no override, keep stage frames). Stays in
// effect even while the mascot is frozen (paused sessions can still "lie
// there collapsed").
//
// 판정 기준은 사용률 절대값이 아니라 pace 다. 사용률로만 보면 리셋 30분 전
// 96% — 남은 4% 를 태우지 않으면 그대로 소멸하는, 오히려 가장 공격적으로 써야
// 하는 상황 — 에서 마스코트가 쓰러진 채로 있었다. 반대로 주 초 50% 는 절대값
// 기준으로는 멀쩡해 보이지만 이미 고갈 궤도일 수 있다. 마스코트가 표현해야 하는
// 것은 "얼마나 썼나" 가 아니라 "이대로 가면 문제인가" 다.
//
// 심각도는 pace 모드가 가르고(빠듯 → 지침, 과속 → 지침/쓰러짐), 쓰러짐은 실제로
// 바닥이 보일 때(잔여 20% 이하)만 쓴다. 시간 버킷은 돈이 아니라 "지금 당장 막힌다"
// 신호라 잔여가 바닥일 때만 쓰러짐으로 반영한다.
let collapseHeadroomThreshold = 20.0

func limitLevel(rateLimits: [String: Any], now: Double) -> String? {
    var governing: QuotaPace? = nil
    var hourlyBlocked = false

    for (key, value) in rateLimits {
        guard let bucket = value as? [String: Any],
              let paced = quotaPace(key: key, bucket: bucket, now: now)
        else { continue }

        if quotaWindowSeconds(key) <= 12 * 3600 {
            // 곧 리셋될 시간 버킷의 바닥은 몇 분 대기일 뿐이므로 .deficit 일 때만 센다.
            if paced.mode == .deficit && paced.headroom <= quotaHeadroomFloor { hourlyBlocked = true }
            continue
        }
        if governing == nil || paced.pace < governing!.pace { governing = paced }
    }

    // 5h 가 바닥이면 주간이 아무리 여유여도 당장은 못 쓴다.
    if hourlyBlocked { return "limit95" }
    guard let g = governing else { return nil }

    switch g.mode {
    case .surplus, .normal:
        return nil
    case .tight:
        return "limit80"
    case .deficit:
        return g.headroom <= collapseHeadroomThreshold ? "limit95" : "limit80"
    }
}

let orphanSessionThreshold: TimeInterval = 10 * 60

// If awaitingUserSince has been sitting unattended longer than this, the
// user has presumably left that tab/session rather than being about to
// respond, so projectState() demotes it to .idle instead of leaving it as
// .waitingUser forever. Demoted to .idle rather than .stalled because
// .stalled outranks .working in stateUrgencyOrder and would keep hijacking
// the global state; .idle is the correct "nothing to see here" bucket.
let abandonedWaitThreshold: TimeInterval = 60 * 60

// How long a `.dead` session keeps a row in the dropdown/--dump-state list
// after its file stopped being touched, so "it just ended" is visible for
// a moment instead of the row disappearing the instant the pid exits.
let deadSessionGracePeriod: TimeInterval = 5 * 60

// MARK: - Session state projection
//
// Single source of truth for "what is this session doing right now",
// replacing three previously-separate ad-hoc checks (isAnimating's
// working/mtime pair, sessionIsActivelyWorking, and the pid/mtime/status
// logic that used to live inline in liveSessionLines). hook.js writes only
// facts to the session JSON; projectState() is where those facts become a
// judgment.
enum SessionState: String {
    case dead, waitingUser, stalled, working, idle
}

// Signal-0 probe: kill() with signal 0 sends nothing, it only reports
// whether the pid still exists (0 == alive, -1/ESRCH == gone). Factored
// out so every "is this session's process still around" check agrees.
func pidIsAlive(_ pid: Int?) -> Bool {
    guard let pid = pid else { return false }
    return kill(pid_t(pid), 0) == 0
}

// Judges a single session against the facts in its JSON. Checked in this
// order, first match wins:
//   1. endedAt present -> dead (hook.js saw the session end explicitly)
//   2. no pid, or pid no longer alive -> dead (process is just gone)
//   3. awaitingUserSince present -> waitingUser (a permission prompt can
//      appear mid-turn while working is still true, so this is checked
//      before working), unless it has been sitting for longer than
//      abandonedWaitThreshold, in which case the user is presumed to have
//      left and it demotes to idle instead
//   4. working == true but stale (mtime older than orphanSessionThreshold)
//      -> stalled (reported working from a session that stopped updating)
//   5. working == true and fresh -> working
//   6. otherwise -> idle
func projectState(_ entry: SessionEntry, now: Date = Date()) -> SessionState {
    if let ended = entry.json["endedAt"] as? String, !ended.isEmpty { return .dead }
    guard let pid = entry.json["pid"] as? Int, pidIsAlive(pid) else { return .dead }
    if let awaiting = entry.json["awaitingUserSince"] as? String, !awaiting.isEmpty {
        if let awaitingSince = parseISO8601(awaiting), now.timeIntervalSince(awaitingSince) > abandonedWaitThreshold {
            return .idle
        }
        return .waitingUser
    }
    if workingFieldPresent(entry.json) == true {
        if let mtime = entry.mtime, now.timeIntervalSince(mtime) > orphanSessionThreshold { return .stalled }
        return .working
    }
    return .idle
}

// Single urgency ordering shared by globalState (winner across all
// sessions) and statePriority (dropdown/--dump-state row sort): a stalled
// session needs intervention more than one that's just working fine, so it
// ranks above working, same as waitingUser ranks above both. The only
// place these two consumers differ is dead sessions -- globalState drops
// them before picking a winner (a dead session must never mask a real one
// elsewhere), while statePriority still ranks them, last, since a dead row
// is still shown (briefly) in the dropdown.
private let stateUrgencyOrder: [SessionState] = [.waitingUser, .stalled, .working, .idle, .dead]

// Most urgent state across every registered session, per stateUrgencyOrder
// with dead sessions excluded first -- an orphaned/ended session must
// never mask a real waitingUser/working session elsewhere, nor should a
// machine with only dead sessions register as anything but idle.
func globalState(_ sessions: [SessionEntry], now: Date = Date()) -> SessionState {
    let alive = Set(sessions.map { projectState($0, now: now) }).subtracting([.dead])
    return stateUrgencyOrder.first { alive.contains($0) } ?? .idle
}

// Dropdown/--dump-state sort order: most urgent first (stateUrgencyOrder),
// mtime-desc within a tie.
func statePriority(_ state: SessionState) -> Int {
    stateUrgencyOrder.firstIndex(of: state) ?? stateUrgencyOrder.count
}

// Shared ordering behind both the dropdown and --dump-state: filters to
// sessions touched in the last 24h (unchanged cutoff), gives `.dead`
// sessions a short grace window before dropping them, then sorts by
// urgency/recency. Centralizing this means the two output paths can never
// silently drift apart.
func orderedSessionStates(sessions: [SessionEntry], now: Date = Date()) -> [(entry: SessionEntry, state: SessionState)] {
    var rows: [(entry: SessionEntry, state: SessionState)] = []
    for entry in sessions {
        guard let mtime = entry.mtime, now.timeIntervalSince(mtime) < 24 * 3600 else { continue }
        let state = projectState(entry, now: now)
        if state == .dead, now.timeIntervalSince(mtime) >= deadSessionGracePeriod { continue }
        rows.append((entry, state))
    }
    rows.sort { a, b in
        let pa = statePriority(a.state), pb = statePriority(b.state)
        if pa != pb { return pa < pb }
        return (a.entry.mtime ?? .distantPast) > (b.entry.mtime ?? .distantPast)
    }
    return rows
}

// Dropdown status label for one session's projected state, kept separate
// from projectState itself so display-copy tweaks never touch the
// classification logic.
func sessionStatusLabel(_ state: SessionState, json: [String: Any]) -> String {
    switch state {
    case .working:
        return "● 작업 중"
    case .waitingUser:
        if let raw = json["awaitingUserSince"] as? String, let d = parseISO8601(raw) {
            return "! 입력 대기 (\(formatClockTime(d))부터)"
        }
        return "! 입력 대기"
    case .stalled:
        return "⏸ 멈춤"
    case .idle:
        if let raw = json["awaitingUserSince"] as? String, !raw.isEmpty, let d = parseISO8601(raw) {
            return "○ 대기 (입력 대기 방치, \(formatClockTime(d))부터)"
        }
        if let raw = json["lastTurnEndAt"] as? String, let d = parseISO8601(raw) {
            return "○ 대기 (\(formatClockTime(d)) 종료)"
        }
        return "○ 대기"
    case .dead:
        return "× 종료"
    }
}

// Combines the two independent override sources -- the account-wide
// rate-limit level from the HUD cache, and the session-derived global
// state -- into the single key that picks a frame set. Priority, highest
// first: limit95 > waitingUser > stalled > limit80 > (nil, i.e. plain
// stage frames for working/idle).
func overrideFrameLevel(limitLevel: String?, sessionState: SessionState) -> String? {
    if limitLevel == "limit95" { return "limit95" }
    if sessionState == .waitingUser { return "waitingUser" }
    if sessionState == .stalled { return "stalled" }
    if limitLevel == "limit80" { return "limit80" }
    return nil
}

// Legacy single-file animation rule, used only as a fallback when
// $CLAUDEMON_DIR/sessions has no files at all (e.g. fresh install before
// any session has registered). `working` nil (field absent) keeps the old
// always-animate behavior; `referenceMtime` guards against a stuck file
// that got stranded reporting working == true.
func isAnimating(working: Bool?, referenceMtime: Date?, now: Date = Date()) -> Bool {
    guard let working = working else { return true }
    if !working { return false }
    if let mtime = referenceMtime, now.timeIntervalSince(mtime) > orphanSessionThreshold { return false }
    return true
}

// Resolves the "working" field from a session JSON dict. JSONSerialization
// bridges JSON booleans to Swift Bool directly in most cases, but falls
// back to NSNumber.boolValue for safety. Returns nil when the field is
// absent or not bool-like, distinguishing "unknown" from "false".
func workingFieldPresent(_ json: [String: Any]) -> Bool? {
    guard let raw = json["working"] else { return nil }
    if let b = raw as? Bool { return b }
    if let n = raw as? NSNumber { return n.boolValue }
    return nil
}

func parseISO8601(_ s: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let d = formatter.date(from: s) { return d }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: s)
}

func formatClockTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

func formatTokenCount(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
    return "\(n)"
}

// Reads <cwd>/.omc/state/hud-stdin-cache.json. Returns nil on any missing
// file / parse failure so callers can simply omit the limits section.
func readHudCache(cwd: String) -> (json: [String: Any], stale: Bool)? {
    let path = cwd + "/.omc/state/hud-stdin-cache.json"
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    var stale = false
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let mtime = attrs[.modificationDate] as? Date {
        stale = Date().timeIntervalSince(mtime) > rateLimitStaleAfter
    }
    return (json, stale)
}

// MARK: - Daily global stage

// Reads $CLAUDEMON_DIR/daily.json. Any failure (missing file, malformed
// JSON, unrecognized stageId) falls back to ("digitama", 0, nil) rather
// than crashing or showing a stale/garbage stage.
func readDailyState() -> (stageId: String, outputTokens: Int, dateKST: String?, mon: String, sessionTokens: [String: Int], route: [String: [String: String]], terminalFrom: String?, routeReasons: [String: [String: Any]]?) {
    guard let data = FileManager.default.contents(atPath: dailyStateFile),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return ("digitama", 0, nil, defaultMon, [:], [:], nil, nil) }
    let rawStage = json["stageId"] as? String ?? "digitama"
    let stageId = stageIds.contains(rawStage) ? rawStage : "digitama"
    let tokens = intValue(json["outputTokens"])
    let dateKST = json["dateKST"] as? String
    // Missing "mon" (pre-pack daily.json) or an empty value both mean
    // "no pack chosen yet" -> guilmon, same fallback as an unknown pack.
    let rawMon = json["mon"] as? String
    let mon = (rawMon?.isEmpty ?? true) ? defaultMon : rawMon!
    var sessionTokens: [String: Int] = [:]
    if let raw = json["sessionTokens"] as? [String: Any] {
        for (sid, v) in raw { sessionTokens[sid] = intValue(v) }
    }
    // route stays [String: [String: String]] on purpose -- a Bool value
    // mixed into any node dict would fail this cast for the WHOLE route
    // (not just that node), collapsing it to [:] and losing every stage's
    // name/sprite. terminalFrom carries "which stage this lineage ends at"
    // as a separate top-level string key instead (lib/daily.js D7 clamp).
    let route = json["route"] as? [String: [String: String]] ?? [:]
    let terminalFrom = json["terminalFrom"] as? String
    // routeReasons is optional (pre-route-reasons daily.json won't have it).
    // Parse defensively: missing or malformed -> nil, display nothing.
    let routeReasons = json["routeReasons"] as? [String: [String: Any]]
    return (stageId, tokens, dateKST, mon, sessionTokens, route, terminalFrom, routeReasons)
}

// Resolves which pack directory should actually be used for a requested
// mon: the requested pack if it has at least a first idle frame on disk,
// otherwise the guilmon pack. Pure filesystem check (no NSImage decoding),
// so it is safe to call from --dump-state as well as from the running app
// before touching any AppKit image state.
func resolvePack(for mon: String) -> (mon: String, path: String) {
    let requested = packPath(for: mon)
    if FileManager.default.fileExists(atPath: requested + "/idle-0.png") {
        return (mon, requested)
    }
    return (defaultMon, packPath(for: defaultMon))
}

// Locates a usable `node` binary without hardcoding a single path, since
// homebrew/system Node installs land in different places across machines.
func findNodeBinary() -> String? {
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}

// Fire-and-forget spawn of daily-tokens.js to refresh daily.json. Never
// throws/crashes the app: a missing node binary, missing script, or
// spawn failure just means daily.json keeps its last-known value until
// the next tick succeeds.
func runDailyTokensAggregator() {
    guard let node = findNodeBinary() else { return }
    guard FileManager.default.fileExists(atPath: dailyTokensScript) else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [dailyTokensScript]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    process.terminationHandler = { _ in }
    do { try process.run() } catch { return }
}

// MARK: - Session scanning (global "is anything working" signal)

struct SessionEntry {
    let path: String
    let json: [String: Any]
    let mtime: Date?
}

func scanSessions(dir: String) -> [SessionEntry] {
    guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
    var result: [SessionEntry] = []
    for f in files where f.hasSuffix(".json") {
        let path = dir + "/" + f
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        let mtime = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        result.append(SessionEntry(path: path, json: json, mtime: mtime))
    }
    return result
}

// Global state decision + how many sessions are actively working. Falls
// back to the legacy single global-state-file rule only when there are no
// session files at all yet (fresh install) -- that path only ever yields
// working/idle, since there is no per-session awaitingUserSince/mtime data
// to derive waitingUser/stalled from.
func globalWorkingState(sessions: [SessionEntry], fallbackGlobalPath: String, now: Date = Date()) -> (state: SessionState, workingCount: Int) {
    if sessions.isEmpty {
        guard let data = FileManager.default.contents(atPath: fallbackGlobalPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (.idle, 0) }
        let working = workingFieldPresent(json)
        let mtime = (try? FileManager.default.attributesOfItem(atPath: fallbackGlobalPath))?[.modificationDate] as? Date
        let animating = isAnimating(working: working, referenceMtime: mtime, now: now)
        return (animating ? .working : .idle, animating ? 1 : 0)
    }
    let state = globalState(sessions, now: now)
    let workingCount = sessions.filter { projectState($0, now: now) == .working }.count
    return (state, workingCount)
}

// Picks the HUD cache belonging to whichever registered session's cwd has
// the most recently modified cache file — the usage limit is account-wide
// so any fresh cache is equally correct, and "most recent" avoids showing
// a stale reading from a long-idle project.
func mostRecentHudCache(sessions: [SessionEntry]) -> (json: [String: Any], stale: Bool)? {
    var bestCwd: String? = nil
    var bestMtime = Date.distantPast
    for entry in sessions {
        guard let cwd = entry.json["cwd"] as? String, !cwd.isEmpty else { continue }
        let path = cwd + "/.omc/state/hud-stdin-cache.json"
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let mtime = attrs[.modificationDate] as? Date
        else { continue }
        if bestCwd == nil || mtime > bestMtime {
            bestCwd = cwd
            bestMtime = mtime
        }
    }
    guard let cwd = bestCwd else { return nil }
    return readHudCache(cwd: cwd)
}

// --dump-limits <hud-cache-path>: headless CLI test mode, prints the same
// lines the menu would show and exits. No GUI/app is started.
func dumpLimits(path: String) {
    guard let data = FileManager.default.contents(atPath: path) else {
        fputs("claudemon-menubar: cannot read \(path)\n", stderr)
        exit(1)
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fputs("claudemon-menubar: cannot parse \(path)\n", stderr)
        exit(1)
    }
    var stale = false
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let mtime = attrs[.modificationDate] as? Date {
        stale = Date().timeIntervalSince(mtime) > rateLimitStaleAfter
    }
    guard let rateLimits = json["rate_limits"] as? [String: Any], !rateLimits.isEmpty else {
        print("(no rate limits)")
        return
    }
    for key in rateLimits.keys.sorted() {
        guard let bucket = rateLimits[key] as? [String: Any] else { continue }
        print(rateLimitLine(key: key, bucket: bucket, stale: stale))
    }
    // 스프라이트 override 판정도 같이 찍는다 — 표시 문구만 보고는 마스코트가
    // 왜 쓰러졌는지 알 수 없고, 이 판정을 헤드리스로 확인할 다른 경로가 없다.
    let level = limitLevel(rateLimits: rateLimits, now: Date().timeIntervalSince1970)
    print("spriteLevel: \(level ?? "(없음)")")
}

// --dump-state: headless CLI test mode. Reads the same global sources the
// running app would ($CLAUDEMON_DIR/daily.json, .../sessions/*.json, and
// whichever session's HUD cache is freshest) and prints the resulting
// stage/animation/rate-limit decision, without starting the GUI/app.
// Entirely env-driven (via CLAUDEMON_DIR) so tests can point it at a
// scratch directory.
func dumpState() {
    let (stageId, outputTokens, dateKST, mon, sessionTokens, route, terminalFrom, routeReasons) = readDailyState()
    let daily = (stageId: stageId, outputTokens: outputTokens, dateKST: dateKST, mon: mon, sessionTokens: sessionTokens, route: route, terminalFrom: terminalFrom)
    // The GUI applies today's route before it ever renders a name; this dump
    // has to do the same or `name:` silently reports the pack's spine instead
    // of the branch actually on screen (perfect read 메탈그레이몬 while the
    // route said 라이즈그레이몬). Only shows up once a route takes a branch,
    // which is why it went unnoticed while every pack ran spine-only.
    _ = applyRoute(daily.route, mon: daily.mon)
    let sessions = scanSessions(dir: sessionsDir)
    let (state, workingCount) = globalWorkingState(sessions: sessions, fallbackGlobalPath: globalStateFile)
    let animating = (state == .working || state == .waitingUser)

    var maxPct = 0
    var usageLevel: String? = nil
    if let (cache, _) = mostRecentHudCache(sessions: sessions),
       let rateLimits = cache["rate_limits"] as? [String: Any] {
        maxPct = maxUsedPercentage(rateLimits: rateLimits)
        usageLevel = limitLevel(rateLimits: rateLimits, now: Date().timeIntervalSince1970)
    }
    let level = overrideFrameLevel(limitLevel: usageLevel, sessionState: state)
    let resolved = resolvePack(for: daily.mon)

    print("mon: \(resolved.mon)")
    print("pack: \(resolved.path)")
    print("name: \(evolvedName(pack: resolved.path, mon: resolved.mon, stageId: daily.stageId))")
    print("dailyStage: \(daily.stageId)")
    print("terminalFrom: \(daily.terminalFrom ?? "")")
    print("dailyOutputTokens: \(daily.outputTokens)")
    print("workingSessionCount: \(workingCount)")
    print("animating: \(animating)")
    print("maxRateLimitPercentage: \(maxPct)")
    print("spriteLevel: \(usageLevel ?? "(없음)")")
    print("frameSet: \(level ?? "stage:\(daily.stageId)")")
    print("globalState: \(state.rawValue)")

    // Route reasons: show why each stage was chosen (headless verification path)
    if let reasons = routeReasons {
        let stageOrder = ["digitama", "baby", "child", "adult", "perfect", "ultimate", "superultimate"]
        for stage in stageOrder {
            if let line = formatRouteReasonGlobal(stageId: stage, reason: reasons[stage], route: route) {
                print("reason \(stage): \(line)")
            }
        }
    }

    for (entry, sessState) in orderedSessionStates(sessions: sessions) {
        let json = entry.json
        let project = ((json["cwd"] as? String).flatMap { $0.isEmpty ? nil : ($0 as NSString).lastPathComponent }) ?? "?"
        let fullSid = json["sessionId"] as? String ?? ""
        let sid = fullSid.isEmpty ? "--------" : String(fullSid.prefix(8))
        print("session \(sid) \(sessState.rawValue) \(project)")
    }
}

// CLI test hooks: run headless (no NSApplication) and exit before any
// GUI/state is touched. Accepts an optional leading sprite-root argument
// ahead of the flag, e.g. `claudemon-menubar <spriteRoot> --dump-state`.
let cliArgs = Array(CommandLine.arguments.dropFirst())
if let dumpLimitsIdx = cliArgs.firstIndex(of: "--dump-limits") {
    guard cliArgs.count > dumpLimitsIdx + 1 else {
        fputs("usage: claudemon-menubar [spriteRoot] --dump-limits <hud-cache-path>\n", stderr)
        exit(1)
    }
    dumpLimits(path: cliArgs[dumpLimitsIdx + 1])
    exit(0)
}
if cliArgs.contains("--dump-state") {
    dumpState()
    exit(0)
}

// GUI-mode test hook: `--demo-cutin [fromStage] [toStage]` plays one
// evolution cut-in right after launch, since a real one only fires up to 5
// times/day and can't be reproduced by hand on demand. Defaults to
// child -> ultimate when the stage args are omitted.
let demoCutIn: (from: String, to: String)? = {
    guard let idx = cliArgs.firstIndex(of: "--demo-cutin") else { return nil }
    let rest = Array(cliArgs[(idx + 1)...])
    let from = rest.count > 0 ? rest[0] : "child"
    let to = rest.count > 1 ? rest[1] : "ultimate"
    return (from, to)
}()

// Kill switch for the evolution cut-in overlay. The overlay is deliberately
// attention-grabbing, which is exactly wrong when you're heads-down in
// something else, so it has to be turnable off without a rebuild. Two ways,
// checked in this order:
//   --no-cutin              command line, wins over everything
//   --demo-cutin            forces it back ON, so the demo flag still works
//                           even if the env var below is set in your shell
//   CLAUDEMON_CUTIN=0       env var, for launch-at-login wrappers that can't
//                           pass flags (also accepts false/off/no)
// Only the big overlay is affected. The menu bar icon's own digivolve flash
// (startEvolutionBurst) and the dropdown portrait header stay as they are --
// those are opt-in by looking, so they don't break focus.
let cutInEnabled: Bool = {
    if cliArgs.contains("--no-cutin") { return false }
    if demoCutIn != nil { return true }
    switch ProcessInfo.processInfo.environment["CLAUDEMON_CUTIN"]?.lowercased() {
    case "0", "false", "off", "no": return false
    default: return true
    }
}()

// 알림 채널. center = 기존 UNUserNotificationCenter 경로, pet = 화면 왼쪽 아래 상주 펫 +
// 말풍선. 둘은 배타적이다 (동시에 쏘면 알림센터에 같은 내용이 쌓여 펫의 의미가 없어진다).
//
// 펫 모드가 있는 이유: 이 Mac 은 디스플레이가 항상 미러링 중이라고 macOS 가 믿는다
// (dndMirrored=True, InstantView). 그래서 배너가 전역적으로 억제되어 알림센터에는 쌓이지만
// 화면에는 절대 뜨지 않는다. 화면 위 오버레이 창은 이 억제를 우회한다.
enum NotifyMode: String {
    case center
    case pet

    var label: String {
        switch self {
        case .center: return "알림센터"
        case .pet: return "펫"
        }
    }
}

// 펫 창 전체를 끄는 킬 스위치. 상주 창은 컷인보다 더 눈에 띄므로 리빌드 없이 꺼져야 한다.
//   --demo-pet     펫 모드를 (저장하지 않고) 켜고 샘플 말풍선을 띄운다. 수동 테스트용
//   --no-pet       명령줄, 데모 외 모든 것에 우선
//   CLAUDEMON_PET=0  환경변수 (0/false/off/no)
// 꺼져 있으면 모드는 항상 center 이고 메뉴에 방식 선택도 나오지 않는다.
let demoPet: Bool = cliArgs.contains("--demo-pet")
let petEnabled: Bool = {
    if demoPet { return true }
    if cliArgs.contains("--no-pet") { return false }
    switch ProcessInfo.processInfo.environment["CLAUDEMON_PET"]?.lowercased() {
    case "0", "false", "off", "no": return false
    default: return true
    }
}()

func readSettingsJSON() -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: notifySettingsFile),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
    return json
}

// 파일이 없거나 값이 이상하면 center — 기존 동작이 기본값이다.
func readNotifyMode() -> NotifyMode {
    guard let raw = readSettingsJSON()["notifyMode"] as? String,
          let mode = NotifyMode(rawValue: raw) else { return .center }
    return mode
}

func writeNotifyMode(_ mode: NotifyMode) {
    writeSetting("notifyMode", mode.rawValue)
}

// 다른 키를 지우지 않도록 읽고-고쳐-쓴다. value 가 nil 이면 키를 지운다.
func writeSetting(_ key: String, _ value: Any?) {
    var json = readSettingsJSON()
    json[key] = value
    try? FileManager.default.createDirectory(atPath: claudemonDir, withIntermediateDirectories: true)
    guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted]) else { return }
    try? data.write(to: URL(fileURLWithPath: notifySettingsFile), options: .atomic)
}

// Draws `img` centered inside `box`, preserving aspect ratio (fit, never
// stretched or cropped), with nearest-neighbor scaling so pixel art stays
// crisp instead of the blur a plain NSImageView would produce.
// Edge of the square box both portrait surfaces (menu header, evolution
// cut-in) draw into. Sized to clear the largest portrait asset we ship at 1:1,
// because drawAspectFit only snaps to whole numbers when *enlarging* -- a box
// smaller than the art would shrink it by a fraction and bring back the wobbly
// outline this is all meant to avoid. The slack also buys the smallest assets a
// clean 2x: anything up to 104px on its long edge doubles instead of sitting
// tiny in the middle (keramon/portrait-adult is 78x84, the one that motivated
// this).
//
// Re-measure when adding portraits -- extending portraits to the branch nodes
// already moved the governing asset twice: keramon/portrait-superultimate
// (183x154) set the old 184, and agumon/portrait-perfect-rizegreymon (134x204)
// sets this one. Widest is still armagemon at 183.
let portraitBox: CGFloat = 208

func drawAspectFit(_ img: NSImage, in box: NSRect, pixelArt: Bool = true) {
    let srcSize = img.size
    guard srcSize.width > 0, srcSize.height > 0 else { return }

    let fitScale = min(box.width / srcSize.width, box.height / srcSize.height)

    // Pixel art requires integer scaling to avoid wobble; render art (artwork)
    // uses fractional scaling with smooth interpolation.
    let scale: CGFloat
    let interpolation: NSImageInterpolation

    if pixelArt {
        // Pixel art: floor to integer scale when enlarging, nearest-neighbor
        scale = fitScale > 1 ? floor(fitScale) : fitScale
        interpolation = .none
    } else {
        // Render art (artwork): fractional scale OK, smooth interpolation
        scale = fitScale
        interpolation = .high
    }

    let w = srcSize.width * scale
    let h = srcSize.height * scale
    let origin = NSPoint(x: box.minX + (box.width - w) / 2, y: box.minY + (box.height - h) / 2)
    NSGraphicsContext.current?.imageInterpolation = interpolation
    img.draw(in: NSRect(origin: origin, size: NSSize(width: w, height: h)), from: .zero, operation: .sourceOver, fraction: 1.0)
}

// NSView that draws a single NSImage aspect-fit via drawAspectFit(). Used by
// both the evolution cut-in overlay (work item A) and the menu's portrait
// header (work item B) so both share the same crisp pixel-art rendering.
// 큐 파일 하나의 내용. 문구는 전부 notify.js 가 정한다 — 이 앱은 전달만 한다.
struct NotifyRequest {
    let title: String
    let body: String
    let subtitle: String?
    let urgency: String
    let threadId: String?
    // 아래는 펫 모드의 클릭-포커스용. 없어도 알림은 뜬다 (포커스만 불가).
    let sessionId: String?
    let tmuxPane: String?
    let tmuxSocket: String?
    let kittyWindowId: String?
    let kittyListenOn: String?
}

// 형식이 어긋난 파일은 nil. 호출부는 nil 이든 아니든 파일을 지운다 — 파싱 못 하는
// 파일을 남겨두면 매 틱마다 같은 실패를 반복한다.
func parseNotifyRequest(path: String) -> NotifyRequest? {
    guard let data = FileManager.default.contents(atPath: path),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let title = json["title"] as? String,
          let body = json["body"] as? String else { return nil }
    return NotifyRequest(
        title: title,
        body: body,
        subtitle: json["subtitle"] as? String,
        urgency: (json["urgency"] as? String) ?? "normal",
        threadId: json["threadId"] as? String,
        sessionId: json["sessionId"] as? String,
        tmuxPane: json["tmuxPane"] as? String,
        tmuxSocket: json["tmuxSocket"] as? String,
        kittyWindowId: json["kittyWindowId"] as? String,
        kittyListenOn: json["kittyListenOn"] as? String
    )
}

// MARK: - 펫: 위치

// 펫 위치는 절대 좌표가 아니라 "메뉴바 화면 visibleFrame 의 가장 가까운 모서리 + 거기서의
// 오프셋" 으로 저장한다. 해상도·Dock·모니터 구성이 바뀌어도 펫이 같은 모서리 근처에 남는다.
// 기준은 펫 박스(스프라이트 판)다 — 말풍선 유무로 창 크기가 바뀌어도 위치가 흔들리지 않는다.
struct PetPosition: Equatable {
    var right: Bool
    var top: Bool
    var dx: CGFloat
    var dy: CGFloat

    // 저장값이 없을 때의 기본: 왼쪽 아래 16pt 여백.
    static let defaultPosition = PetPosition(right: false, top: false, dx: 16, dy: 16)

    var json: [String: Any] {
        return ["corner": (top ? "t" : "b") + (right ? "r" : "l"), "dx": Double(dx), "dy": Double(dy)]
    }

    static func parse(_ raw: Any?) -> PetPosition? {
        guard let dict = raw as? [String: Any], let corner = dict["corner"] as? String, corner.count == 2,
              let dx = dict["dx"] as? Double, let dy = dict["dy"] as? Double,
              dx.isFinite, dy.isFinite else { return nil }
        return PetPosition(right: corner.hasSuffix("r"), top: corner.hasPrefix("t"),
                           dx: CGFloat(dx), dy: CGFloat(dy))
    }
}

func readPetPosition() -> PetPosition {
    return PetPosition.parse(readSettingsJSON()["petPosition"]) ?? PetPosition.defaultPosition
}

// visible 안에 완전히 들어오도록 밀어 넣는다. 화면이 박스보다 작으면 왼쪽/아래를 우선한다.
func clampPetRect(_ rect: NSRect, into visible: NSRect) -> NSRect {
    let x = max(visible.minX, min(rect.origin.x, visible.maxX - rect.width))
    let y = max(visible.minY, min(rect.origin.y, visible.maxY - rect.height))
    return NSRect(x: x, y: y, width: rect.width, height: rect.height)
}

func petRect(for position: PetPosition, size: CGFloat, in visible: NSRect) -> NSRect {
    let x = position.right ? visible.maxX - position.dx - size : visible.minX + position.dx
    let y = position.top ? visible.maxY - position.dy - size : visible.minY + position.dy
    return clampPetRect(NSRect(x: x, y: y, width: size, height: size), into: visible)
}

// 놓은 자리에서 가장 가까운 모서리를 기준으로 삼고, 모서리에서 snap 거리 안이면 여백으로 붙인다.
func petAnchor(for rect: NSRect, in visible: NSRect, snap: CGFloat, margin: CGFloat) -> PetPosition {
    let right = rect.midX >= visible.midX
    let top = rect.midY >= visible.midY
    var dx = right ? visible.maxX - rect.maxX : rect.minX - visible.minX
    var dy = top ? visible.maxY - rect.maxY : rect.minY - visible.minY
    if dx < snap { dx = margin }
    if dy < snap { dy = margin }
    return PetPosition(right: right, top: top, dx: dx, dy: dy)
}

// 말풍선은 펫 위·오른쪽을 기본으로 하되, 화면 밖으로 나가면 아래로/왼쪽으로 뒤집는다.
func petBubbleRect(petRect: NSRect, size: NSSize, gap: CGFloat, in visible: NSRect) -> NSRect {
    let fitsAbove = petRect.maxY + gap + size.height <= visible.maxY
    let y = fitsAbove ? petRect.maxY + gap : max(visible.minY, petRect.minY - gap - size.height)
    let fitsRight = petRect.minX + size.width <= visible.maxX
    let x = fitsRight ? petRect.minX : max(visible.minX, petRect.maxX - size.width)
    return NSRect(x: x, y: y, width: size.width, height: size.height)
}

// MARK: - 펫: 세션별 알림 기록 (호버 목록)

// 펫 모드로 도착한 알림만 기록한다 (알림센터 모드의 알림은 펫이 본 적이 없다). 메모리에만 둔다.
struct PetMessage {
    let body: String
    let urgency: String
    let at: Date
}

struct PetSessionHistory {
    let key: String
    let sessionId: String?
    var title: String
    // 최신이 앞. 세션당 petHistoryDepth 개까지.
    var messages: [PetMessage]
    var lastAt: Date
    // 이 기록이 메모리에 처음 생긴 시각 (알림 시각 lastAt 과 다르다). GC 판정의 유예에 쓴다.
    let receivedAt: Date
    // 행 클릭 시 포커스에 쓰는 가장 최근 요청 (tmux/kitty 정보를 들고 있다).
    var request: NotifyRequest
}

// 세션을 가리키는 키. sessionId 가 정본이고, 없는 요청(수동 실행 등)은 threadId, 그것도 없으면
// 제목으로 묶는다.
func petHistoryKey(_ request: NotifyRequest) -> String {
    return request.sessionId ?? request.threadId ?? request.title
}

func relativeTimeLabel(from date: Date, to now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "방금" }
    if seconds < 3600 { return "\(seconds / 60)분 전" }
    if seconds < 86400 { return "\(seconds / 3600)시간 전" }
    return "\(seconds / 86400)일 전"
}

func makePetLabel(_ text: String, size: CGFloat, bold: Bool, color: NSColor, frame: NSRect) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    label.textColor = color
    label.lineBreakMode = .byTruncatingTail
    label.frame = frame
    return label
}

// MARK: - 펫: 클릭 → 세션 터미널 포커스

let tmuxCandidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]
let kittenCandidates = ["/Applications/kitty.app/Contents/MacOS/kitten",
                        "/opt/homebrew/bin/kitten", "/usr/local/bin/kitten"]
let kittyBundleId = "net.kovidgoyal.kitty"
let kittyProbeBudget: TimeInterval = 4

func firstExecutable(_ paths: [String]) -> String? {
    return paths.first { FileManager.default.isExecutableFile(atPath: $0) }
}

// 자식 프로세스를 돌리고 stdout 을 돌려준다. launchd 로 뜬 앱은 PATH 가 최소라 절대경로만
// 쓴다. stdout 을 파이프가 아니라 임시 파일로 받는 이유: kitten ls JSON 은 64KB 를 넘길
// 수 있고, 파이프는 읽기 전에 wait 하면 자식이 쓰다 막혀 타임아웃까지 멈춘다.
func runCommand(_ exe: String, _ args: [String], timeout: TimeInterval = 3) -> String? {
    let outPath = NSTemporaryDirectory() + "claudemon-cmd-" + UUID().uuidString
    guard FileManager.default.createFile(atPath: outPath, contents: nil),
          let outHandle = FileHandle(forWritingAtPath: outPath) else { return nil }
    defer { try? FileManager.default.removeItem(atPath: outPath) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: exe)
    process.arguments = args
    process.standardOutput = outHandle
    process.standardError = FileHandle.nullDevice
    let done = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in done.signal() }
    do { try process.run() } catch { return nil }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        process.terminate()
        return nil
    }
    guard process.terminationStatus == 0 else { return nil }
    return (FileManager.default.contents(atPath: outPath)).flatMap { String(data: $0, encoding: .utf8) }
}

struct TmuxFocusTarget {
    let session: String
    // 그 세션에 붙어 있는 tmux 클라이언트 pid 들. 비어 있으면 아무도 안 보고 있는 세션이다.
    let clientPids: [Int]
}

// 펫이 있는 pane 이 속한 세션을 찾고, 그 세션의 현재 window/pane 을 그 pane 으로 맞춘다.
//
// 회귀 방지 (2026-09): 여기서 `tmux switch-client -t <session>` 을 -c 없이 부르면 안 된다.
// -c 가 없으면 tmux 는 "가장 최근에 활동한 클라이언트" 를 대상으로 삼는데, 그게 지금 사용자가
// 치고 있는 kitty 창이다 — 클릭 한 번에 사용자의 창이 다른 세션으로 덮어써진다. 세션마다
// 클라이언트(=kitty 창)가 따로 붙어 있는 환경(클라이언트 10여 개)에서는 switch-client 자체가
// 필요 없다: select-window/select-pane 은 세션의 "현재" window/pane 을 바꾸므로 그 세션에 붙은
// 클라이언트가 알아서 그것을 보여준다. 그래서 클라이언트는 절대 옮기지 않고, 붙은 클라이언트
// pid 만 돌려줘 kitty 창 포커스(focusKittyWindow)에 쓴다.
func focusTmuxPane(pane: String, socket: String?) -> TmuxFocusTarget? {
    guard let tmux = firstExecutable(tmuxCandidates) else { return nil }
    let base = (socket?.isEmpty == false) ? ["-S", socket!] : []
    guard let rawSession = runCommand(tmux, base + ["display-message", "-p", "-t", pane, "#{session_name}"]) else {
        return nil
    }
    let session = rawSession.trimmingCharacters(in: .whitespacesAndNewlines)
    // 세션 이름은 tmux 출력에서 왔지만 인자로 다시 쓰므로 검증한다 (옵션으로 읽힐 "-" 시작 포함).
    guard !session.isEmpty, !session.contains("\n"), !session.contains("\r"), !session.hasPrefix("-") else {
        return nil
    }
    _ = runCommand(tmux, base + ["select-window", "-t", pane])
    _ = runCommand(tmux, base + ["select-pane", "-t", pane])
    guard let clients = runCommand(tmux, base + ["list-clients", "-F", "#{client_pid} #{client_session}"]) else {
        return TmuxFocusTarget(session: session, clientPids: [])
    }
    let pids: [Int] = clients.split(separator: "\n").compactMap { line in
        let parts = line.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, String(parts[1]) == session else { return nil }
        return Int(parts[0])
    }
    return TmuxFocusTarget(session: session, clientPids: pids)
}

// 붙은 클라이언트가 없는 세션: 기존 클라이언트를 가로채지 않고 새 kitty OS 창을 그 세션에
// attach 시켜 띄운다. 원격제어가 안 되면 아무것도 하지 않는다 (호출부가 kitty 만 앞으로 가져온다).
func openKittyWindowAttached(session: String, socket: String?, listenOn: String?) {
    guard let kitten = firstExecutable(kittenCandidates), let tmux = firstExecutable(tmuxCandidates) else { return }
    let tmuxArgs = ((socket?.isEmpty == false) ? ["-S", socket!] : []) + ["attach", "-t", "=" + session]
    let deadline = Date().addingTimeInterval(kittyProbeBudget)
    for target in kittySocketTargets(listenOn: listenOn) {
        if Date() > deadline { return }
        if runCommand(kitten, ["@", "--to", target, "launch", "--type=os-window", tmux] + tmuxArgs,
                      timeout: 1.5) != nil { return }
    }
}

func kittySocketTargets(listenOn: String?) -> [String] {
    var targets: [String] = []
    if let listenOn = listenOn, listenOn.hasPrefix("unix:/") { targets.append(listenOn) }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: "/tmp")) ?? []
    for name in names.sorted() where name.hasPrefix("kitty") {
        let path = "/tmp/" + name
        let type = (try? FileManager.default.attributesOfItem(atPath: path))?[.type] as? FileAttributeType
        if type == .typeSocket, !targets.contains("unix:" + path) { targets.append("unix:" + path) }
    }
    return targets
}

// kitten @ ls 의 os_window > tab > window 를 (id, foreground pid 들) 목록으로 편다.
func kittyWindows(in json: [[String: Any]]) -> [(id: Int, pids: [Int])] {
    var result: [(id: Int, pids: [Int])] = []
    for osWindow in json {
        for tab in osWindow["tabs"] as? [[String: Any]] ?? [] {
            for window in tab["windows"] as? [[String: Any]] ?? [] {
                guard let id = window["id"] as? Int else { continue }
                let procs = window["foreground_processes"] as? [[String: Any]] ?? []
                result.append((id, procs.compactMap { $0["pid"] as? Int }))
            }
        }
    }
    return result
}

// 창을 못 정하면 아무것도 안 한다 — 엉뚱한 kitty 창으로 포커스가 튀는 것보다 낫다.
// windowId 는 tmux 밖일 때만 믿는다 (tmux 안의 KITTY_WINDOW_ID 는 서버를 처음 띄운 창이다).
func focusKittyWindow(matchPids: [Int], fallbackWindowId: Int?, listenOn: String?) {
    guard let kitten = firstExecutable(kittenCandidates) else { return }
    // 죽은 소켓이 여럿이어도 전체 탐색이 kittyProbeBudget 을 넘기지 않는다.
    let deadline = Date().addingTimeInterval(kittyProbeBudget)
    for target in kittySocketTargets(listenOn: listenOn) {
        if Date() > deadline { return }
        guard let out = runCommand(kitten, ["@", "--to", target, "ls"], timeout: 1.5),
              let data = out.data(using: .utf8),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { continue }
        let windows = kittyWindows(in: json)
        let byPid = windows.first { !Set($0.pids).isDisjoint(with: matchPids) }?.id
        let byId = windows.first { $0.id == fallbackWindowId }?.id
        guard let id = byPid ?? byId else { continue }
        _ = runCommand(kitten, ["@", "--to", target, "focus-window", "--match", "id:\(id)"])
        return
    }
}

func isTmuxPaneId(_ value: String?) -> Bool {
    guard let value = value else { return false }
    return value.range(of: "^%[0-9]+$", options: .regularExpression) != nil
}

func parseKittyWindowId(_ value: String?) -> Int? {
    guard let value = value, value.range(of: "^[0-9]+$", options: .regularExpression) != nil else { return nil }
    return Int(value)
}

// 백그라운드 큐에서 부른다. 어느 단계가 실패해도 조용히 넘어간다 — 포커스는 편의 기능이다.
func focusSessionTerminal(_ request: NotifyRequest) {
    // 큐 파일은 외부 입력이라 tmux/kitten 인자로 쓰기 전에 형식을 검증한다.
    let pane = isTmuxPaneId(request.tmuxPane) ? request.tmuxPane! : ""
    let socket = (request.tmuxSocket?.hasPrefix("/") == true) ? request.tmuxSocket : nil
    let tmuxTarget = pane.isEmpty ? nil : focusTmuxPane(pane: pane, socket: socket)
    if let target = tmuxTarget, target.clientPids.isEmpty {
        openKittyWindowAttached(session: target.session, socket: socket, listenOn: request.kittyListenOn)
    } else {
        let fallbackId = pane.isEmpty ? parseKittyWindowId(request.kittyWindowId) : nil
        focusKittyWindow(matchPids: tmuxTarget?.clientPids ?? [], fallbackWindowId: fallbackId,
                         listenOn: request.kittyListenOn)
    }
    // 앱 활성화는 마지막에. macOS 14 부터 NSRunningApplication.activate 는 다른 앱을 앞으로
    // 못 가져오므로 open 에 맡긴다. kitten 의 focus-window 는 kitty 안의 포커스만 옮긴다.
    _ = runCommand("/usr/bin/open", ["-b", kittyBundleId])
}

// 키/메인 윈도우가 되지 않는다 — 클릭해도 사용자가 치던 창의 키 포커스를 뺏지 않는다.
final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// 펫 창의 루트 뷰. 창은 nonactivating 이라 클릭해도 키 포커스를 뺏지 않는다. 자식(스프라이트,
// 말풍선 라벨)이 mouseDown 을 각자 처리하지 않도록 히트 테스트를 여기서 가로챈다. 자식 영역
// 밖(투명한 빈 모서리)은 nil 을 돌려줘 클릭이 먹히지 않는다.
final class PetClickView: NSView {
    var onClick: (() -> Void)?
    var onDragEnd: (() -> Void)?
    var onDragStart: (() -> Void)?
    var onHoverEnter: (() -> Void)?
    var onHoverExit: (() -> Void)?
    // 호버 목록을 여는 영역 (펫 박스). 말풍선 위에서는 열지 않는다. 창이 활성화되지 않아도
    // 동작하도록 .activeAlways 로 건다.
    var hoverRect = NSRect.zero { didSet { updateTrackingAreas() } }
    // 레이아웃이 드래그 중인 창을 되돌리지 않도록 밖에서 읽는다.
    private(set) var isDragging = false
    private var pressMouse = NSPoint.zero
    private var pressOrigin = NSPoint.zero
    private var didDrag = false
    // 이보다 덜 움직이면 클릭이다. 손이 살짝 떨린 클릭이 드래그로 먹히면 포커스가 안 된다.
    static let dragThreshold: CGFloat = 4

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        for area in trackingAreas { removeTrackingArea(area) }
        if hoverRect.isEmpty { return }
        addTrackingArea(NSTrackingArea(rect: hoverRect, options: [.activeAlways, .mouseEnteredAndExited],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { onHoverEnter?() }
    override func mouseExited(with event: NSEvent) { onHoverExit?() }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return subviews.contains { !$0.isHidden && $0.frame.contains(local) } ? self : nil
    }

    // 창이 움직이는 동안 뷰 좌표는 계속 변하므로 이벤트 좌표 대신 화면 좌표로 델타를 잡는다.
    override func mouseDown(with event: NSEvent) {
        pressMouse = NSEvent.mouseLocation
        pressOrigin = window?.frame.origin ?? .zero
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        let now = NSEvent.mouseLocation
        let dx = now.x - pressMouse.x
        let dy = now.y - pressMouse.y
        if !didDrag && hypot(dx, dy) < PetClickView.dragThreshold { return }
        if !didDrag { onDragStart?() }
        didDrag = true
        isDragging = true
        window?.setFrameOrigin(NSPoint(x: pressOrigin.x + dx, y: pressOrigin.y + dy))
    }

    // 드래그는 절대 포커스를 트리거하지 않는다.
    override func mouseUp(with event: NSEvent) {
        if didDrag {
            isDragging = false
            didDrag = false
            onDragEnd?()
        } else {
            onClick?()
        }
    }
}

// 호버 목록 창의 루트. 펫→목록으로 마우스를 옮길 때 닫히지 않도록 창 전체의 출입을 알린다.
final class PetHoverView: NSView {
    var onEnter: (() -> Void)?
    var onExit: (() -> Void)?

    override func updateTrackingAreas() {
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func mouseExited(with event: NSEvent) { onExit?() }
}

// 목록의 한 행. 자식 라벨이 클릭을 삼키지 않도록 히트 테스트를 가로챈다.
final class PetRowView: NSView {
    var onClick: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        return bounds.contains(convert(point, from: superview)) ? self : nil
    }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { onClick?() }
}

// 메뉴에 그대로 띄우는 문자열. 권한이 조용히 꺼져 있는 것이 이 기능의 가장 흔한
// 고장이므로 상태를 사람이 볼 수 있는 곳에 노출한다.
func notifyAuthLabel(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "허용됨"
    case .provisional: return "임시 허용"
    case .denied: return "거부됨 — 시스템 설정에서 켜야 한다"
    case .notDetermined: return "미결정"
    @unknown default: return "알 수 없음"
    }
}

func notifyAuthGranted(_ status: UNAuthorizationStatus) -> Bool {
    return status == .authorized || status == .provisional
}

// Global versions of format functions for --dump-state (headless) path.
// Identical to AppDelegate instance methods but callable without GUI context.

func formatRouteReasonGlobal(stageId: String, reason: [String: Any]?, route: [String: [String: String]]) -> String? {
    guard let reason = reason,
          let stageName = route[stageId]?["name"],
          let candidates = reason["candidates"] as? [[String: Any]],
          let probability = reason["probability"] as? Double,
          let ctx = reason["ctx"] as? [String: Any] else { return nil }

    let stageLabel = stageLabels[stageId] ?? stageId
    let candidateCount = candidates.count

    // Find conditions that were satisfied (weight == 8, the CONDITION_EDGE_WEIGHT)
    let metConditionLabels = candidates.compactMap { c -> String? in
        guard let weight = c["weight"] as? Int, weight == 8,
              let when = c["when"] as? [String: Any] else { return nil }
        return formatConditionGlobal(when, ctx: ctx)
    }

    let uniqueLabels = Array(Set(metConditionLabels))
    let conditionText: String
    if uniqueLabels.isEmpty {
        conditionText = ""
    } else if uniqueLabels.count == 1 {
        conditionText = "\(uniqueLabels[0]) ×8"
    } else {
        conditionText = uniqueLabels.joined(separator: ", ") + " ×8"
    }

    let probPct = Int(probability * 100)

    if conditionText.isEmpty {
        return "\(stageLabel) · \(stageName) (후보 \(candidateCount), 확률 \(probPct)%)"
    } else {
        return "\(stageLabel) · \(stageName) ← (\(conditionText), 후보 \(candidateCount), 확률 \(probPct)%)"
    }
}

func formatConditionGlobal(_ when: [String: Any], ctx: [String: Any]) -> String? {
    // Handle "all" array (nested conditions)
    if let allConds = when["all"] as? [[String: Any]] {
        let labels = allConds.compactMap { formatConditionGlobal($0, ctx: ctx) }
        return labels.isEmpty ? nil : labels.joined(separator: " + ")
    }

    // Standard {type, gte/lte} form
    guard let type = when["type"] as? String else { return nil }

    // Map axis type to Korean label
    let axisName: String
    switch type {
    case "sessionCount": axisName = "세션 수"
    case "dailyUserTurns": axisName = "유저 턴"
    case "outputPerTurn": axisName = "턴당 출력"
    case "topSharePct": axisName = "최다 세션 비중"
    case "failureRatioPct": axisName = "실패율"
    default: axisName = type  // Unknown axes: use raw key
    }

    // Get actual value from ctx
    let actualStr: String
    if let intVal = ctx[type] as? Int {
        actualStr = "\(intVal)"
    } else if let doubleVal = ctx[type] as? Double {
        actualStr = String(format: "%.1f", doubleVal)
    } else {
        actualStr = "?"
    }

    // Get threshold and comparison
    if let threshold = when["gte"] as? Int {
        return "\(axisName) \(actualStr) ≥ \(threshold)"
    } else if let threshold = when["lte"] as? Int {
        return "\(axisName) \(actualStr) ≤ \(threshold)"
    }

    // Fallback: just axis name if threshold format is unknown
    return axisName
}

final class PixelArtView: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var isPixelArt: Bool = true { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        guard let image = image else { return }
        drawAspectFit(image, in: bounds, pixelArt: isPixelArt)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var stageFrames: [String: [NSImage]] = [:]
    // Large-format portraits for the evolution cut-in (A) and menu header
    // (B). Loaded at native resolution -- see loadImageSequence(size:) --
    // since the two callers fit them into differently-sized boxes.
    // Populated only for stages that actually have portrait-<stage>-N.png
    // assets in the pack; missing stages fall back via portraitImage(forStage:).
    var portraitFrames: [String: [NSImage]] = [:]
    // Official artwork (anti-aliased render art, not pixel art). Single frame
    // per stage, loaded as artwork-<stage>-0.png. Prioritized over portraits
    // when available, unless CLAUDEMON_ARTWORK_PORTRAIT=0 kill switch is set.
    var artworkFrames: [String: [NSImage]] = [:]
    var limitFrameSets: [String: [NSImage]] = [:] // "limit80" / "limit95" -> frames
    var idleFrames: [NSImage] = []
    var currentFrames: [NSImage] = []
    var currentFrameSetKey = ""
    var frameIdx = 0
    var currentStageId = "digitama"
    // Non-nil when today's route ends before the top stage (D7 clamp in
    // lib/daily.js) -- the stageId the lineage's terminal node sits at.
    // Compared against currentStageId to decide whether to show the
    // "이 계보의 최종형" header badge (see makeHeaderMenuItem).
    var currentTerminalFrom: String? = nil
    var currentMon = ""
    var currentPackPath = ""
    var dailyOutputTokens = 0
    // Route reasons explaining why each stage was chosen (from lib/daily.js).
    // nil means the field is absent (pre-route-reasons daily.json).
    var currentRouteReasons: [String: [String: Any]]? = nil
    var currentRoute: [String: [String: String]] = [:]
    var workingSessionCount = 0
    var currentLimitLevel: String? = nil
    var rateLimitMenuLines: [String] = []
    var animationPaused = false
    var evolutionTimer: Timer? = nil
    var lastSessions: [SessionEntry] = []
    // Winning state across all registered sessions (see globalState()).
    // Feeds the sprite override slot (overrideFrameLevel) alongside the
    // rate-limit level; defaults to .idle so a pre-refreshState frame load
    // behaves exactly like "no override" did before this existed.
    var currentSessionState: SessionState = .idle
    var sessionTokens: [String: Int] = [:]

    // 첫 실행에서 requestAuthorization 의 콜백을 신뢰할 수 없다. macOS 26 실측:
    // 권한 다이얼로그가 떠 있는 동안 콜백이 UNErrorDomain Code=1
    // ("Notifications are not allowed for this application") 로 먼저 반환되고,
    // 그 뒤 사용자가 허용을 누르면 권한은 정상 기록된다. 즉 콜백의 granted 는
    // "아직 모른다" 와 "거부됨" 을 구분하지 못한다. 그래서 콜백 결과를 상태로 쓰지
    // 않고 getNotificationSettings 를 2초 틱에서 폴링해 갱신한다.
    var notifyAuthStatus: UNAuthorizationStatus = .notDetermined

    // Focused-session info: purely informational (one line in the menu),
    // resolved the same way as before via active-session.sh. Does not
    // drive the sprite or the animation state anymore.
    var focusedSessionState: [String: Any] = [:]
    var focusedUnregistered = false
    var focusedLastResolvedPath = ""
    // Guards against multiple concurrent resolveActiveSessionPath() calls
    // stacking up when the script is slow. Read/write only on main thread.
    var isFocusedSessionRefreshInFlight = false
    // Counts refreshState() ticks so the focused-session resolver can run on
    // a slower cadence than the 2s state refresh (every 3rd tick, ~6s).
    var focusedSessionRefreshTick = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let daily = readDailyState()
        currentStageId = daily.stageId
        currentTerminalFrom = daily.terminalFrom
        dailyOutputTokens = daily.outputTokens
        currentRouteReasons = daily.routeReasons
        currentRoute = daily.route
        _ = applyRoute(daily.route, mon: daily.mon)
        switchMonIfNeeded(daily.mon)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageOnly
        runDailyTokensAggregator()
        refreshState()
        advanceFrame()

        if let demo = demoCutIn {
            startEvolutionCutIn(fromStage: demo.from, toStage: demo.to,
                                 name: evolvedName(pack: currentPackPath, mon: currentMon, stageId: demo.to))
        }

        setupNotifications()
        notifyMode = petEnabled ? (demoPet ? .pet : readNotifyMode()) : .center
        petPosition = readPetPosition()
        applyNotifyMode()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.layoutPetPanel()
        }
        if demoPet {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.seedDemoPetHistory()
            }
        }

        Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            self?.advanceFrame()
        }
        // 알림 큐 배수는 상태 갱신(2초)보다 빨라야 한다 — "입력 대기" 는 사용자가
        // 기다리는 신호이므로 지연이 그대로 체감된다. 빈 디렉터리 readdir 이라 싸다.
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.drainNotifyQueue()
        }
        // active-session.sh re-resolves which kitty window/tmux pane/claude
        // process is focused; polling is simpler and more robust than a vnode
        // watch across a file that keeps getting replaced (both the resolved
        // session file and the resolution target itself can change between
        // ticks). Session files and rate limits refresh on every 2s tick; the
        // resolver script is far slower, so it only runs every 3rd tick (~6s),
        // off the main thread.
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refreshState()
            self?.refreshNotifyAuth()
            self?.writeNotifyHeartbeat()
        }
        // Keeps daily.json fresh. Runs independently of the 2s refresh tick
        // since aggregation (reading every session transcript for today)
        // is heavier than a handful of small JSON file reads.
        Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { _ in
            runDailyTokensAggregator()
        }
    }

    // Loads `<prefix>-0.png`, `<prefix>-1.png`, ... until one is missing.
    // `size` forces the NSImage's logical size (default: the menu bar's
    // 32px-bitmap-at-16pt convention, unchanged from before); pass `nil` to
    // keep each image's native size instead -- used for portraits, where
    // stretching to a fixed square would distort non-square art and the
    // target box differs by caller (cut-in vs. menu header).
    func loadImageSequence(inDir dir: String, prefix: String, size: NSSize? = NSSize(width: 16, height: 16)) -> [NSImage] {
        var result: [NSImage] = []
        var i = 0
        while let img = NSImage(contentsOfFile: "\(dir)/\(prefix)-\(i).png") {
            // 32px bitmap shown at 16pt -> 1:1 physical pixels on retina
            if let size = size {
                img.size = size
            }
            result.append(img)
            i += 1
        }
        return result
    }

    // Loads the full frame set (idle/stages/limit overrides) from `pack`.
    // Returns false without mutating any existing state if the pack has no
    // idle frames at all, so a failed switch never leaves the mascot with a
    // half-loaded, mismatched frame set.
    @discardableResult
    func loadFrames(fromPack pack: String, mon: String) -> Bool {
        let idle = loadImageSequence(inDir: pack, prefix: "idle")
        guard !idle.isEmpty else { return false }

        idleFrames = idle
        var newStageFrames: [String: [NSImage]] = [:]
        // stageIds runs low to high, so `previous` always holds the frames of
        // the highest stage this pack does have art for. A stage with no art
        // of its own inherits those rather than the idle (성장기) sprite:
        // idle would read as the mascot *de-evolving* at the exact moment it
        // just evolved, which is what happened when a stage was added to the
        // tree ahead of its sprites.
        var previous = idle
        let spineIds = spineNodeIds(forPack: pack)
        for stage in stageIds {
            let isShared = sharedStages.contains(stage)
            // The route may point this stage at a branch's own files
            // (e.g. adult-geogreymon-*.png); the spine keeps the plain
            // <stage>-*.png names.
            let prefix = activeRouteSprites[stage] ?? stage
            var frames: [NSImage] = []
            if isShared {
                frames = loadImageSequence(inDir: sharedSpriteDir, prefix: stage)
            }
            if frames.isEmpty {
                frames = loadImageSequence(inDir: pack, prefix: prefix)
            }
            if frames.isEmpty && !isShared {
                // Dots live in sprites/nodes/ and are copied into packs by
                // scripts/materialize-sprites.js; read them from there when
                // the pack copy is missing.
                frames = loadImageSequence(inDir: spriteRoot + "/nodes", prefix: prefix)
            }
            // The spine file only stands in for the spine's own species. For
            // a branched route stage it would show a different digimon than
            // the artwork, so those fall through to `previous` instead.
            if frames.isEmpty && prefix != stage {
                let routeId = activeRouteIds[stage] ?? ""
                if spineIds[stage]?.contains(routeId) ?? false {
                    frames = loadImageSequence(inDir: pack, prefix: stage)
                }
            }
            if frames.isEmpty {
                frames = previous
            } else if !isShared {
                // The Digi-Egg is species-agnostic, so it is never what a
                // later stage should inherit - only real forms of this
                // pack's line become the fallback for the stage above.
                previous = frames
            }
            newStageFrames[stage] = frames
        }
        stageFrames = newStageFrames

        // Optional big-format portraits (portrait-<prefix>-0.png, -1.png).
        // Native size (size: nil) since callers fit these into their own
        // boxes; a stage with no portrait assets simply gets no entry here,
        // and portraitImage(forStage:) falls back to an upscaled stage frame.
        // Official artwork (anti-aliased render art): artwork-<prefix>-0.png only.
        // Prioritized over pixel portraits when CLAUDEMON_ARTWORK_PORTRAIT != "0".
        // Artwork lives in the shared sprites/nodes/ directory (not per-pack) to avoid
        // duplicating 46MB across 10 packs. Pack-specific artwork can still override
        // the shared artwork if present.
        var newArtworkFrames: [String: [NSImage]] = [:]
        let artworkEnabled = ProcessInfo.processInfo.environment["CLAUDEMON_ARTWORK_PORTRAIT"] != "0"
        if artworkEnabled {
            for stage in stageIds {
                let prefix = activeRouteSprites[stage] ?? stage
                var artwork = loadImageSequence(inDir: pack, prefix: "artwork-\(prefix)", size: nil)
                if artwork.isEmpty {
                    // Fallback: shared nodes directory
                    let sharedNodesDir = spriteRoot + "/nodes"
                    artwork = loadImageSequence(inDir: sharedNodesDir, prefix: "artwork-\(prefix)", size: nil)
                }
                if !artwork.isEmpty {
                    newArtworkFrames[stage] = artwork
                }
            }
        }
        artworkFrames = newArtworkFrames

        var newPortraitFrames: [String: [NSImage]] = [:]
        for stage in stageIds {
            // Route-aware, exactly like the stage frames above: on a branch
            // day this must load portrait-adult-geogreymon-*, not the spine's.
            // Deliberately WITHOUT their spine fallback though -- borrowing
            // 그레이몬's portrait for 지오그레이몬 would put a different digimon
            // in the drop-down than the one in the menu bar. With no entry,
            // portraitImage(forStage:) upscales the dot that is actually on
            // screen, which is always the right species.
            let prefix = activeRouteSprites[stage] ?? stage
            let frames = loadImageSequence(inDir: pack, prefix: "portrait-\(prefix)", size: nil)
            if !frames.isEmpty {
                newPortraitFrames[stage] = frames
            }
        }
        portraitFrames = newPortraitFrames

        // Optional behavior-override sprite sets. If the corresponding
        // files don't exist yet, the array is simply empty and
        // framesForLevel() falls back to the stage frames.
        limitFrameSets["limit80"] = loadImageSequence(inDir: pack, prefix: "limit80")
        limitFrameSets["limit95"] = loadImageSequence(inDir: pack, prefix: "limit95")

        currentMon = mon
        currentPackPath = pack
        // Force applyFrameSet() to recompute currentFrames against the
        // newly loaded sets on the next call, even if the stage/limit key
        // itself didn't change.
        currentFrameSetKey = ""
        let level = overrideFrameLevel(limitLevel: currentLimitLevel, sessionState: currentSessionState)
        currentFrames = framesForLevel(level, stage: currentStageId)
        frameIdx = 0
        return true
    }

    // Switches the active pack when the daily-selected mon changes (or on
    // first load). Fallback chain: requested pack -> guilmon pack -> keep
    // whatever frames are already loaded (never crash after startup). Only
    // a totally failed first load (no prior frames at all) is fatal.
    func switchMonIfNeeded(_ mon: String, routeChanged: Bool = false) {
        let resolved = resolvePack(for: mon)
        guard resolved.mon != currentMon || stageFrames.isEmpty || routeChanged else { return }

        if loadFrames(fromPack: resolved.path, mon: resolved.mon) { return }

        if !stageFrames.isEmpty {
            fputs("claudemon-menubar: pack '\(resolved.mon)' at \(resolved.path) failed to load, keeping current frames\n", stderr)
            return
        }
        fputs("claudemon-menubar: no usable sprite pack found for mon '\(mon)' (tried \(resolved.path))\n", stderr)
        exit(1)
    }

    // Big-format portrait for `stage`: prefers a real portrait-<stage>-0.png
    // from the current pack; falls back to a 4x nearest-neighbor upscale of
    // the regular 32px stage sprite. The fallback matters right now because
    // portrait assets only exist for adult/perfect/ultimate (and extraction
    // may not have run yet for every pack) -- the cut-in (A) and menu header
    // (B) both need to work regardless.
    //
    // Priority: artwork (render art) → portrait (pixel art) → dot upscale.
    // Artwork kill switch: CLAUDEMON_ARTWORK_PORTRAIT=0 skips artwork tier.
    // Returns (image, isPixelArt) tuple for correct interpolation in drawAspectFit.
    func portraitImage(forStage stage: String) -> (NSImage?, Bool) {
        // Artwork: anti-aliased render art, no upscaling needed
        if let img = artworkFrames[stage]?.first {
            return (img, false)  // Not pixel art
        }
        // Portrait: native-resolution pixel art
        if let img = portraitFrames[stage]?.first {
            return (img, true)  // Pixel art
        }
        // Fallback: upscale 32px dot with nearest-neighbor
        guard let base = stageFrames[stage]?.first ?? idleFrames.first else {
            return (nil, true)
        }
        let longEdge = max(base.size.width, base.size.height)
        let factor = longEdge > 0 ? max(1, floor(portraitBox / longEdge)) : 1
        return (upscaledNearestNeighbor(base, factor: factor), true)  // Pixel art
    }

    // Nearest-neighbor integer upscale so pixel art doesn't blur.
    // imageInterpolation = .none must be set on the *destination* context
    // before drawing -- without it AppKit defaults to smooth resampling and
    // the result comes out mushy instead of crisp.
    func upscaledNearestNeighbor(_ img: NSImage, factor: CGFloat) -> NSImage {
        let outSize = NSSize(width: img.size.width * factor, height: img.size.height * factor)
        let out = NSImage(size: outSize)
        out.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .none
        img.draw(in: NSRect(origin: .zero, size: outSize), from: .zero, operation: .sourceOver, fraction: 1.0)
        out.unlockFocus()
        return out
    }

    // Picks the frames to display for a resolved override key (from
    // overrideFrameLevel: nil, "limit80", "limit95", "waitingUser", or
    // "stalled").
    //
    // For genericOverrideStages (digitama/baby/child), the pack's generic
    // override sprites are the right species, so we use them directly:
    // limit80/limit95 use their own pack-provided sprites when available;
    // "waitingUser" reuses the pack's generic idle frames (visually distinct
    // from a frozen stage frame); "stalled" reuses the limit80 sprite as a
    // generic "paused, needs attention" look. Any override whose sprites
    // aren't in this pack -- or no override at all -- falls back to the
    // current evolution-stage frames.
    //
    // For adult/perfect/ultimate the generic sprites are the wrong species
    // (they're all drawn from the Rookie sheet), so instead we tint the
    // current stage frames to signal the override state while keeping the
    // correct species on screen.
    func framesForLevel(_ level: String?, stage: String) -> [NSImage] {
        if genericOverrideStages.contains(stage) {
            if level == "limit80" || level == "limit95", let frames = limitFrameSets[level!], !frames.isEmpty {
                return frames
            }
            if level == "waitingUser" {
                return idleFrames
            }
            if level == "stalled", let frames = limitFrameSets["limit80"], !frames.isEmpty {
                return frames
            }
            return stageFrames[stage] ?? idleFrames
        }

        let base = stageFrames[stage] ?? idleFrames
        switch level {
        case "waitingUser":
            return tinted(base, NSColor.systemYellow, 0.25)
        case "stalled":
            return tinted(base, NSColor.gray, 0.45)
        case "limit80":
            return tinted(base, NSColor.black, 0.35)
        case "limit95":
            return tinted(base, NSColor.systemRed, 0.40)
        default:
            return base
        }
    }

    func advanceFrame() {
        guard !currentFrames.isEmpty else { return }
        // Evolution burst owns the button image while it runs.
        if evolutionTimer != nil { return }
        if animationPaused {
            // Pin to frame 0 so "all sessions idle" reads as "stopped", not
            // just paused mid-animation.
            frameIdx = 0
            statusItem.button?.image = currentFrames[0]
            petSpriteView?.image = currentFrames[0]
            return
        }
        let frame = currentFrames[frameIdx % currentFrames.count]
        statusItem.button?.image = frame
        petSpriteView?.image = frame
        frameIdx += 1
    }

    // Runs active-session.sh and returns the trimmed path it prints, or nil
    // if the script is missing, not executable, or exits non-zero.
    func resolveActiveSessionPath() -> String? {
        guard FileManager.default.isExecutableFile(atPath: resolverScript) else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: resolverScript)
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }

        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Resolves the focused session for display purposes only. "unknown:"
    // (a claude process is visible but hasn't registered a session file
    // yet) is tracked separately so the menu can say so instead of
    // borrowing another session's info.
    // Runs active-session.sh on a background queue to avoid blocking the
    // main thread, then updates state back on main. Skips if a previous
    // call is still in flight.
    func refreshFocusedSession() {
        // In-flight guard: skip if previous call hasn't finished yet.
        // Prevents queue buildup when the script is slow.
        guard !isFocusedSessionRefreshInFlight else { return }
        isFocusedSessionRefreshInFlight = true

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }

            // Run subprocess and parse result on background thread
            let resolvedPath = self.resolveActiveSessionPath()

            // Update state on main thread
            DispatchQueue.main.async {
                self.isFocusedSessionRefreshInFlight = false

                guard let path = resolvedPath else {
                    self.focusedUnregistered = false
                    self.rebuildMenu()
                    return
                }

                if path.hasPrefix("unknown:") {
                    self.focusedUnregistered = true
                    self.focusedSessionState = [:]
                    self.focusedLastResolvedPath = ""
                    self.rebuildMenu()
                    return
                }

                guard let data = FileManager.default.contents(atPath: path),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else {
                    // Resolved path unreadable/malformed: keep the last good info.
                    return
                }

                self.focusedUnregistered = false
                self.focusedSessionState = json
                self.focusedLastResolvedPath = path
                self.rebuildMenu()
            }
        }
    }

    func refreshState() {
        // Daily global stage — independent of whichever session is focused.
        let daily = readDailyState()
        let previousStageId = currentStageId
        let previousMon = currentMon
        currentStageId = daily.stageId
        currentTerminalFrom = daily.terminalFrom
        dailyOutputTokens = daily.outputTokens
        sessionTokens = daily.sessionTokens
        currentRouteReasons = daily.routeReasons
        currentRoute = daily.route
        switchMonIfNeeded(daily.mon, routeChanged: applyRoute(daily.route, mon: daily.mon))

        // Evolution burst: same mon moved UP a stage -> flash old/new forms
        // for a few seconds, classic digivolve style. Mon switches (daily
        // rollover back to the egg) and downgrades don't get one.
        if currentMon == previousMon,
           let oldIdx = stageIds.firstIndex(of: previousStageId),
           let newIdx = stageIds.firstIndex(of: daily.stageId),
           newIdx > oldIdx,
           let oldFrames = stageFrames[previousStageId],
           let newFrames = stageFrames[daily.stageId] {
            startEvolutionBurst(from: oldFrames, to: newFrames)
            startEvolutionCutIn(fromStage: previousStageId, toStage: daily.stageId,
                                 name: evolvedName(pack: currentPackPath, mon: currentMon, stageId: daily.stageId))
        }

        // Global session-state judgment across all registered sessions.
        // The mascot animates for .working or .waitingUser -- everything
        // else (.stalled, .idle) freezes on frame 0, same rule as before
        // this existed, just driven by the richer state now.
        let sessions = scanSessions(dir: sessionsDir)
        lastSessions = sessions
        let (state, workingCount) = globalWorkingState(sessions: sessions, fallbackGlobalPath: globalStateFile)
        currentSessionState = state
        animationPaused = !(state == .working || state == .waitingUser)
        workingSessionCount = workingCount
        expirePetBubbleIfResolved()
        prunePetHistory()
        if notifyMode == .pet { layoutPetPanel() }
        if petListVisible { refreshPetList() }

        updateRateLimits(sessions: sessions)

        // Focused session refresh: only every 3 ticks (~6s) to reduce overhead.
        // active-session.sh is slow (~700ms), so polling it every 2s would keep
        // the main thread blocked 35% of the time.
        focusedSessionRefreshTick += 1
        if focusedSessionRefreshTick % 3 == 0 {
            refreshFocusedSession()
        }

        applyFrameSet()
        rebuildMenu()
    }

    // Fills the sprite's opaque pixels with white — the classic digivolve
    // "glowing silhouette". sourceAtop keeps the alpha mask intact.
    func whiteSilhouette(of img: NSImage) -> NSImage {
        let out = NSImage(size: img.size)
        out.lockFocus()
        img.draw(in: NSRect(origin: .zero, size: img.size))
        NSColor.white.set()
        NSRect(origin: .zero, size: img.size).fill(using: .sourceAtop)
        out.unlockFocus()
        return out
    }

    // Tints a sprite's opaque pixels with `color` at `alpha`, sourceAtop so
    // the alpha mask is preserved. Used to distinguish override states
    // (waitingUser/stalled/limit80/limit95) on evolved stages that have no
    // matching generic override sprite -- see framesForLevel.
    func tinted(_ img: NSImage, _ color: NSColor, _ alpha: CGFloat) -> NSImage {
        let out = NSImage(size: img.size)
        out.lockFocus()
        img.draw(in: NSRect(origin: .zero, size: img.size))
        color.withAlphaComponent(alpha).set()
        NSRect(origin: .zero, size: img.size).fill(using: .sourceAtop)
        out.unlockFocus()
        return out
    }

    // Frame-array wrapper for tinted(_:_:_:).
    func tinted(_ frames: [NSImage], _ color: NSColor, _ alpha: CGFloat) -> [NSImage] {
        return frames.map { tinted($0, color, alpha) }
    }

    // Digivolve sequence (~4.5s), classic anime style:
    //   1) old form blinks white a few times (진화 시작)
    //   2) glowing white silhouette morphs old shape <-> new shape
    //   3) color snaps back on the new form (진화 완료)
    // Runs on its own fast timer, overriding the normal 0.8s animation and
    // the pause state — evolution is worth waking up for. A second
    // evolution during the burst just restarts it.
    func startEvolutionBurst(from oldFrames: [NSImage], to newFrames: [NSImage]) {
        evolutionTimer?.invalidate()
        let oldNormal = oldFrames[0]
        let newNormal = newFrames[0]
        let oldWhite = whiteSilhouette(of: oldNormal)
        let newWhite = whiteSilhouette(of: newNormal)
        let oldWhite1 = whiteSilhouette(of: oldFrames.count > 1 ? oldFrames[1] : oldNormal)
        let newWhite1 = whiteSilhouette(of: newFrames.count > 1 ? newFrames[1] : newNormal)

        var sequence: [NSImage] = []
        // 1) ignition: color <-> white blink on the old form
        for _ in 0..<3 { sequence += [oldNormal, oldWhite] }
        // 2) silhouette morph: white-only shape swap, quickening
        sequence += [oldWhite, oldWhite1, newWhite, newWhite1,
                     oldWhite, newWhite, oldWhite1, newWhite1,
                     oldWhite, newWhite, newWhite1, newWhite]
        // 3) reveal: white <-> color pop on the new form
        sequence += [newNormal, newWhite, newNormal, newWhite, newNormal]

        var tick = 0
        evolutionTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            if tick >= sequence.count {
                timer.invalidate()
                self.evolutionTimer = nil
                self.currentFrameSetKey = "" // force applyFrameSet to resettle
                self.applyFrameSet()
                self.advanceFrame()
                return
            }
            self.statusItem.button?.image = sequence[tick]
            tick += 1
        }
    }

    // MARK: - Evolution cut-in overlay (work item A)
    //
    // Runs ALONGSIDE startEvolutionBurst's existing menu-bar digivolve
    // animation (that stays exactly as-is) -- this shows the same style of
    // digivolve morph at portrait size in the screen's top-right corner,
    // since an elaborate adult/perfect/ultimate form is unreadable at the
    // menu bar's 16pt icon size.
    // 알림 방식과 상주 펫. 창은 펫 모드에 처음 들어갈 때 만들고 이후 재사용한다.
    var notifyMode: NotifyMode = .center
    var petPanel: PetPanel?
    var petRoot: PetClickView?
    var petSpriteView: PixelArtView?
    var petBackdropView: NSView?
    var petListPanel: PetPanel?
    var petListRoot: PetHoverView?
    var petListVisible = false
    var petHoverShowTimer: Timer?
    var petHoverHideTimer: Timer?
    var petHistory: [String: PetSessionHistory] = [:]
    var petListSize = NSSize(width: 270, height: 40)
    var petPosition = PetPosition.defaultPosition
    // 마지막 레이아웃에서 펫 박스 원점이 창 원점에서 떨어진 거리 (드래그 종료 시 펫 위치 복원용).
    var petBoxOffset = NSPoint.zero
    var petBubbleView: NSView?
    var petBodyLabel: NSTextField?
    var petTitleLabel: NSTextField?
    var petBubbleRequest: NotifyRequest?
    var petBubbleShownAt = Date.distantPast
    // critical 말풍선의 세션에서 awaitingUserSince 가 실제로 관찰됐는가 (해제 판정의 전제).
    var petBubbleSawAwaiting = false
    var petBubbleCount = 0
    // 자동 숨김 타이머가 자기가 띄운 말풍선인지 확인하는 용도 (cutInGeneration 과 같은 이유).
    var petBubbleGeneration = 0
    var cutInWindow: NSWindow?
    var cutInImageView: PixelArtView?
    var cutInLabel: NSTextField?
    var cutInTickTimer: Timer? = nil
    var cutInHoldTimer: Timer? = nil
    // Bumped on every call to startEvolutionCutIn(); timer closures compare
    // against the value they captured so a re-trigger mid-burst (a second
    // evolution before the first cut-in finished) can't have its stale
    // hold/fade-out timers stomp on the new run's window state.
    var cutInGeneration = 0

    func makeCutInWindow() -> NSWindow {
        let size = NSSize(width: portraitBox + 40, height: portraitBox + 68)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                               styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let container = NSView(frame: NSRect(origin: .zero, size: size))

        // Backdrop panel behind the sprite/label. Without this, the white
        // digivolve silhouette phase vanishes over a white desktop/window
        // and a dark sprite (e.g. impmon's line) vanishes over a dark one --
        // confirmed by screen capture, contrast is otherwise a coin flip.
        // Colors are fixed literals (not semantic/system colors), so the
        // panel stays dark and legible regardless of the system's light/dark
        // appearance or whatever happens to be behind the cut-in.
        let backdrop = NSView(frame: NSRect(origin: .zero, size: size))
        backdrop.wantsLayer = true
        backdrop.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.6).cgColor
        backdrop.layer?.cornerRadius = 16
        backdrop.layer?.borderWidth = 1
        backdrop.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        container.addSubview(backdrop)

        let imageView = PixelArtView(frame: NSRect(x: 20, y: 48, width: portraitBox, height: portraitBox))
        container.addSubview(imageView)
        cutInImageView = imageView

        let label = NSTextField(labelWithString: "")
        label.font = NSFont.boldSystemFont(ofSize: 15)
        label.alignment = .center
        label.textColor = .white
        let shadow = NSShadow()
        shadow.shadowColor = .black
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        label.shadow = shadow
        label.frame = NSRect(x: 0, y: 16, width: size.width, height: 24)
        container.addSubview(label)
        cutInLabel = label

        window.contentView = container
        return window
    }

    // The screen that owns the menu bar (see positionCutInWindow for why not
    // NSScreen.main). Shared by the cut-in overlay and the resident pet.
    func menuBarScreen() -> NSScreen? {
        return NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main
    }

    // Top-right corner of the main screen's visibleFrame, just under the
    // menu bar, 16pt margin from the top and right edges.
    //
    // Deliberately NOT NSScreen.main -- that resolves to whichever screen
    // currently holds keyboard focus, which on a multi-monitor setup can be
    // a secondary display with no menu bar at all (confirmed while testing:
    // the cut-in silently rendered on an off-focus external monitor and
    // never became visible on the laptop's own screen). The screen that
    // actually owns the menu bar is always the one at origin (0,0), per
    // AppKit's screen-ordering convention.
    func positionCutInWindow(_ window: NSWindow) {
        guard let screen = menuBarScreen() else { return }
        let visible = screen.visibleFrame
        let size = window.frame.size
        let origin = NSPoint(x: visible.maxX - size.width - 16,
                              y: visible.maxY - size.height - 16)
        window.setFrameOrigin(origin)
    }

    // ~3.5s total: fade in -> digivolve silhouette morph (reusing
    // whiteSilhouette(of:), same visual language as startEvolutionBurst) ->
    // 1.2s hold on the new form -> 0.4s fade out, then the window is
    // ordered out (not destroyed, so a later evolution can reuse it).
    func startEvolutionCutIn(fromStage: String, toStage: String, name: String) {
        // Single choke point for the kill switch -- guarding here instead of
        // at the call sites means a future caller can't accidentally leak an
        // overlay past the setting.
        guard cutInEnabled else { return }
        let (oldPortrait, oldIsPixelArt) = portraitImage(forStage: fromStage)
        let (newPortrait, newIsPixelArt) = portraitImage(forStage: toStage)
        guard let oldPortrait = oldPortrait, let newPortrait = newPortrait else { return }

        cutInTickTimer?.invalidate()
        cutInTickTimer = nil
        cutInHoldTimer?.invalidate()
        cutInHoldTimer = nil
        cutInGeneration += 1
        let myGen = cutInGeneration

        let window = cutInWindow ?? makeCutInWindow()
        cutInWindow = window
        positionCutInWindow(window)
        cutInLabel?.stringValue = "\(name) 진화!"
        cutInImageView?.image = oldPortrait
        // Set pixelArt based on whether we're showing artwork or pixel art
        cutInImageView?.isPixelArt = oldIsPixelArt

        window.alphaValue = 0
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.3
            window.animator().alphaValue = 1
        }

        let oldWhite = whiteSilhouette(of: oldPortrait)
        let newWhite = whiteSilhouette(of: newPortrait)
        var sequence: [NSImage] = []
        // 1) ignition: color <-> white blink on the old form
        for _ in 0..<2 { sequence += [oldPortrait, oldWhite] }
        // 2) silhouette morph: white-only shape swap
        sequence += [oldWhite, newWhite, oldWhite, newWhite, oldWhite, newWhite]
        // 3) reveal: white <-> color pop on the new form
        sequence += [newPortrait, newWhite, newPortrait]

        var tick = 0
        cutInTickTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] timer in
            guard let self = self, self.cutInGeneration == myGen else { timer.invalidate(); return }
            if tick >= sequence.count {
                timer.invalidate()
                self.cutInTickTimer = nil
                self.cutInImageView?.image = newPortrait
                self.cutInImageView?.isPixelArt = newIsPixelArt
                self.cutInHoldTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
                    guard let self = self, self.cutInGeneration == myGen, let win = self.cutInWindow else { return }
                    NSAnimationContext.runAnimationGroup({ ctx in
                        ctx.duration = 0.4
                        win.animator().alphaValue = 0
                    }, completionHandler: { [weak self] in
                        guard let self = self, self.cutInGeneration == myGen else { return }
                        win.orderOut(nil)
                    })
                }
                return
            }
            self.cutInImageView?.image = sequence[tick]
            tick += 1
        }
    }

    // Recomputes currentFrames from (currentStageId, currentLimitLevel,
    // currentSessionState) via overrideFrameLevel's priority order. Only
    // resets frameIdx when the selected set actually changes, so a running
    // animation doesn't restart every 2s tick for no reason.
    func applyFrameSet() {
        let level = overrideFrameLevel(limitLevel: currentLimitLevel, sessionState: currentSessionState)
        // Override frames are now tinted per-stage on evolved forms (see
        // framesForLevel), so the cache key must include currentStageId even
        // when an override is active -- otherwise a stage change while an
        // override is active would keep showing stale tinted frames.
        let key = "\(level ?? "stage"):\(currentStageId)"
        guard key != currentFrameSetKey else { return }
        currentFrameSetKey = key
        currentFrames = framesForLevel(level, stage: currentStageId)
        frameIdx = 0
    }

    // Populates rateLimitMenuLines and currentLimitLevel from whichever
    // registered session's HUD cache was written most recently. Leaves
    // both empty/nil (no crash, section just omitted / stage frames kept)
    // if no session has a readable cache.
    func updateRateLimits(sessions: [SessionEntry]) {
        rateLimitMenuLines = []
        currentLimitLevel = nil
        guard let (cache, stale) = mostRecentHudCache(sessions: sessions),
              let rateLimits = cache["rate_limits"] as? [String: Any]
        else { return }

        for key in rateLimits.keys.sorted() {
            guard let bucket = rateLimits[key] as? [String: Any] else { continue }
            rateLimitMenuLines.append(rateLimitLine(key: key, bucket: bucket, stale: stale))
        }
        currentLimitLevel = limitLevel(rateLimits: rateLimits, now: Date().timeIntervalSince1970)
    }

    func focusedSessionLabel() -> String {
        if let sessionId = focusedSessionState["sessionId"] as? String, !sessionId.isEmpty {
            // Project name makes the row human-verifiable at a glance; the
            // raw id alone is meaningless to the person reading the menu.
            if let cwd = focusedSessionState["cwd"] as? String, !cwd.isEmpty {
                return "세션 \(sessionId.prefix(8)) · \((cwd as NSString).lastPathComponent)"
            }
            return "세션 \(sessionId.prefix(8))"
        }
        if let cwd = focusedSessionState["cwd"] as? String, !cwd.isEmpty {
            return "세션 \((cwd as NSString).lastPathComponent)"
        }
        if !focusedLastResolvedPath.isEmpty {
            let base = (focusedLastResolvedPath as NSString).lastPathComponent
            return "세션 \((base as NSString).deletingPathExtension)"
        }
        return "세션 (전역)"
    }

    // One condensed line describing the focused session, for the dropdown.
    func focusedSessionLine() -> String {
        if focusedUnregistered {
            return "새 세션 — 미등록"
        }
        let ok = focusedSessionState["toolSuccessCount"] as? Int ?? 0
        let fail = focusedSessionState["toolFailureCount"] as? Int ?? 0
        return "\(focusedSessionLabel()) — 성공 \(ok)/실패 \(fail)"
    }

    // One dropdown line per live session, ordered/filtered by
    // orderedSessionStates (24h mtime cutoff, dead sessions kept for a
    // short grace window then dropped, sorted by state urgency then
    // mtime-desc) so this list and --dump-state's session lines can never
    // disagree on what "live" means.
    func liveSessionLines(sessions: [SessionEntry]) -> [String] {
        var lines: [String] = []
        for (entry, state) in orderedSessionStates(sessions: sessions).prefix(10) {
            let json = entry.json
            let project = ((json["cwd"] as? String).flatMap { $0.isEmpty ? nil : ($0 as NSString).lastPathComponent }) ?? "?"
            let fullSid = json["sessionId"] as? String ?? ""
            let sid = fullSid.isEmpty ? "--------" : String(fullSid.prefix(8))
            let focused = !focusedLastResolvedPath.isEmpty && entry.path == focusedLastResolvedPath
            let status = sessionStatusLabel(state, json: json)
            let tokens = sessionTokens[fullSid] ?? 0
            lines.append("\(focused ? "▶" : "  ") \(project) · \(status) · \(formatTokenCount(tokens)) tok · \(sid)")
        }
        return lines
    }

    // Formats a single route reason for display in the dropdown menu.
    // Delegates to global function for code reuse with --dump-state path.
    func formatRouteReason(stageId: String, reason: [String: Any]?, route: [String: [String: String]]) -> String? {
        return formatRouteReasonGlobal(stageId: stageId, reason: reason, route: route)
    }

    // Formats a single condition with axis name and threshold.
    // Delegates to global function for code reuse with --dump-state path.
    func formatCondition(_ when: [String: Any], ctx: [String: Any]) -> String? {
        return formatConditionGlobal(when, ctx: ctx)
    }

    // Builds the menu's header item: a big portrait (readable, unlike the
    // 16pt menu bar icon) + name + stage + today's token count. Replaces
    // the old single-line text item -- everything below it (session rows,
    // rate limits, quit) is unchanged.
    func makeHeaderMenuItem(name: String, stageId: String, tokenLine: String) -> NSMenuItem {
        let width: CGFloat = 260
        let height: CGFloat = 58 + portraitBox + 4
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        let portraitView = PixelArtView(frame: NSRect(x: (width - portraitBox) / 2, y: 58,
                                                      width: portraitBox, height: portraitBox))
        let (portraitImg, isPixelArt) = portraitImage(forStage: stageId)
        portraitView.image = portraitImg
        portraitView.isPixelArt = isPixelArt
        container.addSubview(portraitView)

        let nameLabel = NSTextField(labelWithString: name)
        nameLabel.font = NSFont.boldSystemFont(ofSize: 14)
        nameLabel.alignment = .center
        nameLabel.textColor = NSColor.labelColor
        nameLabel.frame = NSRect(x: 0, y: 38, width: width, height: 18)
        container.addSubview(nameLabel)

        // Badge point is judged off the CURRENT stage only (route[currentStageId]
        // via currentTerminalFrom == stageId), never "the route has a terminal
        // node somewhere" -- the latter would light the badge up from the egg
        // stage on, since every route contains its own terminal node further up.
        let baseStageText = stageLabels[stageId] ?? stageId
        let stageText = (currentTerminalFrom == stageId) ? "\(baseStageText) · 이 계보의 최종형" : baseStageText
        let stageLabel = NSTextField(labelWithString: stageText)
        stageLabel.font = NSFont.systemFont(ofSize: 11)
        stageLabel.alignment = .center
        stageLabel.textColor = NSColor.secondaryLabelColor
        stageLabel.frame = NSRect(x: 0, y: 22, width: width, height: 14)
        container.addSubview(stageLabel)

        let tokenLabel = NSTextField(labelWithString: tokenLine)
        tokenLabel.font = NSFont.systemFont(ofSize: 11)
        tokenLabel.alignment = .center
        tokenLabel.textColor = NSColor.secondaryLabelColor
        tokenLabel.frame = NSRect(x: 0, y: 6, width: width, height: 14)
        container.addSubview(tokenLabel)

        let item = NSMenuItem()
        item.view = container
        return item
    }

    func rebuildMenu() {
        let menu = NSMenu()

        let mon = currentMon.isEmpty ? defaultMon : currentMon
        let name = currentPackPath.isEmpty
            ? labelForMon(mon)
            : evolvedName(pack: currentPackPath, mon: mon, stageId: currentStageId)
        menu.addItem(makeHeaderMenuItem(name: name, stageId: currentStageId,
                                        tokenLine: "오늘 \(formatTokenCount(dailyOutputTokens)) tok"))

        // Route reasons: explain why each stage was chosen (lib/daily.js routeReasons)
        if let reasons = currentRouteReasons {
            for stageId in stageIds {
                if let reasonLine = formatRouteReason(stageId: stageId, reason: reasons[stageId], route: currentRoute) {
                    menu.addItem(withTitle: reasonLine, action: nil, keyEquivalent: "")
                }
            }
            menu.addItem(NSMenuItem.separator())
        }

        // Waiting-for-human sessions get called out first — they need
        // attention more urgently than a plain "still working" count.
        let waitingUserCount = lastSessions.filter { projectState($0) == .waitingUser }.count
        let statusLine: String
        if waitingUserCount > 0 {
            statusLine = "입력 대기 \(waitingUserCount)개 · 작업 중 \(workingSessionCount)개"
        } else if workingSessionCount > 0 {
            statusLine = "작업 중 세션 \(workingSessionCount)개"
        } else {
            statusLine = "모든 세션 대기 중"
        }
        menu.addItem(withTitle: statusLine, action: nil, keyEquivalent: "")

        menu.addItem(NSMenuItem.separator())
        let sessionLines = liveSessionLines(sessions: lastSessions)
        if sessionLines.isEmpty {
            menu.addItem(withTitle: "등록된 세션 없음", action: nil, keyEquivalent: "")
        } else {
            for line in sessionLines {
                menu.addItem(withTitle: line, action: nil, keyEquivalent: "")
            }
        }
        // The focused kitty window may hold a session that hasn't registered
        // itself yet — it has no row above, so call it out explicitly.
        if focusedUnregistered {
            menu.addItem(withTitle: "▶ 새 세션 — 미등록", action: nil, keyEquivalent: "")
        }

        if !rateLimitMenuLines.isEmpty {
            menu.addItem(NSMenuItem.separator())
            for line in rateLimitMenuLines {
                menu.addItem(withTitle: line, action: nil, keyEquivalent: "")
            }
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "알림 권한: " + notifyAuthLabel(notifyAuthStatus), action: nil, keyEquivalent: "")
        if petEnabled {
            let header = NSMenuItem(title: "알림 방식", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for mode in [NotifyMode.center, NotifyMode.pet] {
                let item = NSMenuItem(title: mode.label, action: #selector(selectNotifyMode(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = mode.rawValue
                item.state = (mode == notifyMode) ? .on : .off
                menu.addItem(item)
            }
            if notifyMode == .pet {
                let reset = NSMenuItem(title: "펫 위치 초기화", action: #selector(resetPetPosition(_:)), keyEquivalent: "")
                reset.target = self
                menu.addItem(reset)
            }
        }

        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
        statusItem.menu = menu
    }

    // MARK: - 상주 펫

    // 스프라이트 96pt 박스, 안쪽 6pt 여백: 메뉴바 프레임(논리 16pt)의 정수 5배로 그려져
    // 픽셀아트가 뭉개지지 않는다.
    static let petSize: CGFloat = 96
    static let petSpriteInset: CGFloat = 6
    static let petBubbleWidth: CGFloat = 220
    static let petBubblePadding: CGFloat = 12
    static let petBodyMaxLines = 3
    static let petGap: CGFloat = 6
    static let petMargin: CGFloat = 16
    // 놓은 자리가 화면 가장자리에서 이 거리 안이면 petMargin 으로 붙는다.
    static let petSnap: CGFloat = 24
    // 호버 목록: 열기 지연은 지나가는 마우스에 반응하지 않기 위해, 닫기 지연은 펫에서 목록으로
    // 옮겨가는 동안 닫히지 않기 위해 둔다.
    static let petHoverOpenDelay: TimeInterval = 0.25
    static let petHoverCloseDelay: TimeInterval = 0.3
    static let petHistoryDepth = 3
    static let petHistoryMaxSessions = 10
    static let petListWidth: CGFloat = 270
    // 일반 말풍선 수명.
    static let petBubbleSeconds: TimeInterval = 8
    // critical 의 최후 상한. 해제 증거(아래 expirePetBubbleIfResolved)가 끝내 안 와도 영원히
    // 남지는 않게 한다.
    static let petCriticalCapSeconds: TimeInterval = 30 * 60

    func makePetPanel() -> PetPanel {
        let size = NSSize(width: AppDelegate.petSize, height: AppDelegate.petSize)
        // nonactivating + canBecomeKey=false: 클릭해도 앱이 활성화되지 않아 사용자가 치던
        // 터미널의 키 포커스를 뺏지 않는다. 클릭을 받아야 하므로 ignoresMouseEvents 는 쓰지 않는다.
        let panel = PetPanel(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let root = PetClickView(frame: NSRect(origin: .zero, size: size))
        root.onClick = { [weak self] in self?.petClicked() }
        root.onDragEnd = { [weak self] in self?.petDragEnded() }
        // 드래그가 시작되면 목록을 즉시 닫고, 드래그 중에는 호버가 시작되지 않는다.
        root.onDragStart = { [weak self] in self?.hidePetList() }
        root.onHoverEnter = { [weak self] in self?.petHoverEntered() }
        root.onHoverExit = { [weak self] in self?.petHoverExited() }

        // 배경 없는 스프라이트는 복잡한 화면 위에서 묻힌다. 컷인과 같은 고정 리터럴 색의
        // 반투명 판을 깐다 (밝은/어두운 바탕 어디서든 같게 보인다).
        let backdrop = NSView(frame: NSRect(origin: .zero, size: size))
        backdrop.wantsLayer = true
        backdrop.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.5).cgColor
        backdrop.layer?.cornerRadius = 18
        backdrop.layer?.borderWidth = 1
        backdrop.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        root.addSubview(backdrop)
        petBackdropView = backdrop

        let sprite = PixelArtView(frame: .zero)
        root.addSubview(sprite)

        let bubble = NSView(frame: .zero)
        bubble.wantsLayer = true
        bubble.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        bubble.layer?.cornerRadius = 12
        bubble.layer?.borderWidth = 1
        bubble.isHidden = true

        let body = NSTextField(wrappingLabelWithString: "")
        body.font = NSFont.boldSystemFont(ofSize: 13)
        body.textColor = .white
        body.maximumNumberOfLines = AppDelegate.petBodyMaxLines
        // .byTruncatingTail 는 라벨을 한 줄로 고정한다. 줄바꿈으로 두고 마지막 줄만 말줄임한다.
        body.lineBreakMode = .byWordWrapping
        body.cell?.truncatesLastVisibleLine = true
        bubble.addSubview(body)

        let title = NSTextField(labelWithString: "")
        title.font = NSFont.systemFont(ofSize: 11)
        title.textColor = NSColor.white.withAlphaComponent(0.75)
        title.lineBreakMode = .byTruncatingTail
        bubble.addSubview(title)
        root.addSubview(bubble)

        panel.contentView = root
        petRoot = root
        petSpriteView = sprite
        petBubbleView = bubble
        petBodyLabel = body
        petTitleLabel = title
        return panel
    }

    // 본문 줄바꿈 높이(최대 3줄)에 맞춰 말풍선 높이를 정하고 라벨 위치를 잡는다.
    // 말풍선의 전체 높이를 돌려준다.
    func layoutPetBubbleContent() -> CGFloat {
        guard let body = petBodyLabel, let title = petTitleLabel else { return 0 }
        let pad = AppDelegate.petBubblePadding
        let innerWidth = AppDelegate.petBubbleWidth - pad * 2
        body.preferredMaxLayoutWidth = innerWidth
        let lineHeight = ceil(body.font!.boundingRectForFont.height)
        let measured = body.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: innerWidth, height: 1000)).height ?? lineHeight
        let bodyHeight = min(measured, lineHeight * CGFloat(AppDelegate.petBodyMaxLines) + 2)
        let titleHeight: CGFloat = 15
        title.frame = NSRect(x: pad, y: 8, width: innerWidth, height: titleHeight)
        body.frame = NSRect(x: pad, y: 8 + titleHeight + 4, width: innerWidth, height: bodyHeight)
        return 8 + titleHeight + 4 + bodyHeight + 10
    }

    // 저장된 앵커(모서리 + 오프셋)에서 펫 위치를 구해 visibleFrame 안으로 clamp 하고, 말풍선은
    // 화면 안에 남도록 뒤집어 놓는다. 창은 펫 박스와 말풍선의 합집합이다 — 말풍선이 없으면
    // 펫 크기라 클릭을 가로채는 면적이 최소다. 화면 선택은 컷인과 같다 (menuBarScreen).
    // 모니터 연결/해제·Dock 변화에도 펫이 밖에 남지 않도록 화면 파라미터 알림과 2초 틱에서도
    // 부른다 — 그래서 프레임이 같으면 아무것도 안 한다. 드래그 중에는 손대지 않는다.
    func layoutPetPanel() {
        guard let panel = petPanel, let bubble = petBubbleView, let sprite = petSpriteView,
              let backdrop = petBackdropView, let screen = menuBarScreen(),
              petRoot?.isDragging != true else { return }
        let visible = screen.visibleFrame
        // 목록이 열려 있으면 말풍선은 목록이 대신한다 (겹침 방지). 닫히면 다시 나온다.
        let showBubble = !bubble.isHidden && !petListVisible
        let bubbleHeight = showBubble ? layoutPetBubbleContent() : 0
        let box = petRect(for: petPosition, size: AppDelegate.petSize, in: visible)
        var union = box
        var bubbleRect = NSRect.zero
        if showBubble {
            bubbleRect = petBubbleRect(petRect: box,
                                       size: NSSize(width: AppDelegate.petBubbleWidth, height: bubbleHeight),
                                       gap: AppDelegate.petGap, in: visible)
            union = box.union(bubbleRect)
        }
        if panel.frame != union { panel.setFrame(union, display: true) }
        petRoot?.frame = NSRect(origin: .zero, size: union.size)
        backdrop.frame = box.offsetBy(dx: -union.origin.x, dy: -union.origin.y)
        sprite.frame = backdrop.frame.insetBy(dx: AppDelegate.petSpriteInset, dy: AppDelegate.petSpriteInset)
        bubble.frame = bubbleRect.offsetBy(dx: -union.origin.x, dy: -union.origin.y)
        petBoxOffset = NSPoint(x: box.origin.x - union.origin.x, y: box.origin.y - union.origin.y)
        petRoot?.hoverRect = backdrop.frame
        layoutPetList()
    }

    // 놓은 자리를 새 앵커로 저장한다: 화면 안으로 clamp -> 가까운 모서리 기준 -> 가장자리 스냅.
    func petDragEnded() {
        guard let panel = petPanel, let screen = menuBarScreen() else { return }
        let visible = screen.visibleFrame
        let dropped = NSRect(x: panel.frame.origin.x + petBoxOffset.x, y: panel.frame.origin.y + petBoxOffset.y,
                             width: AppDelegate.petSize, height: AppDelegate.petSize)
        petPosition = petAnchor(for: clampPetRect(dropped, into: visible), in: visible,
                                  snap: AppDelegate.petSnap, margin: AppDelegate.petMargin)
        writeSetting("petPosition", petPosition.json)
        layoutPetPanel()
    }

    @objc func resetPetPosition(_ sender: NSMenuItem) {
        petPosition = PetPosition.defaultPosition
        writeSetting("petPosition", nil)
        layoutPetPanel()
    }

    // 모드를 실제 화면에 반영한다. 펫 모드면 창을 띄우고, 아니면 말풍선째 내린다.
    func applyNotifyMode() {
        guard notifyMode == .pet else {
            hidePetList()
            hidePetBubble()
            petPanel?.orderOut(nil)
            return
        }
        let panel = petPanel ?? makePetPanel()
        petPanel = panel
        petSpriteView?.image = currentFrames.first
        layoutPetPanel()
        panel.orderFrontRegardless()
    }

    func refreshPetBubbleText(_ request: NotifyRequest) {
        petBodyLabel?.stringValue = request.body
        // 개수는 제목 줄에 둔다 — 본문은 3줄 말줄임이라 뒤에 붙이면 잘린다.
        petTitleLabel?.stringValue = request.title + (petBubbleCount > 1 ? "  · +\(petBubbleCount - 1)" : "")
        petBubbleView?.layer?.borderColor = (request.urgency == "critical"
            ? NSColor.systemOrange : NSColor.white.withAlphaComponent(0.18)).cgColor
        layoutPetPanel()
    }

    func showPetBubble(_ request: NotifyRequest) {
        applyNotifyMode()
        recordPetMessage(request)
        if petListVisible { refreshPetList() }
        guard petBubbleView != nil else { return }

        // 대기 중인 critical("입력 대기") 은 뒤늦게 온 일반 알림이 덮어쓰지 못한다. 일반은
        // 개수만 올리고, 타이머도 건드리지 않는다 (critical 이 8초 타이머를 물려받으면 안 된다).
        if let pending = petBubbleRequest, pending.urgency == "critical", request.urgency != "critical" {
            petBubbleCount += 1
            refreshPetBubbleText(pending)
            return
        }

        // 그 외에는 최신만 보이고 개수만 센다.
        petBubbleCount = (petBubbleRequest == nil) ? 1 : petBubbleCount + 1
        presentPetBubble(request, sawAwaiting: false)
    }

    // 말풍선을 실제로 띄우고 수명 타이머를 건다. showPetBubble(새 알림)과
    // showNextAwaitingPetBubble(해제 뒤 재표시)이 공유한다 — 기록(recordPetMessage)은 하지 않는다.
    func presentPetBubble(_ request: NotifyRequest, sawAwaiting: Bool) {
        guard let bubble = petBubbleView else { return }
        petBubbleRequest = request
        petBubbleShownAt = Date()
        petBubbleSawAwaiting = sawAwaiting
        bubble.isHidden = false
        refreshPetBubbleText(request)

        petBubbleGeneration += 1
        let myGen = petBubbleGeneration
        // critical 은 해제 증거(expirePetBubbleIfResolved)나 클릭, 아니면 상한까지 남는다.
        let lifetime = request.urgency == "critical"
            ? AppDelegate.petCriticalCapSeconds : AppDelegate.petBubbleSeconds
        Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            guard let self = self, self.petBubbleGeneration == myGen else { return }
            self.hidePetBubble()
        }
    }

    func hidePetBubble() {
        petBubbleGeneration += 1
        petBubbleRequest = nil
        petBubbleCount = 0
        petBubbleView?.isHidden = true
        layoutPetPanel()
    }

    // 말풍선이 떠 있을 때만 반응한다. 포커스는 전부 외부 프로세스라 메인에서 돌리면 메뉴바가
    // 멈춘다 — 백그라운드로 보낸다.
    func petClicked() {
        guard let request = petBubbleRequest else { return }
        hidePetBubble()
        DispatchQueue.global(qos: .userInitiated).async {
            focusSessionTerminal(request)
        }
    }

    // 2초 틱마다 부른다. 유지 중인 critical 말풍선은 "긍정적 증거" 로만 내린다:
    //   - 세션 endedAt 이 찍혔다
    //   - awaitingUserSince 가 한 번 관찰된 뒤 사라졌다
    // 세션 파일이 없거나 pid 를 못 읽는 것은 증거가 아니다 (.dead 로 판정돼도 무시). 또한
    // "입력 대기" 훅과 awaitingUserSince 기록은 다른 훅이라 순서가 보장되지 않는다 — 기록을
    // 보기 전에는 해제 판정을 하지 않으므로 유예 시간에 기대는 경쟁이 없다. 못 보고 끝나는
    // 경우는 petCriticalCapSeconds 상한이 처리한다.
    func expirePetBubbleIfResolved() {
        guard let request = petBubbleRequest, request.urgency == "critical",
              let sessionId = request.sessionId else { return }
        let entry = lastSessions.first {
            ($0.json["sessionId"] as? String) == sessionId
                || ($0.path as NSString).lastPathComponent == sessionId + ".json"
        }
        guard let json = entry?.json else { return }
        if let ended = json["endedAt"] as? String, !ended.isEmpty {
            resolvePetBubble(resolvedSessionId: sessionId)
            return
        }
        if let awaiting = json["awaitingUserSince"] as? String, !awaiting.isEmpty {
            petBubbleSawAwaiting = true
        } else if petBubbleSawAwaiting {
            resolvePetBubble(resolvedSessionId: sessionId)
        }
    }

    // 해제된 critical 말풍선을 내리고, 아직 입력 대기 중인 다른 세션이 있으면 그 요청을 다시 띄운다.
    // (A 의 "입력 대기" 가 B 의 새 critical 에 덮인 채 B 만 해제되면 A 를 놓치는 문제.)
    // 재표시 말풍선이 해제돼도 같은 경로로 다음 후보를 찾는다 — 해제된 세션은 대기 조건에서
    // 빠지므로 후보가 매번 줄어 무한 루프는 없다.
    func resolvePetBubble(resolvedSessionId: String) {
        hidePetBubble()
        showNextAwaitingPetBubble(excluding: resolvedSessionId)
    }

    // 세션 JSON 에 awaitingUserSince 가 있고 endedAt 이 없는 세션 중, critical 요청이 기록된
    // 가장 최근 세션을 다시 띄운다. 이미 awaiting 을 관찰한 상태이므로 sawAwaiting 은 true 로 시작해
    // 그 세션이 해제되면 곧바로 내려간다.
    func showNextAwaitingPetBubble(excluding excluded: String) {
        var best: (request: NotifyRequest, at: Date)?
        for history in petHistory.values {
            guard let sessionId = history.sessionId, sessionId != excluded,
                  isSessionAwaitingInput(sessionId: sessionId),
                  let request = latestCriticalRequest(history) else { continue }
            if best == nil || history.lastAt > best!.at { best = (request, history.lastAt) }
        }
        guard let next = best?.request else { return }
        petBubbleCount = 1
        presentPetBubble(next, sawAwaiting: true)
        layoutPetPanel()
    }

    func isSessionAwaitingInput(sessionId: String) -> Bool {
        let entry = lastSessions.first {
            ($0.json["sessionId"] as? String) == sessionId
                || ($0.path as NSString).lastPathComponent == sessionId + ".json"
        }
        guard let json = entry?.json else { return false }
        if let ended = json["endedAt"] as? String, !ended.isEmpty { return false }
        guard let awaiting = json["awaitingUserSince"] as? String else { return false }
        return !awaiting.isEmpty
    }

    // 세션 기록에서 다시 띄울 critical 요청. 마지막 요청이 critical 이면 그대로(포커스 정보 보존),
    // 아니면 가장 최근 critical 메시지 본문으로 마지막 요청을 복원한다.
    func latestCriticalRequest(_ history: PetSessionHistory) -> NotifyRequest? {
        let last = history.request
        if last.urgency == "critical" { return last }
        guard let message = history.messages.first(where: { $0.urgency == "critical" }) else { return nil }
        return NotifyRequest(title: history.title, body: message.body, subtitle: last.subtitle,
                             urgency: "critical", threadId: last.threadId, sessionId: last.sessionId,
                             tmuxPane: last.tmuxPane, tmuxSocket: last.tmuxSocket,
                             kittyWindowId: last.kittyWindowId, kittyListenOn: last.kittyListenOn)
    }

    // MARK: - 호버 세션 목록

    func recordPetMessage(_ request: NotifyRequest, at: Date = Date()) {
        let key = petHistoryKey(request)
        let message = PetMessage(body: request.body, urgency: request.urgency, at: at)
        var history = petHistory[key] ?? PetSessionHistory(key: key, sessionId: request.sessionId,
                                                           title: request.title, messages: [],
                                                           lastAt: at, receivedAt: Date(), request: request)
        history.messages.insert(message, at: 0)
        history.messages = Array(history.messages.prefix(AppDelegate.petHistoryDepth))
        history.title = request.title
        history.lastAt = at
        history.request = request
        petHistory[key] = history
        // LRU: 세션이 너무 많아지면 가장 오래 조용한 세션부터 버린다.
        while petHistory.count > AppDelegate.petHistoryMaxSessions,
              let oldest = petHistory.values.min(by: { $0.lastAt < $1.lastAt }) {
            petHistory[oldest.key] = nil
        }
    }

    // --demo-pet: 세션 3개의 샘플 기록을 심고 목록을 연다 (호버 없이 스크린샷 확인용).
    // 세션 파일이 있으면(demo-1..3) 상태 점 색도 실제로 반영된다.
    func seedDemoPetHistory() {
        let now = Date()
        let samples: [(String, String, [(String, String, TimeInterval)])] = [
            ("demo-1", "claude-mon 펫 호버", [("입력 대기", "critical", 40), ("턴 종료", "normal", 600)]),
            ("demo-2", "Core API 리팩터", [("작업 완료", "normal", 180), ("턴 종료", "normal", 900), ("턴 종료", "normal", 3000)]),
            ("demo-3", "문서 정리", [("턴 종료", "normal", 7500)])
        ]
        for (id, title, messages) in samples {
            for (body, urgency, ago) in messages.reversed() {
                recordPetMessage(NotifyRequest(title: title, body: body, subtitle: nil, urgency: urgency,
                                               threadId: nil, sessionId: id, tmuxPane: nil, tmuxSocket: nil,
                                               kittyWindowId: nil, kittyListenOn: nil),
                                 at: now.addingTimeInterval(-ago))
            }
        }
        showPetList()
    }

    func petSessionEntry(_ sessionId: String?) -> SessionEntry? {
        guard let sessionId = sessionId else { return nil }
        return lastSessions.first {
            ($0.json["sessionId"] as? String) == sessionId
                || ($0.path as NSString).lastPathComponent == sessionId + ".json"
        }
    }

    // 세션이 끝났거나(endedAt) 파일이 정리됐으면(GC) 기록을 버린다. 파일이 방금 도착한 알림보다
    // 늦게 생기는 경쟁을 피하려고 파일이 없는 경우는 60초 지난 기록만 버린다. sessionId 없는
    // 기록은 판단 근거가 없어 LRU 에만 맡긴다.
    func prunePetHistory() {
        for history in petHistory.values {
            guard let sessionId = history.sessionId else { continue }
            if let entry = petSessionEntry(sessionId) {
                if let ended = entry.json["endedAt"] as? String, !ended.isEmpty { petHistory[history.key] = nil }
            } else if Date().timeIntervalSince(history.receivedAt) > 60 {
                petHistory[history.key] = nil
            }
        }
    }

    func petHoverEntered() {
        guard petRoot?.isDragging != true, notifyMode == .pet else { return }
        petHoverHideTimer?.invalidate()
        petHoverHideTimer = nil
        guard !petListVisible, petHoverShowTimer == nil else { return }
        petHoverShowTimer = Timer.scheduledTimer(withTimeInterval: AppDelegate.petHoverOpenDelay, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.petHoverShowTimer = nil
            if self.petRoot?.isDragging != true { self.showPetList() }
        }
    }

    func petHoverExited() {
        petHoverShowTimer?.invalidate()
        petHoverShowTimer = nil
        guard petListVisible, petHoverHideTimer == nil, petRoot?.isDragging != true else { return }
        petHoverHideTimer = Timer.scheduledTimer(withTimeInterval: AppDelegate.petHoverCloseDelay, repeats: false) { [weak self] _ in
            self?.petHoverHideTimer = nil
            self?.hidePetList()
        }
    }

    func petListEntered() {
        petHoverHideTimer?.invalidate()
        petHoverHideTimer = nil
    }

    func makePetListPanel() -> PetPanel {
        let panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: AppDelegate.petListWidth, height: 40),
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let root = PetHoverView(frame: panel.contentRect(forFrameRect: panel.frame))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.85).cgColor
        root.layer?.cornerRadius = 12
        root.layer?.borderWidth = 1
        root.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        root.onEnter = { [weak self] in self?.petListEntered() }
        root.onExit = { [weak self] in self?.petHoverExited() }
        panel.contentView = root
        petListRoot = root
        return panel
    }

    // 긴급(입력 대기) 세션이 먼저, 그다음 최신순.
    func petPendingCritical(_ history: PetSessionHistory) -> Bool {
        if let request = petBubbleRequest, request.urgency == "critical", petHistoryKey(request) == history.key {
            return true
        }
        guard let entry = petSessionEntry(history.sessionId) else { return false }
        return projectState(entry) == .waitingUser
    }

    func petStateColor(_ history: PetSessionHistory) -> NSColor {
        guard let entry = petSessionEntry(history.sessionId) else { return .systemGray }
        switch projectState(entry) {
        case .working: return .systemGreen
        case .waitingUser: return .systemOrange
        default: return .systemGray
        }
    }

    func makePetRow(_ history: PetSessionHistory, width: CGFloat, now: Date) -> PetRowView {
        let pending = petPendingCritical(history)
        let older = Array(history.messages.dropFirst())
        let height = 8 + 16 + 2 + 16 + CGFloat(older.count) * 13 + 8
        let row = PetRowView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        row.onClick = { [weak self] in self?.petRowClicked(history) }
        let inner = width - 26 - 12

        if pending {
            let accent = NSView(frame: NSRect(x: 0, y: 6, width: 3, height: height - 12))
            accent.wantsLayer = true
            accent.layer?.backgroundColor = NSColor.systemOrange.cgColor
            row.addSubview(accent)
        }
        let dot = NSView(frame: NSRect(x: 12, y: height - 8 - 12, width: 8, height: 8))
        dot.wantsLayer = true
        dot.layer?.backgroundColor = petStateColor(history).cgColor
        dot.layer?.cornerRadius = 4
        row.addSubview(dot)

        var y = height - 8 - 16
        row.addSubview(makePetLabel(history.title, size: 12, bold: true,
                                    color: pending ? .systemOrange : .white,
                                    frame: NSRect(x: 26, y: y, width: inner, height: 16)))
        y -= 18
        if let latest = history.messages.first {
            row.addSubview(makePetLabel("\(latest.body)  ·  \(relativeTimeLabel(from: latest.at, to: now))",
                                        size: 12, bold: false, color: .white,
                                        frame: NSRect(x: 26, y: y, width: inner, height: 16)))
        }
        for message in older {
            y -= 13
            row.addSubview(makePetLabel("\(message.body)  ·  \(relativeTimeLabel(from: message.at, to: now))",
                                        size: 10, bold: false, color: NSColor.white.withAlphaComponent(0.5),
                                        frame: NSRect(x: 26, y: y, width: inner, height: 13)))
        }
        return row
    }

    func makePetEmptyRow(width: CGFloat) -> NSView {
        let row = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 34))
        row.addSubview(makePetLabel("알림 없음", size: 12, bold: false,
                                    color: NSColor.white.withAlphaComponent(0.6),
                                    frame: NSRect(x: 12, y: 9, width: width - 24, height: 16)))
        return row
    }

    // 행을 다시 만들고 창 크기를 맞춘다. 높이는 펫이 위/아래 어느 쪽에든 들어가도록
    // (화면 - 펫) / 2 로 제한하고, 넘치는 행은 (오래된 것부터) 생략한다.
    func refreshPetList() {
        guard petListVisible, let screen = menuBarScreen() else { return }
        let panel = petListPanel ?? makePetListPanel()
        petListPanel = panel
        guard let root = petListRoot else { return }
        for view in root.subviews { view.removeFromSuperview() }

        let width = AppDelegate.petListWidth
        let maxHeight = (screen.visibleFrame.height - AppDelegate.petSize - AppDelegate.petGap) / 2
        let now = Date()
        let sorted = petHistory.values.sorted {
            let a = petPendingCritical($0), b = petPendingCritical($1)
            return a != b ? a : $0.lastAt > $1.lastAt
        }
        var rows: [NSView] = []
        var total: CGFloat = 12
        for history in sorted {
            let row = makePetRow(history, width: width, now: now)
            if total + row.frame.height > maxHeight && !rows.isEmpty { break }
            rows.append(row)
            total += row.frame.height
        }
        if rows.isEmpty {
            let row = makePetEmptyRow(width: width)
            rows.append(row)
            total += row.frame.height
        }
        var y = total - 6
        for row in rows {
            y -= row.frame.height
            row.frame.origin = NSPoint(x: 0, y: y)
            root.addSubview(row)
        }
        petListSize = NSSize(width: width, height: total)
        layoutPetList()
    }

    // 말풍선과 같은 뒤집기/clamp 규칙(petBubbleRect)을 쓴다.
    func layoutPetList() {
        guard petListVisible, let panel = petListPanel, let screen = menuBarScreen() else { return }
        let visible = screen.visibleFrame
        let box = petRect(for: petPosition, size: AppDelegate.petSize, in: visible)
        let rect = petBubbleRect(petRect: box, size: petListSize, gap: AppDelegate.petGap, in: visible)
        if panel.frame != rect { panel.setFrame(rect, display: true) }
        petListRoot?.frame = NSRect(origin: .zero, size: rect.size)
    }

    func showPetList() {
        guard notifyMode == .pet, !petListVisible else { return }
        petListVisible = true
        refreshPetList()
        layoutPetPanel()
        petListPanel?.orderFrontRegardless()
    }

    func hidePetList() {
        petHoverShowTimer?.invalidate()
        petHoverShowTimer = nil
        petHoverHideTimer?.invalidate()
        petHoverHideTimer = nil
        guard petListVisible else { return }
        petListVisible = false
        petListPanel?.orderOut(nil)
        layoutPetPanel()
    }

    // 행 클릭: 그 세션으로 포커스하고, 그 세션의 대기 중 critical 말풍선이 있으면 함께 내린다.
    func petRowClicked(_ history: PetSessionHistory) {
        if let request = petBubbleRequest, petHistoryKey(request) == history.key { hidePetBubble() }
        hidePetList()
        let target = history.request
        DispatchQueue.global(qos: .userInitiated).async {
            focusSessionTerminal(target)
        }
    }

    @objc func selectNotifyMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let mode = NotifyMode(rawValue: raw),
              mode != notifyMode else { return }
        notifyMode = mode
        writeNotifyMode(mode)
        applyNotifyMode()
        // 하트비트를 바로 갱신한다 — 다음 2초 틱까지 훅이 옛 모드를 보고 보내면 안 된다.
        writeNotifyHeartbeat()
        rebuildMenu()
    }

    // MARK: - 데스크톱 알림

    // 기동 시 권한을 무조건 한 번 요청한다. .notDetermined 일 때만 요청하도록
    // 조건을 걸었더니 첫 실행에서 getNotificationSettings 가 곧바로 .denied 를
    // 보고해(등록 전 앱의 기본값으로 보인다) 요청이 아예 나가지 않고 그 상태로
    // 굳었다. 이미 허용된 앱에 다시 요청하는 것은 무해하며(다이얼로그 없이 현재
    // 상태를 반환한다), 정말 거부한 앱에는 아무 일도 일어나지 않는다.
    // 콜백의 granted/error 는 위 notifyAuthStatus 주석의 이유로 읽지 않는다 —
    // 판정은 2초 틱의 폴링이 한다.
    func setupNotifications() {
        try? FileManager.default.createDirectory(atPath: notifyQueueDir,
                                                 withIntermediateDirectories: true)
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refreshNotifyAuth()
        writeNotifyHeartbeat()
    }

    func refreshNotifyAuth() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async { self?.notifyAuthStatus = settings.authorizationStatus }
        }
    }

    // 큐를 비운다. 파일명을 정렬해 도착 순서대로 처리한다 (hook.js 가 epoch ms 를
    // 접두사로 쓴다).
    func drainNotifyQueue() {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: notifyQueueDir) else { return }
        for name in names.sorted() where name.hasSuffix(".json") {
            let path = notifyQueueDir + "/" + name
            let mtime = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date
            let request = parseNotifyRequest(path: path)
            try? fm.removeItem(atPath: path)
            guard let request else { continue }
            let age = Date().timeIntervalSince(mtime ?? Date.distantPast)
            guard age <= notifyStaleSeconds else { continue }
            if notifyMode == .pet {
                showPetBubble(request)
            } else {
                postNotification(request)
            }
        }
    }

    func postNotification(_ request: NotifyRequest) {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        if let subtitle = request.subtitle { content.subtitle = subtitle }
        if let threadId = request.threadId { content.threadIdentifier = threadId }
        content.sound = .default
        // critical 은 사용자가 자리를 비운 사이의 "입력 대기" 다. timeSensitive 는
        // 엔타이틀먼트가 없으면 시스템이 조용히 무시할 뿐 add 를 실패시키지 않으므로,
        // 없는 환경에서도 .active 와 동일하게 동작한다.
        content.interruptionLevel = request.urgency == "critical" ? .timeSensitive : .active
        let req = UNNotificationRequest(identifier: UUID().uuidString,
                                        content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    // notify.js 는 이 파일만 보고 앱 경로를 쓸지 OSC 99 로 내려갈지 정한다. 앱이
    // 살아 있어도 권한이 없으면 알림은 안 뜨므로, 생존과 권한을 함께 싣는다.
    func writeNotifyHeartbeat() {
        let payload: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "at": Date().timeIntervalSince1970,
            "auth": notifyAuthLabel(notifyAuthStatus),
            "authorized": notifyAuthGranted(notifyAuthStatus),
            // notify.js 는 펫 모드면 권한과 무관하게 앱 경로를 쓴다 (펫은 UN 권한이 필요 없다).
            "mode": notifyMode.rawValue
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: URL(fileURLWithPath: notifyHeartbeatFile), options: .atomic)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
