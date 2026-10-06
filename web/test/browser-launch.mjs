// Starting the Chromium the browser tests use: the full build (new headless mode) that
// scripts/setup-browser.sh installs, with the libraries and the font that script put in place.
// The old-style headless shell the core's tests use is not good enough for an editor: it mishandles
// keyboard input (and, on a machine with no fonts at all, so does any browser: see that script).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(base)) {
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      const candidate = join(base, dir, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("no Chromium found: run scripts/setup-browser.sh (or set CHROME_PATH)");
}

// Libraries Chromium needs that the system lacks (CHROME_LIB_PATH, else where setup-browser.sh put them).
function libraryPath() {
  const extra =
    process.env.CHROME_LIB_PATH || join(homedir(), ".cache", "turtlzim-browser-libs", "root", "usr", "lib", "x86_64-linux-gnu");
  return existsSync(extra) ? [extra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") : process.env.LD_LIBRARY_PATH;
}

// A font configuration that includes the fonts scripts/setup-browser.sh installed. Without any font
// a browser cannot edit text, so tests always run with it when it exists.
function fontConfig() {
  const file = join(homedir(), ".cache", "turtlzim-browser-libs", "fonts.conf");
  return existsSync(file) ? { FONTCONFIG_FILE: file } : {};
}

export function launchBrowser() {
  return chromium.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox"],
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath(), ...fontConfig() },
  });
}
