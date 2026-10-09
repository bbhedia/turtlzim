// What unlocking the vault costs as the vault grows, in a real browser (headless Chromium), built the way the app is
// built (see vault-browser.mjs). Unlocking is the passphrase made into a key (scrypt at 128 MiB: the same whatever the
// vault holds) and then every page of every encrypted notebook decrypted and indexed (which grows with what is in it).
// Each size is a vault of its own, made, locked, and unlocked after a reload, as a person's is.
//
//   cd web
//   npm run core && scripts/setup-browser.sh        # once
//   node test/measure-unlock.mjs [pages ...]         # default: 0 300 1500 6000; pages are of about 1.5 KB
//
// Environment: CHROME_PATH, CHROME_LIB_PATH (see browser-launch.mjs); PAGE_BYTES (the size of a page, default 1500).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { launchBrowser } from "./browser-launch.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npx", ["vite", "build", "-c", "vite.lab.config.ts", "--logLevel", "warn"], { cwd: web, stdio: "inherit" });
const server = createStaticServer({ dir: fileURLToPath(new URL("../dist-lab/", import.meta.url)) });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [0, 300, 1500, 6000];
const pageBytes = Number(process.env.PAGE_BYTES ?? 1500);
const PASSPHRASE = "pale river stone lantern";
const lab = (page, call, ...args) => page.evaluate(({ call, args }) => window.lab[call](...args), { call, args });
const must = async (outcome, what) => {
  if (!outcome.ok) throw new Error(`${what}: ${outcome.error}: ${outcome.message}`);
  return outcome.value;
};

const browser = await launchBrowser();
const rows = [];
try {
  for (const pages of sizes) {
    const context = await browser.newContext();
    context.setDefaultTimeout(600_000);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.lab !== undefined);
    await must(await lab(page, "create", PASSPHRASE), "making the vault");
    const made = await must(await page.evaluate(() => window.lab.notebooks.create("Big", [["Home", "start"]], [])), "making a notebook");
    // (written in groups, so that no message to the engine is a big one)
    const written = Date.now();
    for (let from = 0; from < pages; from += 250) {
      const put = Array.from({ length: Math.min(250, pages - from) }, (_, i) => [`Page ${from + i}`, `${from + i} ${"lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(pageBytes / 57)).slice(0, pageBytes)}`]);
      await must(await page.evaluate(([id, put]) => window.lab.notebooks.replace(id, [], put), [made.id, put]), "writing pages");
    }
    const writeMs = Date.now() - written;
    await must(await lab(page, "lock"), "locking");
    await page.reload();
    await page.waitForFunction(() => window.lab !== undefined);

    const started = Date.now();
    await must(await lab(page, "unlock", PASSPHRASE), "unlocking");
    const unlockMs = Date.now() - started;
    const loading = Date.now();
    const loaded = await must(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading the pages");
    const loadMs = Date.now() - loading;
    await must(await lab(page, "lock"), "locking");
    rows.push({ pages: pages + 1, megabytes: ((pages * pageBytes) / 1048576).toFixed(1), unlockMs, loadMs, writeMs, read: loaded.length });
    console.log(`${String(pages + 1).padStart(6)} pages (${rows.at(-1).megabytes} MB of text): unlock ${unlockMs} ms, then reading the notebook ${loadMs} ms (writing it took ${writeMs} ms)`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
const base = rows[0]?.unlockMs ?? 0;
console.log("\npages     MB   unlock (ms)   beyond the passphrase (ms)   per page (ms)   read the notebook (ms)");
for (const r of rows) console.log(`${String(r.pages).padStart(6)} ${r.megabytes.padStart(6)} ${String(r.unlockMs).padStart(13)} ${String(r.unlockMs - base).padStart(28)} ${(r.pages > 1 ? (r.unlockMs - base) / r.pages : 0).toFixed(2).padStart(15)} ${String(r.loadMs).padStart(24)}`);
