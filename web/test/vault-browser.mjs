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
const NEXT = "a different passphrase, quite long";
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

  const SECRETS_FOR_BACKUP = {
    notebook: "Zebra Journal", home: "Secret Plans Page", text: "the vault door code is 7391", other: "Hidden Sub Page Name",
    path: "diagram-4417.png", bytes: "ATTACHMENT-BYTES-5529", type: "image/x-secret",
  };
  const madeNotebook = (page) =>
    page.evaluate((s) => window.lab.notebooks.create(s.notebook, [["Home", `${s.home} ${s.text}`], [`Home:${s.other}`, "second page"]], [[s.path, s.bytes, s.type]]), SECRETS_FOR_BACKUP);
  /** Everything of a notebook as the lab reads it, for comparing what was backed up with what was restored. */
  const readNotebook = async (page, id) => ({
    list: (await mustWork(await page.evaluate(() => window.lab.notebooks.list()), "listing")).map((n) => [n.id, n.title, n.home, n.kind]),
    pages: (await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), id), "reading pages")).map((p) => [p[0], p[1]]).sort(),
    files: await mustWork(await page.evaluate((id) => window.lab.notebooks.files(id), id), "reading files"),
  });
  const backupBytes = (base64) => Buffer.from(base64, "base64");

  await scenario("a backup of the vault is one file that holds nothing that can be read, and restores in another browser, which then opens it with the same passphrase", async () => {
    const here = await fresh();
    const elsewhere = await fresh();
    const another = await fresh();
    try {
      const page = await openLab(here);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const made = await mustWork(await madeNotebook(page), "making a notebook");
      const before = await readNotebook(page, made.id);
      const started = Date.now();
      const backup = await mustWork(await lab(page, "exportBackup"), "making a backup");
      console.log(`  (a backup of a small vault took ${Date.now() - started} ms and is ${backupBytes(backup).length} bytes)`);
      const bytes = backupBytes(backup);
      assertEqual(bytes.subarray(0, 8).toString("latin1"), "ZIMVAULT", "it is a backup, by its first bytes");
      assert(contains(bytes, made.id), "the notebook's id is in it (which shows that the right file was read)");
      for (const secret of [...Object.values(SECRETS_FOR_BACKUP), "second page", PASSPHRASE]) assert(!contains(bytes, secret), `${JSON.stringify(secret)} can be read in the backup`);
      // making one changes nothing: the vault is as it was, and still unlocked
      assertEqual(await lab(page, "unlocked"), true, "still unlocked");
      assertEqual(await readNotebook(page, made.id), before, "and what is in it is as it was");

      // another browser, which has no vault: the backup is restored, locked, and opens with the passphrase it had
      const other = await openLab(elsewhere);
      assertEqual(await mustWork(await lab(other, "exists"), "looking"), false, "nothing is there yet");
      const restored = await mustWork(await lab(other, "restoreBackup", backup), "restoring");
      assertEqual(restored, { spaces: 1, notes: 4, files: 1 }, "the notebook, its two pages, the file's own note, and the notebook's own settings");
      assertEqual(await lab(other, "unlocked"), false, "restored, and locked");
      assertEqual(await mustWork(await lab(other, "exists"), "looking"), true, "the vault is there");
      const wrong = await lab(other, "unlock", "pale river stone lantern!");
      assertEqual([wrong.ok, wrong.error], [false, "WrongPassphraseError"], "a wrong passphrase is refused");
      await mustWork(await lab(other, "unlock", PASSPHRASE), "unlocking the restored vault");
      assertEqual(await readNotebook(other, made.id), before, "everything is there, as it was: the notebook, the pages, and the attachment's bytes");
      await mustWork(await lab(other, "lock"), "locking");
      // and what it keeps there has nothing that can be read either
      for (const [path, fileBytes] of await mustWork(await lab(other, "opfsFiles"), "reading what the browser keeps")) {
        for (const secret of [...Object.values(SECRETS_FOR_BACKUP), "second page", PASSPHRASE]) assert(!contains(fileBytes, secret), `${JSON.stringify(secret)} is in ${path}`);
      }
      // it is restored where there is no vault, and nowhere else
      const again = await lab(other, "restoreBackup", backup);
      assertEqual([again.ok, again.error], [false, "VaultExistsError"], "not over a vault that is there");
      await mustWork(await lab(other, "unlock", PASSPHRASE), "the vault that was there is as it was");
      const vaultHere = await lab(other, "restoreBackup", backup);
      assertEqual([vaultHere.ok, vaultHere.error], [false, "VaultExistsError"], "nor over one that is unlocked");
      await mustWork(await lab(other, "lock"), "locking");
      // the first browser still has what it had
      assertEqual(await readNotebook(page, made.id), before, "the browser it was made in was not changed by the backup or the restore");
      await mustWork(await lab(page, "lock"), "locking");

      // a third browser, and files that are not what they should be: each is refused, whole, and no vault is left behind
      const third = await openLab(another);
      const damaged = Buffer.from(bytes);
      damaged[Math.floor(damaged.length / 2)] ^= 0x01;
      for (const [what, file, why] of [
        ["a backup with one byte changed", damaged, /the backup can't be restored/],
        ["a backup cut short", bytes.subarray(0, bytes.length - 1), /the backup can't be restored/],
        ["a file that is not a backup", Buffer.from("%PDF-1.4 and the rest of a document"), /not a backup of encrypted notebooks/],
      ]) {
        const refused = await lab(third, "restoreBackup", file.toString("base64"));
        assert(!refused.ok && why.test(refused.message), `${what} was not refused as it should be: ${JSON.stringify(refused)}`);
        assertEqual(await mustWork(await lab(third, "exists"), "looking"), false, `${what}: no vault was left behind`);
      }
      // and the backup, after all that: it restores
      assertEqual((await mustWork(await lab(third, "restoreBackup", backup), "restoring after the refusals")).notes, 4, "restored after all that");
      await mustWork(await lab(third, "unlock", PASSPHRASE), "unlocking");
      assertEqual(await readNotebook(third, made.id), before, "and it is whole");
      await mustWork(await lab(third, "lock"), "locking");
    } finally {
      await here.close();
      await elsewhere.close();
      await another.close();
    }
  });

  await scenario("a backup is the vault as it was when it was made: one made after the passphrase was changed opens with the new one, one made before with the old", async () => {
    const here = await fresh();
    const first = await fresh();
    const second = await fresh();
    try {
      const page = await openLab(here);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Journal", [["Home", "before"]], [])), "making a notebook");
      const old = await mustWork(await lab(page, "exportBackup"), "a backup before the change");
      await mustWork(await lab(page, "changePassphrase", PASSPHRASE, NEXT), "changing the passphrase");
      const fresher = await mustWork(await lab(page, "exportBackup"), "a backup after the change");
      await mustWork(await lab(page, "lock"), "locking");

      const a = await openLab(first);
      await mustWork(await lab(a, "restoreBackup", fresher), "restoring the newer backup");
      const refused = await lab(a, "unlock", PASSPHRASE);
      assertEqual([refused.ok, refused.error], [false, "WrongPassphraseError"], "the passphrase from before the change does not open a backup made after it");
      await mustWork(await lab(a, "unlock", NEXT), "the new passphrase opens it");
      assertEqual((await readNotebook(a, made.id)).pages, [["Home", "before"]], "with its pages");
      await mustWork(await lab(a, "lock"), "locking");

      const b = await openLab(second);
      await mustWork(await lab(b, "restoreBackup", old), "restoring the older backup");
      const refusedNew = await lab(b, "unlock", NEXT);
      assertEqual([refusedNew.ok, refusedNew.error], [false, "WrongPassphraseError"], "the new passphrase does not open a backup made before the change");
      await mustWork(await lab(b, "unlock", PASSPHRASE), "the old passphrase does");
      assertEqual((await readNotebook(b, made.id)).pages, [["Home", "before"]], "with its pages");
      await mustWork(await lab(b, "lock"), "locking");
    } finally {
      await here.close();
      await first.close();
      await second.close();
    }
  });

  // The engine is ended without a word at a different moment of restoring a backup of 800 pages: whenever it falls, there is
  // a whole vault or none, and a restore that is tried again goes through.
  for (const after of [20, 120, 400, 1200]) {
    await scenario(`a restore cut off in the middle (the tab closes ${after} ms in) leaves a vault that is whole, or none, and can be tried again`, async () => {
      const here = await fresh();
      const elsewhere = await fresh();
      try {
        const page = await openLab(here);
        await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
        const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Big", [["Home", "before"]], [])), "making a notebook");
        await mustWork(await page.evaluate((id) => window.lab.notebooks.replace(id, [], Array.from({ length: 800 }, (_, i) => [`Page ${i}`, `text of page ${i}`])), made.id), "writing 800 pages");
        const backup = await mustWork(await lab(page, "exportBackup"), "making the backup");
        await mustWork(await lab(page, "lock"), "locking");

        const other = await openLab(elsewhere);
        const ended = await mustWork(await lab(other, "restoreBackupAndCrash", backup, after), "restoring and ending the engine");
        assert(ended === "finished" || /^stopped: /.test(ended), `the restore neither finished nor stopped: ${ended}`);
        await other.reload();
        await other.waitForFunction(() => window.lab !== undefined);
        const exists = await mustWork(await lab(other, "exists"), "looking");
        if (exists) {
          // finished, as far as anything can tell: then it is the whole vault
          await mustWork(await lab(other, "unlock", PASSPHRASE), "unlocking what was restored");
          assertEqual((await readNotebook(other, made.id)).pages.length, 801, "a vault that is there is whole");
          await mustWork(await lab(other, "lock"), "locking");
        } else {
          assert(ended !== "finished", "a restore that finished left no vault");
          // nothing is there, and the same backup restores now
          const second = await mustWork(await lab(other, "restoreBackup", backup), "restoring again");
          assertEqual(second.notes, 802, "and then it is whole (800 pages, Home, and the notebook's own settings)");
          await mustWork(await lab(other, "unlock", PASSPHRASE), "unlocking");
          assertEqual((await readNotebook(other, made.id)).pages.length, 801, "every page is there");
          await mustWork(await lab(other, "lock"), "locking");
        }
        console.log(`  (${after} ms: ${ended === "finished" ? "it finished" : exists ? "cut off, and a whole vault was there" : "cut off, and no vault was there"})`);
      } finally {
        await here.close();
        await elsewhere.close();
      }
    });
  }

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

  await scenario("the passphrase can be changed: the old one stops opening the vault, the new one opens it with everything in it, and nothing sealed with the old key is left in what the browser keeps", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const name = await mustWork(await lab(page, "whoAmI"), "asking");
      const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Journal", [["Home", "before the change"]], [["a.bin", "bytes of a file", "application/x-test"]])), "making a notebook");
      await mustWork(await lab(page, "lock"), "locking");

      // before: what the browser keeps is sealed with the key the old passphrase makes (so that a nothing, afterwards, means something)
      const before = await mustWork(await lab(page, "sealedWith", name, PASSPHRASE), "looking at what is sealed with the old key");
      assert(before.opened >= 3, `the notebook's key, the user's record and the account's auth are sealed with the key the passphrase makes: ${JSON.stringify(before)}`);
      assertEqual((await mustWork(await lab(page, "sealedWith", name, NEXT), "looking at what is sealed with the new key")).opened, 0, "nothing is sealed with the new passphrase's key yet");

      await mustWork(await lab(page, "unlock", PASSPHRASE), "unlocking");
      const wrong = await lab(page, "changePassphrase", "not the passphrase", NEXT);
      assertEqual([wrong.ok, wrong.error], [false, "WrongPassphraseError"], "a wrong current passphrase is refused");
      const weak = await lab(page, "changePassphrase", PASSPHRASE, "short");
      assert(!weak.ok && /at least 10/.test(weak.message), `a weak new passphrase is refused: ${JSON.stringify(weak)}`);
      assertEqual(await lab(page, "unlocked"), true, "and the vault is as it was");
      const started = Date.now();
      const done = await mustWork(await lab(page, "changePassphrase", PASSPHRASE, NEXT), "changing the passphrase");
      console.log(`  (changing the passphrase took ${Date.now() - started} ms)`);
      assertEqual(done.unreadable, 0, "every key could be opened");
      assert(done.sealed >= 1, `and at least the notebook's was sealed again: ${JSON.stringify(done)}`);
      assertEqual(await lab(page, "unlocked"), true, "the vault stays unlocked");
      assertEqual((await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading")).map((p) => [p[0], p[1]]), [["Home", "before the change"]], "what was there is there");
      // and it goes on working, with the new key: a page written now is kept
      await mustWork(await page.evaluate((id) => window.lab.notebooks.replace(id, [], [["Later", "written after the change"]]), made.id), "writing after the change");
      await mustWork(await lab(page, "lock"), "locking");

      // what the browser keeps now: sealed with the key of the new passphrase, and not one thing, not even a copy a database may have left in a page it freed, with the old
      const afterNew = await mustWork(await lab(page, "sealedWith", name, NEXT), "looking at what is sealed with the new key");
      const afterOld = await mustWork(await lab(page, "sealedWith", name, PASSPHRASE), "looking at what is sealed with the old key");
      assertEqual(afterOld.opened, 0, `something is still sealed with the old passphrase's key: ${JSON.stringify(afterOld.where)}`);
      assertEqual(afterNew.opened, before.opened, "everything that was sealed with the old key is sealed with the new one");
      const files = await mustWork(await lab(page, "opfsFiles"), "reading what the browser keeps");
      for (const [path, bytes] of files) {
        assert(!contains(bytes, PASSPHRASE), `the old passphrase is in ${path}`);
        assert(!contains(bytes, NEXT), `the new passphrase is in ${path}`);
      }

      // after a reload: the old passphrase is refused, the new one opens everything
      await page.reload();
      await page.waitForFunction(() => window.lab !== undefined);
      const refused = await lab(page, "unlock", PASSPHRASE);
      assertEqual([refused.ok, refused.error], [false, "WrongPassphraseError"], "the old passphrase no longer opens the vault");
      await mustWork(await lab(page, "unlock", NEXT), "unlocking with the new passphrase");
      assertEqual(await lab(page, "settled"), [], "there was nothing half done to settle");
      assertEqual((await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading")).map((p) => [p[0], p[1]]).sort(), [["Home", "before the change"], ["Later", "written after the change"]], "the pages are there, the one written after the change too");
      assertEqual((await mustWork(await page.evaluate((id) => window.lab.notebooks.files(id), made.id), "reading files")).map((f) => f[4]), ["bytes of a file"], "and the file");
      await mustWork(await lab(page, "lock"), "locking");
    } finally {
      await context.close();
    }
  });

  await scenario("a change of passphrase that is cut off at any moment leaves a vault that one of the two passphrases opens, whole, and the one typed is the one it has", async () => {
    const context = await fresh();
    try {
      const page = await openLab(context);
      const reloaded = async () => {
        await page.reload();
        await page.waitForFunction(() => window.lab !== undefined);
      };
      await mustWork(await lab(page, "create", PASSPHRASE), "making the vault");
      const made = await mustWork(await page.evaluate(() => window.lab.notebooks.create("Crash test", [["Home", "before"]], [])), "making a notebook");
      // how long a change takes here (it is made of two key derivations, and a few writes at the very end): the crashes are placed around the end
      let current = PASSPHRASE;
      let next = "calibration passphrase of the vault";
      const started = Date.now();
      await mustWork(await lab(page, "changePassphrase", current, next), "a change that is not cut off");
      const duration = Date.now() - started;
      current = next;
      console.log(`  (a change takes ${duration} ms here)`);

      const offsets = [-duration + 300, -600, -300, -200, -150, -120, -100, -85, -70, -60, -50, -40, -30, -22, -15, -8, 0, 20, 60, 150];
      const histogram = {};
      for (const [i, offset] of offsets.entries()) {
        next = `trial ${i} passphrase of the vault`;
        const after = Math.max(60, duration + offset);
        const ended = await mustWork(await lab(page, "changePassphraseAndCrash", current, next, after), "changing and ending the engine");
        assert(ended === "finished" || /^stopped: /.test(ended), `the change neither finished nor stopped: ${ended}`);
        if (ended !== "finished") assertEqual(await lab(page, "unlocked"), false, "the vault noticed that its engine was gone, and is locked");
        await reloaded();
        // (even trials type the new passphrase first, odd ones the old: either may be what is asked for after a crash)
        const order = i % 2 === 0 ? [next, current] : [current, next];
        let typed = null;
        for (const passphrase of order) {
          const attempt = await lab(page, "unlock", passphrase);
          if (attempt.ok) {
            typed = passphrase;
            break;
          }
          assertEqual(attempt.error, "WrongPassphraseError", `trial ${i} (${after} ms): a passphrase that did not open it was refused for another reason: ${attempt.message}`);
        }
        assert(typed !== null, `trial ${i} (${after} ms, ${ended}): neither the old nor the new passphrase opens the vault`);
        const settled = await lab(page, "settled");
        const how = `${ended === "finished" ? "finished" : "cut off"}, ${typed === next ? "new" : "old"} typed first-or-second, ${settled.length ? (settled[0] ? "an unfinished change was finished" : "an unfinished change was undone") : "nothing to settle"}`;
        histogram[how] = (histogram[how] ?? 0) + 1;
        // whole: the page that was there, and nothing half written
        assertEqual((await mustWork(await page.evaluate((id) => window.lab.notebooks.pages(id), made.id), "reading pages")).map((p) => [p[0], p[1]]), [["Home", "before"]], `trial ${i}: the notebook is whole`);
        // the passphrase typed is the vault's; the other no longer opens it
        await mustWork(await lab(page, "lock"), "locking");
        const other = typed === next ? current : next;
        const refused = await lab(page, "unlock", other);
        assertEqual([refused.ok, refused.error], [false, "WrongPassphraseError"], `trial ${i}: the passphrase that was not typed still opens the vault`);
        await mustWork(await lab(page, "unlock", typed), `trial ${i}: unlocking again with the passphrase that opened it`);
        assertEqual(await lab(page, "settled"), [], "and there is nothing left to settle");
        await mustWork(await lab(page, "lock"), "locking");
        current = typed;
      }
      console.log(`  (where the ${offsets.length} cut-offs fell: ${JSON.stringify(histogram)})`);
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
