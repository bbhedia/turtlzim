#!/usr/bin/env bash
# CI's half of the test of the app in an iPhone's WebView (docs/zim-mobile-shell.md, job `ios` of .github/workflows/desktop.yml): the app that xcodebuild made is installed in a simulator and
# started; its own test (test/ios-e2e.ts, a build made with ZIM_E2E=1) writes what it did in a file of its Documents folder, which is read here from the simulator's disk; then the app is closed
# and started again, and its test says what the restart did to what was written. What happened is said as annotations of the check (a job's log is for whoever is signed in), and is kept in
# the folder that is given, which the workflow uploads.
#
# With ZIM_E2E_SERVER=1 a real account server (scripts/ios-server.mjs: the server's own code, https with a certificate that no system knows, and a few doors for the test) is started first, and the
# app is told where it is (Documents/e2e/server.json), so that its test also tries what its own code does for an account against it.
#
# An app that is not signed with a keychain group has no keychain (error -34018): the build signs it ad hoc with the group of App.entitlements, as Xcode does for a simulator.
#
#   scripts/ios-ci.sh APP.app [OUT-FOLDER]          (macOS, Xcode, Node 24 for the server; bash 3.2 is enough)
set -uo pipefail

app="${1:?the App.app that xcodebuild made}"
out="${2:-${RUNNER_TEMP:-/tmp}/ios-e2e}"
bundle="org.zimnotebook.app"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
failed=0
server_pid=""

# An annotation: its text is cut, and the characters that a runner reads as the end of one are written as it asks.
annotate() {
    local level="$1" title="$2" text="$3"
    text=${text//'%'/'%25'}
    text=${text//$'\r'/'%0D'}
    text=${text//$'\n'/'%0A'}
    echo "::${level} title=${title}::${text:0:900}"
}

# The iPhone to try the app in: the newest iOS that the runner has, and the first iPhone of it (it is not made: the runner has some).
chosen=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
runtimes = json.load(sys.stdin)["devices"]
def version(key):
    tail = key.split("iOS-")[-1]
    return [int(part) for part in tail.split("-") if part.isdigit()]
ios = sorted((key for key in runtimes if "iOS" in key and any(d.get("name", "").startswith("iPhone") for d in runtimes[key])), key=version)
if ios:
    key = ios[-1]
    phones = [d for d in runtimes[key] if d.get("name", "").startswith("iPhone") and d.get("isAvailable", True)]
    preferred = [d for d in phones if d["name"] == "iPhone 16"] or phones
    print(preferred[0]["udid"] + " " + key.split(".")[-1] + " " + preferred[0]["name"])
')
if [ -z "$chosen" ]; then
    annotate error "the iOS simulator" "no iPhone simulator is available on this runner: $(xcrun simctl list runtimes 2>&1 | head -n 6 | tr '\n' ' ')"
    exit 1
fi
udid=${chosen%% *}
annotate notice "the iOS simulator" "$chosen ($(xcodebuild -version 2>&1 | tr '\n' ' '))"

xcrun simctl boot "$udid" 2>&1 | head -n 3
if ! xcrun simctl bootstatus "$udid" -b >"$out/boot.log" 2>&1; then
    annotate error "the iOS simulator" "it did not boot: $(tail -n 3 "$out/boot.log" | tr '\n' ' ')"
    exit 1
fi
# The account server, when the job has made one possible: the app is told where it is by a file of its own Documents folder.
if [ "${ZIM_E2E_SERVER:-}" = "1" ]; then
    mkdir -p "$out/server"
    node "$here/ios-server.mjs" "$out/server" >"$out/server.log" 2>&1 &
    server_pid=$!
    for i in $(seq 1 60); do
        [ -f "$out/server/server.json" ] && break
        kill -0 "$server_pid" 2>/dev/null || break
        sleep 1
    done
    if [ -f "$out/server/server.json" ]; then
        annotate notice "the account server" "$(head -c 400 "$out/server.log" | tr '\n' ' ')"
    else
        annotate error "the account server" "it did not start: $(tail -n 6 "$out/server.log" | tr '\n' ' ')"
        server_pid=""
        failed=1
    fi
fi

# The app, installed as if it had never been (nothing of an earlier install is left), and told where the account server is.
data=""
results=""
install_fresh() {
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1
    if ! xcrun simctl install "$udid" "$1" >"$out/install.log" 2>&1; then
        annotate error "the iOS app" "it could not be installed: $(tail -n 3 "$out/install.log" | tr '\n' ' ')"
        return 1
    fi
    data=$(xcrun simctl get_app_container "$udid" "$bundle" data)
    results="$data/Documents/e2e"
    mkdir -p "$results"
    if [ -f "$out/server/server.json" ]; then cp "$out/server/server.json" "$results/server.json"; fi
    return 0
}

# What the system noted of an app that did not start or said nothing: the crash report that came after this job began (how it ended, and where), and what the system's springboard said of it.
crash_summary() {
    local report
    report=$(ls -t "$HOME"/Library/Logs/DiagnosticReports/App-*.ips 2>/dev/null | head -n 1)
    if [ -n "$report" ] && [ "$report" -nt "$out/started" ]; then
        python3 - "$report" <<'PY'
import json, sys
text = open(sys.argv[1], errors="replace").read()
head, _, body = text.partition("\n")
try:
    report = json.loads(body)
except Exception:
    print("a crash report that could not be read: " + text[:300].replace("\n", " "))
    sys.exit(0)
exc, term = report.get("exception", {}), report.get("termination", {})
frames = []
threads = report.get("threads", [])
index = report.get("faultingThread")
if isinstance(index, int) and index < len(threads):
    frames = [f.get("symbol") or f"{f.get('imageIndex')}+{f.get('imageOffset')}" for f in threads[index].get("frames", [])[:8]]
asi = report.get("asi")
print("crash: " + " ".join(str(x) for x in (exc.get("type"), exc.get("signal"), exc.get("subtype"), term.get("namespace"), term.get("indicator"), term.get("reasons"))) + " | asi: " + json.dumps(asi)[:200] + " | in: " + " < ".join(frames))
PY
    else
        echo "no crash report"
    fi
    xcrun simctl spawn "$udid" log show --last 4m --style compact --predicate '(process == "SpringBoard" OR process == "backboardd" OR process == "installd") AND eventMessage CONTAINS[c] "zimnotebook"' 2>/dev/null | tail -n 6 | cut -c1-220
}
touch "$out/started"

# What the app did, as the app wrote it: waited for up to `$2` seconds (180 by default).
wait_for_run() {
    local n="$1" limit="${2:-180}" i
    for i in $(seq 1 $((limit / 2))); do
        if [ -f "$results/run-$n.json" ] && grep -q '"final":true' "$results/run-$n.json"; then return 0; fi
        sleep 2
    done
    return 1
}

# What there is to look at when an app says nothing: how it ended, and what the system noted of it (the level is `error`, or `warning` for what is only being tried).
diagnose() {
    local n="$1" level="${2:-error}" label="${3:-iOS app run $1}"
    xcrun simctl spawn "$udid" log show --last 6m --style compact --predicate 'process == "App"' 2>/dev/null | tail -n 60 >"$out/app-$n.log"
    annotate "$level" "$label" "it wrote no result. What the system noted of it: $(crash_summary | tr '\n' ' ') $(tail -n 4 "$out/app-$n.log" | tr '\n' ' ')"
    xcrun simctl io "$udid" screenshot "$out/run-$n-screen.png" >/dev/null 2>&1
    [ -d "$results" ] && cp "$results"/* "$out"/ 2>/dev/null
    return 0
}

# One start of the app: it is launched and its result is waited for. 0 if it wrote one.
run_app() {
    local n="$1" limit="${2:-180}" label="${3:-iOS app run $1}"
    if ! xcrun simctl launch "$udid" "$bundle" >"$out/launch-$n.log" 2>&1; then
        annotate error "$label" "it did not start: $(tail -n 3 "$out/launch-$n.log" | tr '\n' ' ') $(crash_summary | tr '\n' ' ')"
        return 1
    fi
    if ! wait_for_run "$n" "$limit"; then
        diagnose "$n" error "$label"
        return 1
    fi
    return 0
}

# Run 1: the app as the build made it. (It is signed ad hoc, as Xcode signs for a simulator, with the keychain group of `App.entitlements` put into the binary, which is what lets its keychain work:
# a signature made afterwards with such entitlements is refused by the system, "Code Signature Invalid", because a restricted entitlement needs a provisioning profile that a simulator build has not.)
kept=""
if [ "$failed" = 0 ]; then
    annotate notice "iOS app signature" "as built: $(codesign -dvv "$app" 2>&1 | grep -E "^(Signature|Authority|TeamIdentifier|Identifier)" | tr '\n' ' ' | cut -c1-300) $(codesign -d --entitlements :- "$app" 2>/dev/null | tr -d '\n' | cut -c1-200)"
    if install_fresh "$app" && run_app 1 180 "iOS app run 1"; then
        xcrun simctl io "$udid" screenshot "$out/run-1-screen.png" >/dev/null 2>&1
        cp "$results/run-1.json" "$out/run-1.json"
        kept=1
        # (a step of the run that failed may be about the system's sign-in sheet: what the system said of it is told, to be read with that step)
        if grep -q '"ok":false' "$results/run-1.json"; then
            xcrun simctl spawn "$udid" log show --last 10m --style compact --predicate 'process == "SafariViewService" OR eventMessage CONTAINS[c] "ASWebAuthenticationSession" OR eventMessage CONTAINS[c] "AuthenticationServices"' 2>/dev/null | tail -n 12 | cut -c1-200 >"$out/safari.log"
            annotate warning "iOS system log about the sign-in sheet" "$(tr '\n' '|' <"$out/safari.log")"
        fi
    else
        failed=1
    fi
fi

# Run 2: the app is closed, as a person closes it (what it kept is what the next start finds), and started again.
if [ -n "$kept" ]; then
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    sleep 3
    if run_app 2 180 "iOS app run 2"; then
        xcrun simctl io "$udid" screenshot "$out/run-2-screen.png" >/dev/null 2>&1
        cp "$results/run-2.json" "$out/" 2>/dev/null
        xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    else
        failed=1
    fi
fi

if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null
fi

# What each run says, as annotations; the exit status is whether both were well (the first with nothing before it, the second with what the first wrote).
ZIM_E2E_SERVER_STARTED=$([ -n "$server_pid" ] && echo 1 || echo 0) python3 - "$out" <<'PY' || failed=1
import glob, json, os, sys

def say(level, title, text):
    text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{level} title={title}::{text[:900]}")

bad = False
runs = sorted(glob.glob(os.path.join(sys.argv[1], "run-*.json")))
if not runs:
    say("error", "the iOS app", "no run wrote a result")
    bad = True
for path in runs:
    run = json.load(open(path))
    label = f"iOS app run {run.get('run')}"
    level = "error"
    steps = ", ".join(("ok " if s["ok"] else "FAILED ") + s["name"] for s in run.get("steps", []))
    say("notice", label, f"phase {run.get('phase')}, {run.get('seconds')} s, ok={run.get('ok')}: {steps}")
    if run.get("run") == 1:
        say("notice", label + " WebView", json.dumps(run.get("environment", {}), separators=(",", ":")))
    if run.get("errors"):
        say("warning", label + " page", " | ".join(run["errors"]))
    for s in run.get("steps", []):
        if not s["ok"]:
            say(level, label, f"{s['name']}: {s.get('error')}")
            bad = bad or level == "error"
    if run.get("error"):
        say(level, label, str(run["error"]))
        bad = bad or level == "error"
    if not run.get("ok") and level == "error":
        bad = True
    # (with a server started, the app has to have tried itself against it: a shell that gave the page no account would leave all of that out, and say nothing)
    if os.environ.get("ZIM_E2E_SERVER_STARTED") == "1" and not any("plain http" in s["name"] or "certificate that was trusted" in s["name"] for s in run.get("steps", [])):
        say("error", label, "the app did not try itself against the account server (no account steps ran)")
        bad = True
    if run.get("run") == 1 and run.get("phase") != 1:
        say("error", label, "the first run found what only a run could have written")
        bad = True
    if run.get("run") == 2 and run.get("phase") != 2:
        say("error", label, "what the first run wrote was not there after the app was closed and started again")
        bad = True
if len(runs) < 2:
    say("error", "the iOS app", "the second run did not happen or wrote nothing")
    bad = True
seen_path = os.path.join(sys.argv[1], "server", "seen.jsonl")
if os.path.exists(seen_path):
    entries = [json.loads(line) for line in open(seen_path) if line.strip()]
    secure = [e for e in entries if e.get("secure")]
    say("notice", "the account server", f"it was asked {len(entries)} times by the app ({len(secure)} over https): " + ", ".join(f"{e['method']} {e['url']}" for e in entries[:30]))

sys.exit(1 if bad else 0)
PY

xcrun simctl shutdown "$udid" >/dev/null 2>&1
exit "$failed"
