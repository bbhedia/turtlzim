#!/usr/bin/env bash
# CI's half of the test of the app in an iPhone's WebView (docs/zim-mobile-shell.md, job `ios` of .github/workflows/desktop.yml): the app that xcodebuild made is installed in a simulator and
# started; its own test (test/ios-e2e.ts, a build made with ZIM_E2E=1) writes what it did in a file of its Documents folder, which is read here from the simulator's disk; then the app is closed
# and started again, and its test says what the restart did to what was written. What happened is said as annotations of the check (a job's log is for whoever is signed in), and is kept in
# the folder that is given, which the workflow uploads.
#
#   scripts/ios-ci.sh APP.app [OUT-FOLDER]          (macOS, Xcode; bash 3.2 is enough)
set -uo pipefail

app="${1:?the App.app that xcodebuild made}"
out="${2:-${RUNNER_TEMP:-/tmp}/ios-e2e}"
bundle="org.zimnotebook.app"
mkdir -p "$out"

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
if ! xcrun simctl install "$udid" "$app" 2>&1 | tee "$out/install.log"; then
    annotate error "the iOS app" "it could not be installed: $(tail -n 3 "$out/install.log" | tr '\n' ' ')"
    exit 1
fi
data=$(xcrun simctl get_app_container "$udid" "$bundle" data)
results="$data/Documents/e2e"

# What the app did, as the app wrote it: waited for up to five minutes.
wait_for_run() {
    local n="$1" i
    for i in $(seq 1 150); do
        if [ -f "$results/run-$n.json" ] && grep -q '"final":true' "$results/run-$n.json"; then return 0; fi
        sleep 2
    done
    return 1
}

# What there is to look at when an app says nothing: how it ended, and what the system noted of it.
diagnose() {
    local n="$1"
    xcrun simctl spawn "$udid" log show --last 6m --style compact --predicate 'process == "App"' 2>/dev/null | tail -n 60 >"$out/app-$n.log"
    annotate error "iOS app run $n" "it wrote no result in five minutes. What the system noted of it: $(tail -n 8 "$out/app-$n.log" | tr '\n' ' ')"
    ls -t "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | head -n 5 | while IFS= read -r report; do annotate error "iOS app run $n" "a crash report: $report"; done
    xcrun simctl io "$udid" screenshot "$out/run-$n-screen.png" >/dev/null 2>&1
    [ -d "$results" ] && cp "$results"/* "$out"/ 2>/dev/null
    return 0
}

failed=0
for n in 1 2; do
    xcrun simctl launch "$udid" "$bundle" >"$out/launch-$n.log" 2>&1 || annotate error "iOS app run $n" "it did not start: $(tail -n 3 "$out/launch-$n.log" | tr '\n' ' ')"
    if ! wait_for_run "$n"; then
        diagnose "$n"
        failed=1
        break
    fi
    xcrun simctl io "$udid" screenshot "$out/run-$n-screen.png" >/dev/null 2>&1
    cp "$results/run-$n.json" "$out/" 2>/dev/null
    # (the app is closed, as a person closes it: what it kept is what the next start finds)
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    sleep 3
done

# What each run says, as annotations; the exit status is whether both were well (the first with nothing before it, the second with what the first wrote).
python3 - "$out" <<'PY' || failed=1
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
    steps = ", ".join(("ok " if s["ok"] else "FAILED ") + s["name"] for s in run.get("steps", []))
    say("notice", label, f"phase {run.get('phase')}, {run.get('seconds')} s, ok={run.get('ok')}: {steps}")
    say("notice", label + " WebView", json.dumps(run.get("environment", {}), separators=(",", ":")))
    if run.get("errors"):
        say("warning", label + " page", " | ".join(run["errors"]))
    for s in run.get("steps", []):
        if not s["ok"]:
            say("error", label, f"{s['name']}: {s.get('error')}")
            bad = True
    if run.get("error"):
        say("error", label, str(run["error"]))
        bad = True
    if not run.get("ok"):
        bad = True
    if run.get("run") == 1 and run.get("phase") != 1:
        say("error", label, "the first run found what only a run could have written")
        bad = True
    if run.get("run") == 2 and run.get("phase") != 2:
        say("error", label, "what the first run wrote was not there after the app was closed and started again")
        bad = True
if len([r for r in runs]) < 2:
    say("error", "the iOS app", "the second run did not happen or wrote nothing")
    bad = True
sys.exit(1 if bad else 0)
PY

xcrun simctl shutdown "$udid" >/dev/null 2>&1
exit "$failed"
