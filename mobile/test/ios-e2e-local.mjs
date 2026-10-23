// The test of the app from the inside (test/ios-e2e.ts) run in a browser: the logic of it (the DOM it drives, the order, what it waits for) is tried here, in Chromium and in WebKit,
// before CI runs it in a real iPhone WebView. A "restart" of the app is a reload of the page, which keeps what the browser keeps (IndexedDB, the file system).
//
//   cd mobile && npm run test:e2e-local            (ZIM_BROWSER=webkit for WebKit; needs ../web/dist: `npm run build` in ../web, and the browsers of ../web/scripts/setup-browser.sh)
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../../web/scripts/serve.mjs";
import { launchBrowser } from "../../web/test/browser-launch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts/prepare.mjs")], { cwd: root, env: { ...process.env, ZIM_E2E: "1" }, stdio: "inherit" });

const server = createStaticServer({ dir: join(root, "www") });
await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
const origin = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block" });
const page = await context.newPage();
page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

const failures = [];
async function result(label) {
  // (the page's own result: `final` is set when the test is over, whatever came of it)
  await page.waitForFunction(() => window.__e2e?.final === true, null, { timeout: 300_000 });
  const done = await page.evaluate(() => window.__e2e);
  for (const step of done.steps) console.log(`${step.ok ? "ok  " : "FAIL"} [${label}] ${step.name} (${step.ms} ms)${step.error ? ` ${step.error}` : ""}`);
  if (done.error) console.log(`FAIL [${label}] ${done.error}`);
  if (done.errors.length) console.log(`     [${label}] the page noted: ${done.errors.join(" | ")}`);
  if (!done.ok) failures.push(label);
  return done;
}

try {
  await page.goto(origin);
  const first = await result("first run");
  if (first.phase !== 1) failures.push(`the first run was the run ${first.phase}`);
  await page.reload();
  const second = await result("after a restart");
  if (second.phase !== 2) failures.push(`what was written was not there after the restart (it was the run ${second.phase})`);
} finally {
  await context.close();
  await browser.close();
  server.close();
}
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "the app works, from the inside");
process.exit(failures.length ? 1 : 0);
