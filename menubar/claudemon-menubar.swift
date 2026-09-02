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
// headless CLI flags (--dump-state, --dump-limits <path>, --demo-cutin
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
        if arg == "--dump-state" { continue }
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

let projectRoot = (executableDir as NSString).deletingLastPathComponent

let dailyTokensScript = projectRoot + "/daily-tokens.js"

let claudemonDir: String = {
    ProcessInfo.processInfo.environment["CLAUDEMON_DIR"]
        ?? NSHomeDirectory() + "/.claude/claudemon"
}()

let globalStateFile = claudemonDir + "/state.json"
let dailyStateFile = claudemonDir + "/daily.json"
let sessionsDir = claudemonDir + "/sessions"

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
var activeRouteKey = ""

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
    for (stage, node) in route {
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
func readDailyState() -> (stageId: String, outputTokens: Int, dateKST: String?, mon: String, sessionTokens: [String: Int], route: [String: [String: String]], terminalFrom: String?) {
    guard let data = FileManager.default.contents(atPath: dailyStateFile),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return ("digitama", 0, nil, defaultMon, [:], [:], nil) }
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
    return (stageId, tokens, dateKST, mon, sessionTokens, route, terminalFrom)
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
    let daily = readDailyState()
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

func drawAspectFit(_ img: NSImage, in box: NSRect) {
    let srcSize = img.size
    guard srcSize.width > 0, srcSize.height > 0 else { return }
    // Pixel art must be scaled by a whole number, otherwise nearest-neighbour
    // stretches some source pixels wider than their neighbours and the outline
    // visibly wobbles. Portrait assets are 66-181px of hand-drawn art dropped
    // into a fixed 150/160px box, so the raw aspect-fit ratio is almost never
    // integral -- floor it and accept the leftover margin. Downscaling (ratio
    // below 1) is left alone: flooring there would collapse to zero.
    let fitScale = min(box.width / srcSize.width, box.height / srcSize.height)
    let scale = fitScale > 1 ? floor(fitScale) : fitScale
    let w = srcSize.width * scale
    let h = srcSize.height * scale
    let origin = NSPoint(x: box.minX + (box.width - w) / 2, y: box.minY + (box.height - h) / 2)
    NSGraphicsContext.current?.imageInterpolation = .none
    img.draw(in: NSRect(origin: origin, size: NSSize(width: w, height: h)), from: .zero, operation: .sourceOver, fraction: 1.0)
}

// NSView that draws a single NSImage aspect-fit via drawAspectFit(). Used by
// both the evolution cut-in overlay (work item A) and the menu's portrait
// header (work item B) so both share the same crisp pixel-art rendering.
final class PixelArtView: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        guard let image = image else { return }
        drawAspectFit(image, in: bounds)
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

        Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            self?.advanceFrame()
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
            if frames.isEmpty && prefix != stage {
                frames = loadImageSequence(inDir: pack, prefix: stage)
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
    func portraitImage(forStage stage: String) -> NSImage? {
        if let img = portraitFrames[stage]?.first {
            return img
        }
        guard let base = stageFrames[stage]?.first ?? idleFrames.first else { return nil }
        // Blow the 32px sprite up as far as portraitBox allows rather than by a
        // fixed 4x: at 4x it landed at 128 in a 184 box, and drawAspectFit's
        // integer snap would then leave it there, wasting the slack.
        let longEdge = max(base.size.width, base.size.height)
        let factor = longEdge > 0 ? max(1, floor(portraitBox / longEdge)) : 1
        return upscaledNearestNeighbor(base, factor: factor)
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
            return
        }
        statusItem.button?.image = currentFrames[frameIdx % currentFrames.count]
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
        guard let screen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main
        else { return }
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
        guard let oldPortrait = portraitImage(forStage: fromStage),
              let newPortrait = portraitImage(forStage: toStage)
        else { return }

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
        portraitView.image = portraitImage(forStage: stageId)
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
        let quit = NSMenuItem(title: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
        statusItem.menu = menu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
