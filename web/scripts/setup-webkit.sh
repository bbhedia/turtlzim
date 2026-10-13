#!/usr/bin/env bash
# One-time setup for running test/browser.mjs in WebKit (ZIM_BROWSER=webkit, `npm run test:browser:webkit`): the engine of an
# iPhone's Safari, which behaves differently from Chromium where it matters for a phone (a cancelled pointerdown loses the click,
# for one). Needs no root, and scripts/setup-browser.sh must have been run (its fonts are used).
#
# Playwright's WebKit refuses to install when some library is missing from the machine, though the files are there by then.
# What the browser's own programs lack (ldd says) is fetched as .deb files with `apt-get download`, which needs no root, unpacked
# under ~/.cache/turtlzim-browser-libs, and copied into the browser's own library folder (its launcher sets the library path
# itself, so the path of the shell does not reach it). The package of a library is found by its name: libevent-2.1.so.7 is
# libevent-2.1-7t64, libavif.so.16 is libavif16. Re-running is harmless.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
# (the check of the host's libraries fails here when any is missing, and that is what the rest of this script puts right)
npx playwright-core install webkit || true

dir=$(ls -d "$HOME"/.cache/ms-playwright/webkit-* 2>/dev/null | sort | tail -1)
wpe="$dir/minibrowser-wpe"
[ -d "$wpe" ] || { echo "WebKit wasn't installed" >&2; exit 1; }
echo "browser: $wpe"

libs="$HOME/.cache/turtlzim-browser-libs"
mkdir -p "$libs/debs" "$libs/root" "$wpe/sys/lib"
missing() { LD_LIBRARY_PATH="$wpe/lib:$wpe/sys/lib" ldd "$wpe"/bin/* 2>&1 | grep 'not found' | awk '{print $1}' | sort -u || true; }

for round in 1 2 3 4 5; do
    list=$(missing)
    [ -z "$list" ] && break
    echo "missing system libraries: $(echo $list | tr '\n' ' ')"
    for soname in $list; do
        base=${soname%%.so.*}
        version=${soname##*.so.}
        package=""
        for candidate in "$base$version" "$base-$version" "$base-${version}t64" "$base${version}t64"; do
            # (a name that only some other package provides is known to apt and has no candidate: that one is not it)
            have=$(apt-cache policy "$candidate" 2>/dev/null | awk '/Candidate:/ {print $2}')
            if [ -n "$have" ] && [ "$have" != "(none)" ]; then package=$candidate; break; fi
        done
        if [ -z "$package" ]; then echo "no package found for $soname" >&2; continue; fi
        (cd "$libs/debs" && apt-get download "$package")
        dpkg -x "$libs"/debs/"${package}"_*.deb "$libs/root"
        cp -a "$libs"/root/usr/lib/*/"$soname"* "$wpe/sys/lib/"
    done
done

left=$(missing)
if [ -n "$left" ]; then
    echo "still missing: $(echo $left | tr '\n' ' ')" >&2
    echo "install them with: sudo apt-get install -y \$(npx playwright-core install-deps --dry-run webkit 2>&1 | grep -E '^\\s+[a-z0-9]' | tr -d ' ')" >&2
    exit 1
fi
echo "ready: npm run build && npm run test:browser:webkit"
