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
async function openLab(context, where = origin, expected = [], query = "") {
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`[page error] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !expected.some((pattern) => pattern.test(message.text()))) problems.push(`[console error] ${message.text()}`);
  });
  await page.goto(`${where}/${query}`);
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

  const SECRETS = {
    notebook: "Zebra Journal", home: "Secret Plans Page", text: "the vault door code is 7391", other: "Hidden Sub Page Name",
    path: "diagram-4417.png", bytes: "ATTACHMENT-BYTES-5529", type: "image/x-secret",
  };

  await scenario("encrypted notebooks are kept across a reload, and nothing of them can be read from what the browser keeps", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const made = await mustWork(
        await page.evaluate((s) => window.lab.notebooks.create(s.notebook, [["Home", `${s.home} ${s.text}`], [`Home:${s.other}`, "second page"]], [[s.path, s.bytes, s.type]]), SECRETS),
        "making a notebook",
      );
      assertEqual([made.title, made.kind], [SECRETS.notebook, "encrypted"], "the notebook is as asked for");
      await mustWork(await page.evaluate(([id, s]) => window.lab.notebooks.replace(id, [], [["Home", `${s.home} ${s.text}, edited`]]), [made.id, SECRETS]), "editing a page");
      await mustWork(await lab(page, "lock"), "locking");

      // what the browser keeps: the ids are there (the files are the right ones to look in), the secrets are not
      const files = await mustWork(await lab(page, "opfsFiles"), "reading what the browser keeps");
      assert(files.some(([, bytes]) => contains(bytes, made.id)), "the notebook's id is in them (which shows the files were read)");
      for (const secret of [...Object.values(SECRETS), "second page", "edited", PASSPHRASE]) {
        for (const [path, bytes] of files) assert(!contains(bytes, secret), `${JSON.stringify(secret)} is in ${path}`);
      }

      // after a reload and an unlock everything is there, as it was written
      await page.reload();
      await page.waitForFunction(() => window.lab !== undefined);
      const refused = await page.evaluate(() => window.lab.notebooks.list());
      assertEqual(refused.ok, false, "a locked vault shows nothing");
      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking");
      const listed = await mustWork(await page.evaluate(() => window.lab.notebooks.list()), "listing");
      assertEqual(listed.map((n) => [n.id, n.title, n.home, n.kind]), [[made.id, SECRETS.notebook, "Home", "encrypted"]], "the notebook is there");
      const pages = await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading pages");
      assertEqual(pages.map((p) => [p[0], p[1]]).sort(), [["Home", `${SECRETS.home} ${SECRETS.text}, edited`], [`Home:${SECRETS.other}`, "second page"]].sort(), "the pages are as they were left");
      const attached = await mustWork(await page.evaluate((id) => window.lab.notebooks.files(id), made.id), "reading files");
      assertEqual(attached, [[SECRETS.path, SECRETS.type, SECRETS.bytes.length, 2, SECRETS.bytes]], "the attachment is as it was, bytes and all");
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  // The engine is ended without a word (as closing the tab does) at a different moment of a write of 1,200 pages each
  // time: at the very start, in the middle of the work, late. Whenever it falls, the change is whole or not there at all.
  for (const after of [5, 60, 250, 800, 2500]) {
    await scenario(`a change cut off in the middle (the tab closes ${after} ms into writing 1,200 pages) leaves the notebook whole, or as it was`, async () => {
      const context = await fresh();
      try {
        const page = await openLab(context);
        await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
        const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Crash test", [["Home", "before"]], [])), "making a notebook");
        const ended = await mustWork(await page.evaluate(([id, after]) => window.lab.notebooks.writeAndCrash(id, 1200, after), [made.id, after]), "writing and ending the engine");
        const finished = ended === "finished";
        assert(finished || /^stopped: /.test(ended), `the write neither finished nor stopped: ${ended}`);
        // (so that this does not pass by the engine being ended after the work was done: writing 1,200 pages takes seconds)
        if (after <= 800) assert(!finished, `the engine was ended ${after} ms in, and the write had finished: ${ended}`);
        if (!finished) assertEqual(await lab(page, "unlocked"), false, "the vault noticed that its engine was gone, and is locked");

        // a new page, as after the tab was closed and opened again
        await page.reload();
        await page.waitForFunction(() => window.lab !== undefined);
        await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking after the crash");
        const pages = await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading pages");
        if (finished) assertEqual(pages.length, 1201, "the write finished, and every page of it is there");
        else assertEqual(pages.map((p) => [p[0], p[1]]), [["Home", "before"]], "not one of the 1,200 pages is there, and the one that was is as it was");
        // and it is not damaged: a write, left alone, goes through, and the notebook can be listed and read as a whole
        await mustWork(await page.evaluate((id) => window.lab.notebooks.replace(id, [], Array.from({ length: 50 }, (_, i) => [`After ${i}`, "x"])), made.id), "writing after the crash");
        assertEqual((await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading")).length, pages.length + 50, "the pages written afterwards are there");
        assertEqual((await mustWork(await page.evaluate(() => window.lab.notebooks.list()), "listing")).length, 1, "and the notebook is listed once");
        await mustWork(await lab(page, "lock"), "locking");
      } finally {
        await context.close();
      }
    });
  }

  await scenario("the engine's Worker says that it is alive every few seconds while nothing else is going on", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      assertEqual(await lab(page, "listen"), true, "listening to the engine");
      await page.waitForTimeout(11_500);
      const heard = await lab(page, "heard");
      assert(heard >= 2, `the engine said it was alive ${heard} times in 11 seconds (it should every 5)`);
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  await scenario("an engine that is ended without a word is found out by its silence: what waits for it is refused, and the vault says it was lost", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context, origin, [], "?silence=3000");
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      assertEqual(await lab(page, "whoAmI").then((o) => o.ok), true, "the engine answers");
      await lab(page, "killSilently");
      const started = Date.now();
      // (a request that is never refused is a failure to report, not something to wait for for ever)
      const asked = await Promise.race([lab(page, "whoAmI"), new Promise((_, reject) => setTimeout(() => reject(new Error("a request to a dead engine was never refused")), 20_000))]);
      const waited = Date.now() - started;
      assertEqual(asked.ok, false, "a request to a dead engine is refused");
      assert(/stopped unexpectedly/.test(asked.message), `and says why: ${asked.message}`);
      assert(waited >= 2500 && waited < 15_000, `after about the time it was allowed to be silent (${waited} ms)`);
      assertEqual(await lab(page, "unlocked"), false, "the vault is locked");
      const events = await lab(page, "happened");
      assert(events.some((e) => e.startsWith("lost: it said nothing")), `and was told that it was lost: ${JSON.stringify(events)}`);
      // and it can be unlocked again at once: nothing of the dead engine is in the way
      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking again");
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  await scenario("a Worker that has been cut off from the network can't use it, and can't get it back", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      const probe = await mustWork(await lab(page, "probeCutOff", `${origin}/`), "running the probe");
      // (the control: before the cut-off the Worker could reach this very page, so a refusal after it means something)
      assertEqual(probe.before, "status 200", "before the cut-off the Worker can fetch a file");
      for (const [way, outcome] of Object.entries(probe.after)) assert(outcome.includes("can't use the network"), `${way}: ${outcome}`);
      assertEqual(Object.keys(probe.after).sort(), ["EventSource", "SharedWorker", "WebSocket", "WebTransport", "Worker", "XMLHttpRequest", "fetch", "fetchCalled", "importScripts"], "every way of reaching out was tried");
      assertEqual(probe.restored, [], "and the code in the Worker could not bring one back");
      assertEqual(probe.stillRefused, true, "fetch is refused after all that");
    } finally {
      await context.close();
    }
  });

  await scenario("the engine asks the network for nothing: its files are loaded, and then no request leaves for anywhere else", async () => {
    const context = await fresh();
    const seen = [];
    context.on("request", (request) => seen.push({ url: request.url(), method: request.method(), body: request.postData() }));
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      assert(seen.some((r) => /\.wasm(\?|$)/.test(r.url)), `the log sees the requests of the engine's Worker (it loaded its wasm): ${JSON.stringify(seen.map((r) => r.url))}`);
      const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Quiet", [["Home", "x"]], [["a.bin", "bytes", "application/x-test"]])), "making a notebook");
      await mustWork(await page.evaluate((id) => window.lab.notebooks.replace(id, [], [["More", "text"]]), made.id), "writing");
      await mustWork(await lab(page, "lock"), "locking");
      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking");
      await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading");
      await mustWork(await lab(page, "lock"), "locking again");
      for (const request of seen) {
        assert(request.url.startsWith(`${origin}/`), `a request left the page's own address: ${request.url}`);
        assertEqual([request.method, request.body], ["GET", null], `${request.url} was asked for with more than a plain GET`);
        assert(/\.(js|wasm|html|css)(\?.*)?$|\/$/.test(request.url), `${request.url} is not one of the files of the app`);
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
