#!/usr/bin/env bash
# One-time setup for js/browser_test.mjs, which runs the production wasm package in a real
# (headless Chromium) browser. Needs no root: the browser is Playwright's headless shell, installed
# under ~/.cache/ms-playwright, and any system library it lacks is downloaded as a .deb with
# `apt-get download` (which doesn't need root) and unpacked under ~/.cache/turtlzim-browser-libs,
# where the test runner looks for it. Run it from anywhere; re-running is harmless.
#
# If you'd rather install the libraries system-wide, `sudo apt-get install -y $PACKAGES` (below)
# does the same and this script then has nothing left to fetch.
set -euo pipefail
cd "$(dirname "$0")/.."

# What Chromium's headless shell needs beyond a bare Ubuntu server (names as on Ubuntu 24.04+; the
# `t64` ones are the renamed time_t-transition packages).
PACKAGES="libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libasound2t64 libgbm1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxrender1 libxi6 libxres1"

npm install
npx playwright-core install chromium-headless-shell

chrome=$(find "$HOME/.cache/ms-playwright" -type f -name chrome-headless-shell -path '*chromium_headless_shell*' | sort | tail -1)
[ -n "$chrome" ] || { echo "the headless shell wasn't installed" >&2; exit 1; }
echo "browser: $chrome"

libs="$HOME/.cache/turtlzim-browser-libs"
export LD_LIBRARY_PATH="$libs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
missing=$(ldd "$chrome" 2>&1 | grep 'not found' | awk '{print $1}' || true)
if [ -n "$missing" ]; then
    echo "missing system libraries: $(echo $missing | tr '\n' ' ')"
    echo "fetching them without root into $libs ..."
    mkdir -p "$libs/debs" "$libs/root"
    (cd "$libs/debs" && apt-get download $PACKAGES)
    for deb in "$libs"/debs/*.deb; do dpkg -x "$deb" "$libs/root"; done
    missing=$(ldd "$chrome" 2>&1 | grep 'not found' | awk '{print $1}' || true)
    if [ -n "$missing" ]; then
        echo "still missing: $(echo $missing | tr '\n' ' ')" >&2
        echo "install them with: sudo apt-get install -y $PACKAGES   (plus whatever provides the above)" >&2
        exit 1
    fi
fi
"$chrome" --version
echo "ready: run  node js/browser_test.mjs  (after  wasm-pack build --target web)"
