#!/usr/bin/env bash
# Keeps the account server (src/main.mjs: the web app and /api/) running in the background, like web/scripts/serve.sh does for the static server.
#
#   scripts/run.sh start [--host ::] [--port 8443] [--tls --name ADDRESS] | stop | restart | status | log [-f]
#   scripts/run.sh check                      does it answer, and does its database (exit 0), else why not (exit 1; 3 if it is not running)
#   scripts/run.sh backup [--to DIR] [--keep N]   a checked copy of the data (the server may run), the oldest beyond N (14) removed
#   scripts/run.sh backups                    the copies there are, and whether each is whole
#   scripts/run.sh verify BACKUP              is this copy whole?
#   scripts/run.sh restore BACKUP             stop, put that copy back (what it replaces is kept in replaced-<date>/ of the data folder), start again
#
# Tell it where people reach it first: ZIM_BASE_URL=https://localhost:8443 (the sign-in services send the browser back there), and, to sign in with
# Google or GitHub, put the apps' ids and secrets in ~/.local/state/zim-server/oauth.json (docs/zim-server.md). Without SMTP settings, the codes
# that would be mailed are written to ~/.local/state/zim-server/outbox.jsonl. Needs web/dist (`npm run build` in web/). The log is moved aside
# (serve.log.1 to .3) at a start when it is over 5 MiB (ZIM_LOG_MAX_BYTES). Backups: docs/zim-operations.md.
set -euo pipefail
cd "$(dirname "$0")/.."
src=src/main.mjs

state="${XDG_STATE_HOME:-$HOME/.local/state}/zim-server"
# (where the server keeps its data: ZIM_SERVER_DATA if it is set, as the server reads it, else the folder of its pid file and its log)
data="${ZIM_SERVER_DATA:-$state}"
pidfile="$state/serve.pid"
logfile="$state/serve.log"
argsfile="$state/serve.args"
mkdir -p "$state"

# Node: on the PATH if this shell has it, else the newest one nvm installed (a non-interactive shell,
# such as `ssh host command` or cron, doesn't load nvm).
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
    node_bin=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)
fi

# The pid of the running server, if there is one: the pidfile must name a live process that really
# is this server (a recycled pid is somebody else's).
running_pid() {
    [ -f "$pidfile" ] || return 1
    local pid
    pid=$(cat "$pidfile")
    [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
    tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'src/main.mjs' || return 1
    echo "$pid"
}

# The log is moved aside when it has grown: serve.log.1 to .3 keep what came before. (Only when the server is not running: it holds the log open.)
rotate_log() {
    local size i
    size=$(stat -c %s "$logfile" 2>/dev/null || echo 0)
    [ "$size" -gt "${ZIM_LOG_MAX_BYTES:-5242880}" ] || return 0
    for i in 2 1; do
        [ -f "$logfile.$i" ] && mv -f "$logfile.$i" "$logfile.$((i + 1))"
    done
    mv -f "$logfile" "$logfile.1"
}

# Where the server says it is, from the log of its last start.
addresses() {
    local line
    line=$(grep -n '^Serving' "$logfile" 2>/dev/null | tail -n 1 | cut -d: -f1 || true)
    # (what the server says when it starts: not the requests it logs after that, which begin with a date)
    [ -n "$line" ] && tail -n "+$line" "$logfile" | head -n 12 | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' || true
}

start() {
    local pid
    if pid=$(running_pid); then
        echo "already running (pid $pid); use '$0 restart' to change the options"
        addresses
        return 0
    fi
    [ -n "$node_bin" ] || { echo "node not found: install it, or put it on the PATH" >&2; exit 1; }
    [ -f ../web/dist/index.html ] || { echo "web/dist is empty: run 'npm run build' in web/ first" >&2; exit 1; }
    if [ "$#" -gt 0 ]; then printf '%q ' "$@" >"$argsfile"; else : >"$argsfile"; fi
    rotate_log

    local before
    before=$(stat -c %s "$logfile" 2>/dev/null || echo 0)
    setsid nohup "$node_bin" src/main.mjs "$@" --pid-file "$pidfile" >>"$logfile" 2>&1 </dev/null &
    local launched=$!
    for _ in $(seq 1 50); do
        if pid=$(running_pid); then
            echo "started (pid $pid), log: $logfile"
            addresses
            return 0
        fi
        if ! kill -0 "$launched" 2>/dev/null; then break; fi
        sleep 0.1
    done
    echo "the server did not start:" >&2
    tail -c "+$((before + 1))" "$logfile" >&2 || true
    exit 1
}

stop() {
    local pid
    if ! pid=$(running_pid); then
        echo "not running"
        rm -f "$pidfile"
        return 0
    fi
    kill "$pid"
    for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "stopped (was pid $pid)"
}

# Whether the server answers, and its database with it: asked of the address that it says it is at (the first of them), as a monitor would.
check() {
    local pid url code
    if ! pid=$(running_pid); then
        echo "not running" >&2
        exit 3
    fi
    url=$(addresses | grep -m1 -oE 'https?://[^ ]+/' || true)
    [ -n "$url" ] || { echo "running (pid $pid), but the log does not say where it is" >&2; exit 1; }
    # (-k: the certificate that --tls makes is its own authority's, which this machine does not know; what is asked is whether it answers)
    code=$(curl -sk -m 10 -o /dev/null -w '%{http_code}' "${url}api/health" 2>/dev/null || true)
    if [ "$code" = 200 ]; then
        echo "ok: ${url} answers, and so does its database (pid $pid)"
    else
        echo "NOT ok: ${url}api/health answered '${code:-nothing}' (pid $pid); the end of the log:" >&2
        tail -n 8 "$logfile" >&2 || true
        exit 1
    fi
}

backup_tool() {
    [ -n "$node_bin" ] || { echo "node not found: install it, or put it on the PATH" >&2; exit 1; }
    "$node_bin" src/backup.mjs "$@"
}

case "${1:-}" in
    start) shift; start "$@" ;;
    check) check ;;
    backup) shift; backup_tool backup --data "$data" "$@" ;;
    backups) shift; backup_tool list --data "$data" "$@" ;;
    verify) shift; backup_tool verify "$@" ;;
    restore)
        shift
        [ "$#" -eq 1 ] || { echo "usage: $0 restore BACKUP-FOLDER" >&2; exit 2; }
        # (looked at first: a copy that is not whole does not stop the server for nothing)
        backup_tool verify "$1" || exit 1
        was_running=no
        if running_pid >/dev/null; then was_running=yes; fi
        stop
        if ! backup_tool restore --data "$data" "$1"; then
            [ "$was_running" = yes ] && eval "start $(cat "$argsfile" 2>/dev/null || true)"
            exit 1
        fi
        if [ "$was_running" = yes ]; then eval "start $(cat "$argsfile" 2>/dev/null || true)"; else echo "restored; start the server with '$0 start …'"; fi
        ;;
    stop) stop ;;
    restart)
        shift
        stop
        if [ "$#" -gt 0 ]; then start "$@"; else eval "start $(cat "$argsfile" 2>/dev/null || true)"; fi
        ;;
    status)
        if pid=$(running_pid); then
            echo "running (pid $pid)"
            addresses
        else
            echo "not running"
            exit 3
        fi
        ;;
    log) shift; tail -n 40 "$@" "$logfile" ;;
    *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
