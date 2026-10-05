#!/usr/bin/env bash
# One-time setup for test/browser.mjs, which drives the built editor in a real Chromium with real
# keystrokes and mouse clicks. Needs no root.
#
# It must be the *full* Chromium (Playwright's build, new headless mode), not the old-style headless
# shell that core/turtl-core-rs/scripts/setup-browser-tests.sh installs for the core's tests:
# that shell mishandles keyboard input in contenteditable elements (each typed character replaces
# the element's whole content, even in a plain <div contenteditable> with no editor at all), so it
# cannot test an editor. Any system library the browser lacks is downloaded as a .deb with
# `apt-get download` (which doesn't need root), together with its dependencies that aren't
# installed, and unpacked under ~/.cache/turtlzim-browser-libs, where the test looks for it.
#
# It also installs a font (DejaVu) there, with a fontconfig file the test points Chromium at. A
# machine without any font is common for servers, and it makes a browser useless for testing an
# editor: Blink cannot resolve a caret to a rendered text position, so typing a character replaces
# the whole content of the editable element, and form controls crash the renderer.
# Re-running is harmless.
#
# If you'd rather install the libraries system-wide, run the `apt-get install` line that
# `npx playwright-core install-deps --dry-run chromium` prints.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
npx playwright-core install chromium

chrome=$(find "$HOME/.cache/ms-playwright" -type f -name chrome -path '*chromium-*' | sort | tail -1)
[ -n "$chrome" ] || { echo "Chromium wasn't installed" >&2; exit 1; }
echo "browser: $chrome"

libs="$HOME/.cache/turtlzim-browser-libs"
export LD_LIBRARY_PATH="$libs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
missing=$(ldd "$chrome" 2>&1 | grep 'not found' | awk '{print $1}' || true)
if [ -n "$missing" ]; then
    echo "missing system libraries: $(echo $missing | tr '\n' ' ')"
    echo "fetching them without root into $libs ..."
    mkdir -p "$libs/debs" "$libs/root"
    # Playwright knows what its Chromium needs on this OS; fetch what is not installed here.
    wanted=$(npx playwright-core install-deps --dry-run chromium 2>&1 \
        | grep -E '^\s+[a-z0-9]' | tr -d ' ' | grep -v -E '^(xfonts|xserver|xvfb|fonts-|x11-)' || true)
    todo=""
    for package in $wanted; do dpkg -s "$package" >/dev/null 2>&1 || todo="$todo $package"; done
    (cd "$libs/debs" && apt-get download $todo)
    for deb in "$libs"/debs/*.deb; do dpkg -x "$deb" "$libs/root"; done
    missing=$(ldd "$chrome" 2>&1 | grep 'not found' | awk '{print $1}' || true)
    if [ -n "$missing" ]; then
        echo "still missing: $(echo $missing | tr '\n' ' ')" >&2
        echo "install them with: sudo apt-get install -y$todo" >&2
        exit 1
    fi
fi
# Fonts. DejaVu is small and covers Latin, Greek, Cyrillic and Hebrew, which is plenty for the tests.
fonts="$libs/fonts"
if [ -z "$(ls "$fonts"/*.ttf 2>/dev/null)" ]; then
    mkdir -p "$libs/debs" "$libs/root" "$fonts" "$libs/fontcache"
    (cd "$libs/debs" && apt-get download fonts-dejavu-core)
    for deb in "$libs"/debs/fonts-dejavu-core_*.deb; do dpkg -x "$deb" "$libs/root"; done
    cp "$libs"/root/usr/share/fonts/truetype/dejavu/*.ttf "$fonts"/
fi
cat > "$libs/fonts.conf" <<CONF
<?xml version="1.0"?>
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>$fonts</dir>
  <cachedir>$libs/fontcache</cachedir>
</fontconfig>
CONF

"$chrome" --version
echo "ready: npm run build && npm run test:browser"
