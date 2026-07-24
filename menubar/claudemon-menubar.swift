// ClaudeMon menu bar mascot (PoC)
// Build: swiftc -O -o claudemon-menubar claudemon-menubar.swift
// Run:   ./claudemon-menubar /path/to/sprites/menubar
//
// Evolution stage is now a DAILY GLOBAL value, not tied to any one focused
// session: every 2s tick reads $CLAUDEMON_DIR/daily.json (written by
// daily-tokens.js, which this app also spawns every 30s to keep it fresh).
// That file tracks today's (KST) total output tokens across all sessions
// and the stage they map to. Missing/corrupt daily.json falls back to
// "digitama" and never crashes the app.
//
// Whether the mascot ANIMATES is likewise a global signal: every tick scans
// all of $CLAUDEMON_DIR/sessions/*.json and animates if ANY of them reports
// working == true with a fresh (< 10 min) mtime. If every session is idle
// or stale, the mascot freezes on frame 0 — "everyone's done for now".
//
// The dropdown still resolves and shows the single focused session (via
// active-session.sh, same resolution chain as before: kitty -> tmux ->
// descendant claude pid -> session file), condensed to one line, purely for
// human context — it no longer drives the sprite or the animation state.
//
// Rate-limit sprite overrides (limit80/limit95) read the HUD cache
// (<cwd>/.omc/state/hud-stdin-cache.json) belonging to whichever registered
// session's cache was written most recently, since the usage limit itself
// is account-wide and any session's cache is equally authoritative.

import AppKit

let spriteDir: String = {
    if CommandLine.arguments.count > 1 { return CommandLine.arguments[1] }
    let selfDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
    return selfDir + "/../sprites/menubar"
}()

let resolverScript: String = {
    let selfDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
    return selfDir + "/active-session.sh"
}()

let projectRoot: String = {
    let selfDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
    return (selfDir as NSString).deletingLastPathComponent
}()

let dailyTokensScript = projectRoot + "/daily-tokens.js"

let claudemonDir: String = {
    ProcessInfo.processInfo.environment["CLAUDEMON_DIR"]
        ?? NSHomeDirectory() + "/.claude/claudemon"
}()

let globalStateFile = claudemonDir + "/state.json"
let dailyStateFile = claudemonDir + "/daily.json"
let sessionsDir = claudemonDir + "/sessions"

let stageIds = ["digitama", "baby", "child", "adult", "perfect", "ultimate"]

let stageLabels: [String: String] = [
    "digitama": "알 (Digitama)",
    "baby": "유년기 (Baby)",
    "child": "성장기 (Child)",
    "adult": "성숙기 (Adult)",
    "perfect": "완전체 (Perfect)",
    "ultimate": "궁극체 (Ultimate)",
]

// MARK: - Usage limit display + behavior overrides
//
// Reads <cwd>/.omc/state/hud-stdin-cache.json, which the OMC HUD writes on
// every statusline render. Schema (bucket keys are NOT fixed — future
// buckets like seven_day_opus/fable are expected, so this walks the
// dictionary dynamically instead of hardcoding keys):
//   { "rate_limits": { "five_hour": {"used_percentage": 15, "resets_at": <epoch s>}, ... } }
//
// No macOS notifications are sent for these — the mascot's sprite set is
// overridden instead (see limitLevelForPercentage / framesForLevel below).

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

func rateLimitLine(key: String, bucket: [String: Any], stale: Bool) -> String {
    let percentage = intValue(bucket["used_percentage"])
    let resetsAt = doubleValue(bucket["resets_at"])
    var line = "\(labelForBucket(key))  \(percentage)% · 리셋 \(formatResetTime(epochSeconds: resetsAt))"
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
func limitLevelForPercentage(_ percentage: Int) -> String? {
    if percentage >= 95 { return "limit95" }
    if percentage >= 80 { return "limit80" }
    return nil
}

let orphanSessionThreshold: TimeInterval = 10 * 60

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
func readDailyState() -> (stageId: String, outputTokens: Int, dateKST: String?) {
    guard let data = FileManager.default.contents(atPath: dailyStateFile),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return ("digitama", 0, nil) }
    let rawStage = json["stageId"] as? String ?? "digitama"
    let stageId = stageIds.contains(rawStage) ? rawStage : "digitama"
    let tokens = intValue(json["outputTokens"])
    let dateKST = json["dateKST"] as? String
    return (stageId, tokens, dateKST)
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

// A session only counts toward the global "working" OR if it explicitly
// reports working == true AND its file was touched recently — an orphaned
// session stuck reporting working == true from hours ago must not keep the
// whole mascot animating forever.
func sessionIsActivelyWorking(_ entry: SessionEntry, now: Date = Date()) -> Bool {
    guard workingFieldPresent(entry.json) == true else { return false }
    guard let mtime = entry.mtime else { return false }
    return now.timeIntervalSince(mtime) <= orphanSessionThreshold
}

// Global animate/idle decision + how many sessions are actively working.
// Falls back to the legacy single global-state-file rule only when there
// are no session files at all yet (fresh install).
func globalWorkingState(sessions: [SessionEntry], fallbackGlobalPath: String) -> (animating: Bool, workingCount: Int) {
    if sessions.isEmpty {
        guard let data = FileManager.default.contents(atPath: fallbackGlobalPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (false, 0) }
        let working = workingFieldPresent(json)
        let mtime = (try? FileManager.default.attributesOfItem(atPath: fallbackGlobalPath))?[.modificationDate] as? Date
        let animating = isAnimating(working: working, referenceMtime: mtime)
        return (animating, animating ? 1 : 0)
    }
    let workingCount = sessions.filter { sessionIsActivelyWorking($0) }.count
    return (workingCount > 0, workingCount)
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
}

// --dump-state: headless CLI test mode. Reads the same global sources the
// running app would ($CLAUDEMON_DIR/daily.json, .../sessions/*.json, and
// whichever session's HUD cache is freshest) and prints the resulting
// stage/animation/rate-limit decision, without starting the GUI/app.
// Entirely env-driven (via CLAUDEMON_DIR) so tests can point it at a
// scratch directory.
func dumpState() {
    let daily = readDailyState()
    let sessions = scanSessions(dir: sessionsDir)
    let (animating, workingCount) = globalWorkingState(sessions: sessions, fallbackGlobalPath: globalStateFile)

    var maxPct = 0
    if let (cache, _) = mostRecentHudCache(sessions: sessions),
       let rateLimits = cache["rate_limits"] as? [String: Any] {
        maxPct = maxUsedPercentage(rateLimits: rateLimits)
    }
    let level = limitLevelForPercentage(maxPct)

    print("dailyStage: \(daily.stageId)")
    print("dailyOutputTokens: \(daily.outputTokens)")
    print("workingSessionCount: \(workingCount)")
    print("animating: \(animating)")
    print("maxRateLimitPercentage: \(maxPct)")
    print("frameSet: \(level ?? "stage:\(daily.stageId)")")
}

// CLI test hooks: run headless (no NSApplication) and exit before any
// GUI/state is touched.
if CommandLine.arguments.count > 1 {
    let arg1 = CommandLine.arguments[1]
    if arg1 == "--dump-limits" {
        guard CommandLine.arguments.count > 2 else {
            fputs("usage: claudemon-menubar --dump-limits <hud-cache-path>\n", stderr)
            exit(1)
        }
        dumpLimits(path: CommandLine.arguments[2])
        exit(0)
    }
    if arg1 == "--dump-state" {
        dumpState()
        exit(0)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var stageFrames: [String: [NSImage]] = [:]
    var limitFrameSets: [String: [NSImage]] = [:] // "limit80" / "limit95" -> frames
    var idleFrames: [NSImage] = []
    var currentFrames: [NSImage] = []
    var currentFrameSetKey = ""
    var frameIdx = 0
    var currentStageId = "digitama"
    var dailyOutputTokens = 0
    var workingSessionCount = 0
    var currentLimitLevel: String? = nil
    var rateLimitMenuLines: [String] = []
    var animationPaused = false

    // Focused-session info: purely informational (one line in the menu),
    // resolved the same way as before via active-session.sh. Does not
    // drive the sprite or the animation state anymore.
    var focusedSessionState: [String: Any] = [:]
    var focusedUnregistered = false
    var focusedLastResolvedPath = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        loadFrames()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageOnly
        runDailyTokensAggregator()
        refreshState()
        advanceFrame()

        Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            self?.advanceFrame()
        }
        // active-session.sh re-resolves which kitty window/tmux pane/claude
        // process is focused on every tick; polling is simpler and more
        // robust than a vnode watch across a file that keeps getting
        // replaced (both the resolved session file and the resolution
        // target itself can change between ticks).
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
    func loadImageSequence(prefix: String) -> [NSImage] {
        var result: [NSImage] = []
        var i = 0
        while let img = NSImage(contentsOfFile: "\(spriteDir)/\(prefix)-\(i).png") {
            // 32px bitmap shown at 16pt -> 1:1 physical pixels on retina
            img.size = NSSize(width: 16, height: 16)
            result.append(img)
            i += 1
        }
        return result
    }

    func loadFrames() {
        idleFrames = loadImageSequence(prefix: "idle")
        if idleFrames.isEmpty {
            fputs("claudemon-menubar: no idle sprites found in \(spriteDir)\n", stderr)
            exit(1)
        }
        for stage in stageIds {
            let frames = loadImageSequence(prefix: stage)
            stageFrames[stage] = frames.isEmpty ? idleFrames : frames
        }
        // Optional behavior-override sprite sets. If the corresponding
        // files don't exist yet, the array is simply empty and
        // framesForLevel() falls back to the stage frames.
        limitFrameSets["limit80"] = loadImageSequence(prefix: "limit80")
        limitFrameSets["limit95"] = loadImageSequence(prefix: "limit95")
        currentFrames = stageFrames[currentStageId] ?? idleFrames
    }

    // Picks the frames to display: a limit80/limit95 override (if that
    // level is active and its sprites are actually available) beats the
    // current evolution-stage frames. Stays in effect even while frozen.
    func framesForLevel(_ level: String?, stage: String) -> [NSImage] {
        if let level = level, let frames = limitFrameSets[level], !frames.isEmpty {
            return frames
        }
        return stageFrames[stage] ?? idleFrames
    }

    func advanceFrame() {
        guard !currentFrames.isEmpty else { return }
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
    func refreshFocusedSession() {
        guard let path = resolveActiveSessionPath() else {
            focusedUnregistered = false
            return
        }
        if path.hasPrefix("unknown:") {
            focusedUnregistered = true
            focusedSessionState = [:]
            focusedLastResolvedPath = ""
            return
        }
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            // Resolved path unreadable/malformed: keep the last good info.
            return
        }
        focusedUnregistered = false
        focusedSessionState = json
        focusedLastResolvedPath = path
    }

    func refreshState() {
        // Daily global stage — independent of whichever session is focused.
        let daily = readDailyState()
        currentStageId = daily.stageId
        dailyOutputTokens = daily.outputTokens

        // Global "is anything working" OR across all registered sessions.
        let sessions = scanSessions(dir: sessionsDir)
        let (animating, workingCount) = globalWorkingState(sessions: sessions, fallbackGlobalPath: globalStateFile)
        animationPaused = !animating
        workingSessionCount = workingCount

        updateRateLimits(sessions: sessions)
        refreshFocusedSession()

        applyFrameSet()
        rebuildMenu()
    }

    // Recomputes currentFrames from (currentStageId, currentLimitLevel).
    // Only resets frameIdx when the selected set actually changes, so a
    // running animation doesn't restart every 2s tick for no reason.
    func applyFrameSet() {
        let key = currentLimitLevel ?? "stage:\(currentStageId)"
        guard key != currentFrameSetKey else { return }
        currentFrameSetKey = key
        currentFrames = framesForLevel(currentLimitLevel, stage: currentStageId)
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
        currentLimitLevel = limitLevelForPercentage(maxUsedPercentage(rateLimits: rateLimits))
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

    func rebuildMenu() {
        let menu = NSMenu()

        let dailyLabel = stageLabels[currentStageId] ?? currentStageId
        menu.addItem(withTitle: "\(dailyLabel) · 오늘 \(formatTokenCount(dailyOutputTokens)) tok", action: nil, keyEquivalent: "")

        let statusLine = workingSessionCount > 0 ? "작업 중 세션 \(workingSessionCount)개" : "모든 세션 대기 중"
        menu.addItem(withTitle: statusLine, action: nil, keyEquivalent: "")

        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: focusedSessionLine(), action: nil, keyEquivalent: "")

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
