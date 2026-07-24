#!/usr/bin/env bash
# active-session.sh — resolve the session state JSON for the Claude Code
# session visible in the currently focused kitty OS window.
#
# Resolution chain:
#   1. kitty remote-control socket -> focused os_window -> focused tab ->
#      focused window -> foreground process -> tmux client -> tmux session
#      -> active pane -> descendant `claude` process -> matching pid in
#      sessions/*.json
#   2. If the kitty socket is missing or any hop in the chain fails: the
#      most recently modified sessions/*.json (mtime fallback).
#   3. If there are no session files at all: the global state.json.
#
# Prints the resolved absolute path to stdout and exits 0.
# Exits 1 (with a diagnostic on stderr) only if nothing resolvable exists.
#
# Respects $CLAUDEMON_DIR (default: ~/.claude/claudemon) so tests can point
# this at a scratch directory instead of the real one.

set -uo pipefail

CLAUDEMON_DIR="${CLAUDEMON_DIR:-$HOME/.claude/claudemon}"
SESSIONS_DIR="$CLAUDEMON_DIR/sessions"
GLOBAL_STATE="$CLAUDEMON_DIR/state.json"

have_jq() { command -v jq >/dev/null 2>&1; }

# Read a single top-level string/number field out of a JSON file.
# json_field <file> <field-name>
json_field() {
    local file="$1" field="$2"
    if have_jq; then
        jq -r --arg f "$field" '.[$f] // empty' "$file" 2>/dev/null
    else
        python3 -c "
import json, sys
try:
    with open('$file') as fh:
        d = json.load(fh)
    v = d.get('$field', '')
    print('' if v is None else v)
except Exception:
    pass
" 2>/dev/null
    fi
}

# Find the pid of the focused os_window/tab/window's foreground process,
# via the kitty remote-control socket. Prints pid on stdout, nothing on
# any failure (missing socket, kitty not responding, malformed output).
kitty_focused_foreground_pid() {
    local sock candidates=()
    for sock in /tmp/kitty /tmp/kitty-*; do
        [ -S "$sock" ] && candidates+=("$sock")
    done
    [ ${#candidates[@]} -eq 0 ] && return 1

    local sock_path ls_json
    for sock_path in "${candidates[@]}"; do
        ls_json=$(kitten @ --to "unix:$sock_path" ls 2>/dev/null) || continue
        [ -z "$ls_json" ] && continue

        # When kitty is not the frontmost app, every os_window reports
        # is_focused=false; kitty still marks the most recently used one
        # is_active=true. Prefer the focused window, fall back to the
        # active one so the mascot keeps tracking "the kitty window I
        # last used" while another app holds OS focus.
        local pid=""
        if have_jq; then
            pid=$(printf '%s' "$ls_json" | jq -r '
                def pick_win: .tabs[]? | select(.is_active==true)
                    | .windows[]? | select(.is_active==true)
                    | (.foreground_processes[0].pid // .pid);
                ([.[] | select(.is_focused==true) | pick_win] | first)
                // ([.[] | select(.is_active==true) | pick_win] | first)
                // empty
            ' 2>/dev/null)
        else
            pid=$(printf '%s' "$ls_json" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

def pick_win(osw):
    for tab in osw.get('tabs', []):
        if not tab.get('is_active'):
            continue
        for win in tab.get('windows', []):
            if not win.get('is_active'):
                continue
            fg = win.get('foreground_processes') or []
            if fg and fg[0].get('pid'):
                return fg[0]['pid']
            return win.get('pid')
    return None

target = None
for osw in data:
    if osw.get('is_focused'):
        target = pick_win(osw)
        break
if target is None:
    for osw in data:
        if osw.get('is_active'):
            target = pick_win(osw)
            break
if target:
    print(target)
" 2>/dev/null)
        fi
        if [ -n "$pid" ]; then
            printf '%s\n' "$pid"
            return 0
        fi
    done
    return 1
}

# tmux session name owning the client whose process pid is $1.
tmux_session_for_client_pid() {
    local target_pid="$1"
    command -v tmux >/dev/null 2>&1 || return 1
    tmux list-clients -F '#{client_pid} #{client_session}' 2>/dev/null |
        awk -v p="$target_pid" '$1 == p { $1=""; sub(/^ /,""); print; exit }'
}

# pid of the active pane (active window + active pane) in tmux session $1.
tmux_active_pane_pid() {
    local session="$1"
    tmux list-panes -s -t "$session" -F '#{window_active} #{pane_active} #{pane_pid}' 2>/dev/null |
        awk '$1 == 1 && $2 == 1 { print $3; exit }'
}

# BFS down the process tree rooted at $1, return the first pid whose
# command line looks like a Claude Code process.
find_claude_descendant_pid() {
    local root="$1"
    local queue=("$root") seen=()
    local pid cmd children c found=0

    while [ ${#queue[@]} -gt 0 ]; do
        pid="${queue[0]}"
        queue=("${queue[@]:1}")

        for c in "${seen[@]:-}"; do
            [ "$c" = "$pid" ] && continue 2
        done
        seen+=("$pid")

        cmd=$(ps -o command= -p "$pid" 2>/dev/null)
        # Emit every candidate in BFS order instead of stopping at the first:
        # MCP servers spawned by claude carry ".claude/..." paths in their
        # args and would otherwise shadow the real claude process. The caller
        # disambiguates by checking which pid actually owns a session file.
        if printf '%s' "$cmd" | grep -qi 'claude'; then
            printf '%s\n' "$pid"
            found=1
        fi

        children=$(pgrep -P "$pid" 2>/dev/null)
        for c in $children; do
            queue+=("$c")
        done
    done
    [ "${found:-0}" = "1" ]
}

# Path to the sessions/*.json file whose .pid field equals $1.
session_file_for_pid() {
    local target_pid="$1" f pid
    [ -d "$SESSIONS_DIR" ] || return 1
    for f in "$SESSIONS_DIR"/*.json; do
        [ -e "$f" ] || continue
        pid=$(json_field "$f" "pid")
        if [ -n "$pid" ] && [ "$pid" = "$target_pid" ]; then
            printf '%s\n' "$f"
            return 0
        fi
    done
    return 1
}

# Most recently modified sessions/*.json, if any.
most_recent_session_file() {
    [ -d "$SESSIONS_DIR" ] || return 1
    local latest
    latest=$(ls -t "$SESSIONS_DIR"/*.json 2>/dev/null | head -n1)
    [ -n "$latest" ] || return 1
    printf '%s\n' "$latest"
}

resolve_via_kitty() {
    local fg_pid session pane_pid claude_pids claude_pid session_file
    fg_pid=$(kitty_focused_foreground_pid) || return 1
    [ -n "$fg_pid" ] || return 1

    session=$(tmux_session_for_client_pid "$fg_pid") || return 1
    [ -n "$session" ] || return 1

    pane_pid=$(tmux_active_pane_pid "$session") || return 1
    [ -n "$pane_pid" ] || return 1

    claude_pids=$(find_claude_descendant_pid "$pane_pid") || return 1
    [ -n "$claude_pids" ] || return 1

    for claude_pid in $claude_pids; do
        if session_file=$(session_file_for_pid "$claude_pid"); then
            printf '%s\n' "$session_file"
            return 0
        fi
    done

    # A claude process is visible in the focused window but hasn't written
    # its session file yet (no hook event fired since it started). Report
    # that explicitly instead of failing: falling through to the mtime
    # fallback here would silently show some OTHER session's mascot.
    printf 'unknown:%s\n' "${claude_pids%%$'\n'*}"
    return 0
}

main() {
    local resolved

    resolved=$(resolve_via_kitty 2>/dev/null)
    if [ -n "$resolved" ]; then
        printf '%s\n' "$resolved"
        exit 0
    fi

    resolved=$(most_recent_session_file 2>/dev/null)
    if [ -n "$resolved" ]; then
        printf '%s\n' "$resolved"
        exit 0
    fi

    if [ -f "$GLOBAL_STATE" ]; then
        printf '%s\n' "$GLOBAL_STATE"
        exit 0
    fi

    echo "active-session.sh: no kitty socket, no session files, no global state.json under $CLAUDEMON_DIR" >&2
    exit 1
}

main
