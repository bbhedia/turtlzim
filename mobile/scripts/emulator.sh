#!/usr/bin/env bash
# The Android emulator that the app is tried in (docs/zim-mobile-shell.md): a Pixel 6 with Android 15 and the WebView that comes with it, with no
# window; what it shows is read with `shot`. Needs /dev/kvm.
#
#   scripts/emulator.sh start | stop | status | shot FILE.png
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/android-env.sh
avd=zim-test
image="system-images;android-35;google_apis;x86_64"
log="${XDG_STATE_HOME:-$HOME/.local/state}/zim-web/emulator.log"
mkdir -p "$(dirname "$log")"

running() { adb devices 2>/dev/null | grep -q "^emulator-.*device$"; }
booted() { [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }

case "${1:-}" in
    start)
        if running && booted; then echo "already running"; exit 0; fi
        if ! avdmanager list avd 2>/dev/null | grep -q "Name: $avd"; then
            echo no | avdmanager create avd -n "$avd" -k "$image" -d pixel_6 --force
            # an on-screen keyboard (an emulator that has a hardware keyboard shows none), and the memory this machine can spare
            printf 'hw.keyboard=no\nhw.ramSize=2048\ndisk.dataPartition.size=4G\n' >>"$HOME/.android/avd/$avd.avd/config.ini"
        fi
        setsid nohup emulator -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -accel on -netdelay none -netspeed full >>"$log" 2>&1 </dev/null &
        adb wait-for-device
        for _ in $(seq 1 240); do booted && break; sleep 2; done
        booted || { echo "the emulator did not finish starting: see $log" >&2; exit 1; }
        # (no animations: a tap or a screenshot would have to wait for them)
        for scale in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global "$scale" 0; done
        echo "ready: $(adb devices | grep '^emulator-')"
        ;;
    stop) adb emu kill >/dev/null 2>&1 || true; echo stopped ;;
    status) if running && booted; then echo ready; else echo "not running"; exit 3; fi ;;
    shot) adb exec-out screencap -p >"${2:?a file name}" ;;
    *) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
