// Runs the production `--target web` package inside a real browser (headless Chromium), in a
// dedicated Worker: what Node can't show, namely that the package loads and runs the way a web app
// loads it (module Worker, wasm and libsodium.js fetched over HTTP, `fetch` to an API) and, with
// OPFS persistence, that data survives a reload.
//
//   cd core/turtl-core-rs
//   wasm-pack build --target web
//   scripts/setup-browser-tests.sh        # once: Playwright's headless Chromium, no root needed
//   node js/browser_test.mjs [scenario ...]
//
// It serves the static files (the package, libsodium.js, js/browser/) and the stand-in Turtl API of
// js/test_support.js from one origin, so there is no CORS to configure, opens
// js/browser/index.html, and waits for js/browser/page.js to report the scenarios' results.
//
// Environment: CHROME_PATH (the headless shell; default: where Playwright puts it) and
// CHROME_LIB_PATH (libraries Chromium needs that the system lacks; default:
// ~/.cache/turtlzim-browser-libs/root/usr/lib/x86_64-linux-gnu if that exists, see the setup script).
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import testSupport from './test_support.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const base = join(homedir(), '.cache', 'ms-playwright');
    if (existsSync(base)) {
        for (const dir of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
            const candidate = join(base, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
            if (existsSync(candidate)) return candidate;
        }
    }
    throw new Error('no headless Chromium found: run scripts/setup-browser-tests.sh (or set CHROME_PATH)');
}

function libraryPath() {
    const extra = process.env.CHROME_LIB_PATH
        || join(homedir(), '.cache', 'turtlzim-browser-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
    return existsSync(extra) ? [extra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') : process.env.LD_LIBRARY_PATH;
}

const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.wasm': 'application/wasm', '.json': 'application/json',
};

// Where each URL prefix of the static site lives. libsodium's ESM build imports its core by the bare
// name `libsodium-sumo`, which a module Worker can't resolve (no import maps there), so the wrapper
// is served with that one import pointed at /vendor: a bundler does this for a real app.
const mounts = [
    ['/pkg/', join(root, 'pkg')],
    ['/js/browser/', join(root, 'js', 'browser')],
    ['/vendor/libsodium-wrappers.mjs', join(root, 'node_modules', 'libsodium-wrappers-sumo', 'dist', 'modules-sumo-esm', 'libsodium-wrappers.mjs')],
    ['/vendor/libsodium-sumo.mjs', join(root, 'node_modules', 'libsodium-sumo', 'dist', 'modules-sumo-esm', 'libsodium-sumo.mjs')],
];

function serveStatic(req, res, pathname) {
    for (const [prefix, target] of mounts) {
        if (!pathname.startsWith(prefix)) continue;
        const isDir = prefix.endsWith('/');
        const file = isDir ? normalize(join(target, pathname.slice(prefix.length))) : target;
        if (isDir && !file.startsWith(target)) break;
        if (!existsSync(file) || !statSync(file).isFile()) break;
        let body = readFileSync(file);
        if (pathname === '/vendor/libsodium-wrappers.mjs') {
            body = Buffer.from(body.toString().replace('from"libsodium-sumo"', 'from"/vendor/libsodium-sumo.mjs"'));
        }
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
        return true;
    }
    return false;
}

const apiHandler = testSupport.createFlowHandler();
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => apiHandler(req, res, body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = true;
let browser;
try {
    browser = await chromium.launch({
        executablePath: findChrome(),
        args: ['--no-sandbox'],
        env: { ...process.env, LD_LIBRARY_PATH: libraryPath() },
    });
    const page = await browser.newPage();
    page.on('console', (message) => console.log(`  [browser ${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`  [browser error] ${error.message}`));
    const scenarios = process.argv.slice(2);
    await page.goto(`${origin}/js/browser/index.html${scenarios.length ? `?scenarios=${scenarios.join(',')}` : ''}`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 240000, polling: 200 });
    const results = await page.evaluate(() => window.__results);
    for (const result of results) {
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? ` (${result.ms} ms)` : `\n${result.error}`}`);
    }
    failed = results.length === 0 || results.some((result) => !result.ok);
} finally {
    if (browser) await browser.close();
    server.close();
    testSupport.stopServer();
}
if (failed) {
    console.log('browser tests FAILED');
    process.exit(1);
}
console.log('browser tests OK');
