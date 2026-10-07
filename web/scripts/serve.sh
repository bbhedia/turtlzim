#!/usr/bin/env bash
# Keeps the editor's static server (scripts/serve.mjs, see its header) running in the background, so it
# goes on serving after you log out. No root and no systemd; it does not come back after a reboot.
#
#   scripts/serve.sh start [--host 0.0.0.0] [--port 8080] [--auth user:pass] [--tls]
#   scripts/serve.sh stop | restart | status | log [-f]
#
# The default is 127.0.0.1:8080: this machine only, reachable from yours through an SSH tunnel
#   ssh -L 8080:127.0.0.1:8080 you@this-server      then open http://localhost:8080
# To let other machines in, pass --host 0.0.0.0 (IPv4) or --host :: (IPv4 and IPv6), and let the
# port through the firewall (e.g. `sudo ufw allow 8080/tcp`). Encrypted notebooks need a secure page
# (https, or localhost): --tls serves https with a self-signed certificate made for this machine (the
# browser warns once), or use the tunnel. Put the password in the environment
# (ZIM_WEB_AUTH=user:password scripts/serve.sh start ...): --auth would show in the process list.
# `restart` without options reuses the ones of the last `start`. Serves web/dist: `npm run build`
# refreshes it, and the running server picks the new files up without a restart.
set -euo pipefail
cd "$(dirname "$0")/.."

state="${XDG_STATE_HOME:-$HOME/.local/state}/zim-web"
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
    tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'scripts/serve.mjs' || return 1
    echo "$pid"
}

# Where the server says it is, from the log of its last start.
addresses() {
    local line
    line=$(grep -n '^Serving' "$logfile" 2>/dev/null | tail -n 1 | cut -d: -f1 || true)
    [ -n "$line" ] && tail -n "+$line" "$logfile" | head -n 12 | grep -E '^(Serving|  http|Listening|The certificate)' || true
}

start() {
    local pid
    if pid=$(running_pid); then
        echo "already running (pid $pid); use '$0 restart' to change the options"
        addresses
        return 0
    fi
    [ -n "$node_bin" ] || { echo "node not found: install it, or put it on the PATH" >&2; exit 1; }
    [ -f dist/index.html ] || { echo "web/dist is empty: run 'npm run build' first" >&2; exit 1; }
    if [ "$#" -gt 0 ]; then printf '%q ' "$@" >"$argsfile"; else : >"$argsfile"; fi

    local before
    before=$(stat -c %s "$logfile" 2>/dev/null || echo 0)
    setsid nohup "$node_bin" scripts/serve.mjs "$@" --pid-file "$pidfile" >>"$logfile" 2>&1 </dev/null &
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

case "${1:-}" in
    start) shift; start "$@" ;;
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
    *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
