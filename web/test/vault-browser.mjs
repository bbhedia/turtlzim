// The vault in a real browser (headless Chromium), built the way the app is built (vite.lab.config.ts)
// and served under the app's own Content-Security-Policy: what Node can't show. That the engine
// loads and runs in a module Worker with its wasm and libsodium, that the encrypted data is kept in
// the browser's private file system and is there after a reload, that only one tab holds it at a
// time, that an insecure page is told it can't have it, and that none of what is kept can be read.
//
//   cd web
//   npm run core                                              # once: builds the engine's wasm (needs wasm-pack)
//   scripts/setup-browser.sh                                  # once: Chromium, libraries and a font, no root
//   npm run test:vault
//
// Environment: CHROME_PATH, CHROME_LIB_PATH (see browser-launch.mjs); ONLY (run the scenarios whose name contains this text).
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { launchBrowser } from "./browser-launch.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npx", ["vite", "build", "-c", "vite.lab.config.ts", "--logLevel", "warn"], { cwd: web, stdio: "inherit" });

const server = createStaticServer({ dir: fileURLToPath(new URL("../dist-lab/", import.meta.url)) });
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
// an address of this machine that is not "localhost": a page from it is not a secure context
const lanAddress = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;

// --- a very small test runner ---------------------------------------------------------------

const results = [];
let problems = [];

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

async function scenario(name, run) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  problems = [];
  const started = Date.now();
  try {
    await run();
    if (problems.length) throw new Error(`the page reported errors:\n    ${problems.join("\n    ")}`);
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
}

let browser;

/** A page of the lab in `context` (a browser profile of its own unless one is given), with what it reports collected. `expected` is what the browser says that is no surprise. */
async function openLab(context, where = origin, expected = []) {
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`[page error] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !expected.some((pattern) => pattern.test(message.text()))) problems.push(`[console error] ${message.text()}`);
  });
  await page.goto(`${where}/`);
  await page.waitForFunction(() => window.lab !== undefined);
  return page;
}

const PASSPHRASE = "pale river stone lantern";
const lab = (page, call, ...args) => page.evaluate(({ call, args }) => window.lab[call](...args), { call, args });
const mustWork = async (outcome, what) => {
  assert(outcome.ok, `${what}: ${outcome.error}: ${outcome.message}`);
  return outcome.value;
};

function contains(bytes, text) {
  const needle = Buffer.from(text);
  return Buffer.from(bytes).includes(needle);
}

// --- the scenarios --------------------------------------------------------------------------

try {
  browser = await launchBrowser();
  const fresh = async () => {
    const context = await browser.newContext();
    context.setDefaultTimeout(30_000);
    return context;
  };

  await scenario("the engine runs in a Worker: the vault is made, locked, and unlocked again", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      assertEqual(await lab(page, "secureContext"), true, "a page from localhost is a secure context");
      assertEqual((await lab(page, "support")).ok, true, "this browser can keep a vault");
      assertEqual(await mustWork(await lab(page, "exists"), "looking for a vault"), false, "nothing yet");

      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      assertEqual(await lab(page, "unlocked"), true, "unlocked after making it");
      const name = await mustWork(await lab(page, "whoAmI"), "asking the engine who is in");
      assert(/^[0-9a-f]{32}$/.test(name), `the vault has a random name of its own: ${name}`);

      await mustWork(await lab(page, "lock"), "locking");
      assertEqual(await lab(page, "unlocked"), false, "locked");
      const refused = await lab(page, "whoAmI");
      assert(!refused.ok, "a locked vault answers nothing");

      const wrong = await lab(page, "unlock", "pale river stone lantern!");
      assertEqual([wrong.ok, wrong.error], [false, "WrongPassphraseError"], "a wrong passphrase is refused");
      assertEqual(await lab(page, "unlocked"), false, "and leaves it locked");
      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking");
      assertEqual(await mustWork(await lab(page, "whoAmI"), "asking again"), name, "the same vault");
      await mustWork(await lab(page, "lock"), "locking again");
    } finally {
      await context.close();
    }
  });

  await scenario("what was made is there after the page is reloaded, also when it was closed while unlocked", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const name = await mustWork(await lab(page, "whoAmI"), "asking");
      // (the page goes away with the vault unlocked: its Worker is ended in the middle of whatever it was doing)
      await page.reload();
      await page.waitForFunction(() => window.lab !== undefined);
      assertEqual(await lab(page, "unlocked"), false, "a reloaded page is locked");
      assertEqual(await mustWork(await lab(page, "exists"), "looking"), true, "the vault is there");
      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking after the reload");
      assertEqual(await mustWork(await lab(page, "whoAmI"), "asking"), name, "the same vault");
      assertEqual(await mustWork(await lab(page, "accounts"), "listing"), [name], "and only one");
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  await scenario("only one tab holds the vault at a time", async () => {
    const context = await fresh();
    try {
      const first = await openLab(context);
      const second = await openLab(context);
      await mustWork(await lab(first, "create", PASSPHRASE), "making the vault in the first tab");
      const refused = await lab(second, "unlock", PASSPHRASE);
      assertEqual([refused.ok, refused.error], [false, "VaultBusyError"], "the second tab is told it is in use");
      assert(/another tab/.test(refused.message), `and why: ${refused.message}`);
      await mustWork(await lab(first, "lock"), "locking in the first tab");
      await mustWork(await lab(second, "unlock", PASSPHRASE), "the second tab, once the first has let go");
      assertEqual(await lab(first, "unlocked"), false, "the first is still locked");
      await mustWork(await lab(second, "lock"), "locking in the second tab");
    } finally {
      await context.close();
    }
  });

  await scenario("a vault can be erased, and made again", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const erasing = await lab(page, "erase");
      assert(!erasing.ok, "an unlocked vault can't be erased");
      await mustWork(await lab(page, "lock"), "locking");
      await mustWork(await lab(page, "erase"), "erasing");
      assertEqual(await mustWork(await lab(page, "exists"), "looking"), false, "nothing is left");
      const nothing = await lab(page, "unlock", PASSPHRASE);
      assertEqual([nothing.ok, nothing.error], [false, "NoVaultError"], "there is nothing to unlock");
      await mustWork(await lab(page, "create", "another passphrase altogether"), "making a new one");
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  await scenario("what the browser keeps does not hold the passphrase", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const name = await mustWork(await lab(page, "whoAmI"), "asking");
      await mustWork(await lab(page, "lock"), "locking");
      // (the files are the SQLite databases and their pool: the account is in them, by its random name)
      const files = await mustWork(await lab(page, "opfsFiles"), "reading what the browser keeps");
      assert(files.length > 0, "the browser keeps something");
      assert(files.some(([, bytes]) => contains(bytes, name)), "the account's random name is in them (which shows the files were read)");
      for (const [path, bytes] of files) {
        assert(!contains(bytes, PASSPHRASE), `the passphrase is in ${path}`);
        assert(!contains(bytes, "pale river"), `a part of the passphrase is in ${path}`);
      }
    } finally {
      await context.close();
    }
  });

  await scenario("a page that is not secure is told it can't have encrypted notebooks", async () => {
    if (!lanAddress) {
      console.log("  (skipped: this machine has no address but localhost)");
      return;
    }
    const context = await fresh();
    try {
      // (a browser ignores the COOP header of a page that is not secure, and says so)
      const page = await openLab(context, `http://${lanAddress}:${port}`, [/Cross-Origin-Opener-Policy header has been ignored/]);
      assertEqual(await lab(page, "secureContext"), false, "a page from a plain address is not a secure context");
      const support = await lab(page, "support");
      assertEqual(support.ok, false, "not supported");
      assert(/secure page/.test(support.reason), `and the reason says so: ${support.reason}`);
      const refused = await lab(page, "create", PASSPHRASE);
      assertEqual([refused.ok, refused.error], [false, "VaultUnavailableError"], "making a vault is refused");
    } finally {
      await context.close();
    }
  });
} finally {
  if (browser) await browser.close();
  server.close();
}

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.ok ? ` (${result.ms} ms)` : `\n${result.error}`}`);
}
if (results.length === 0 || results.some((result) => !result.ok)) {
  console.log("vault browser tests FAILED");
  process.exit(1);
}
console.log("vault browser tests OK");
