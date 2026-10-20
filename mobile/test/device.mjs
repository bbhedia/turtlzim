// The app in a real Android WebView, on the emulator (scripts/emulator.sh start) or a phone with USB debugging: `npm run test:device`.
// It installs the APK of `npm run apk`, starts the app, and drives it through the WebView's DevTools socket (Playwright's connectOverCDP does
// not take a WebView, so test/cdp.mjs speaks the protocol) and `adb` (taps, keys, what is on top). VAULT=1 adds the encrypted notebook
// (minutes on an emulator: scrypt at 128 MiB on emulated cores).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "android/sdk");
const adbPath = join(sdk, "platform-tools/adb");
const PKG = "org.zimnotebook.app";
const adb = (...args) => execFileSync(adbPath, args, { encoding: "utf8", timeout: 120_000 }).replace(/\r/g, "").trim();
/** Like `adb`, with "" for a command that fails (`pidof` does, while the app is not running yet). */
const adbTry = (...args) => {
  try {
    return adb(...args);
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ONLY=account runs the account's checks alone; with nothing set, everything runs (ACCOUNT=0 leaves the account's out). */
const only = process.env.ONLY ?? "";
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const topWindow = () => adb("shell", "dumpsys window | grep mCurrentFocus");
/** SCREENSHOTS=dir: a picture of the device's screen at the moment, to look at (`device-NAME.png`). */
const shot = (name) => {
  if (!process.env.SCREENSHOTS) return;
  mkdirSync(process.env.SCREENSHOTS, { recursive: true });
  writeFileSync(join(process.env.SCREENSHOTS, `device-${name}.png`), execFileSync(adbPath, ["exec-out", "screencap", "-p"], { maxBuffer: 50_000_000 }));
};

if (!adb("devices").includes("\tdevice")) {
  console.error("no emulator or phone: scripts/emulator.sh start");
  process.exit(2);
}
adb("shell", "settings put secure show_ime_with_hard_keyboard 1");
adb("install", "-r", join(root, "out/zim-notebook-debug.apk"));
adb("shell", "pm clear " + PKG);

/** Start the app from the launcher and connect to its page. */
async function launch() {
  adb("shell", `am force-stop ${PKG}`);
  await sleep(500);
  adbTry("shell", `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
  let pid = "";
  for (let i = 0; i < 40 && !pid; i++) {
    await sleep(1000);
    pid = adbTry("shell", `pidof ${PKG}`);
    if (pid && !adb("shell", "cat /proc/net/unix").includes(`webview_devtools_remote_${pid}`)) pid = "";
  }
  adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`);
  const page = await connect();
  for (let i = 0; i < 40 && !(await page.evaluate("!!document.querySelector('.cm-content') && !!document.querySelector('.notebook-title')?.innerText")); i++) await sleep(500);
  return page;
}
const menu = (page, label) => page.evaluate(`(async () => { document.querySelector('[aria-haspopup]').click(); await new Promise((r) => setTimeout(r, 1200)); [...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click(); })()`);

/**
 * What the app does for an account, on the device. The servers are on this machine (the account server with its own database, a second one over https with an authority
 * of its own that the device does not know, a third that answers with a redirect) and the device reaches them by `adb reverse`, so that `127.0.0.1` is the same place on both.
 * The person's browser is the **real Chrome of the emulator**, driven through its DevTools socket (a userdebug image: `adb root` and Chrome's flags file); the app opens it
 * itself (the system's ACTION_VIEW), and Android takes Chrome's last step, the app's own address, back to the app.
 */
async function accountChecks() {
  const { Accounts } = await import("../../server/src/accounts.mjs");
  const { createApi } = await import("../../server/src/api.mjs");
  const { openDatabase } = await import("../../server/src/db.mjs");
  const { OutboxMailer } = await import("../../server/src/mail.mjs");
  const { OAuth } = await import("../../server/src/oauth.mjs");
  const { createStaticServer, selfSignedCertificate } = await import("../../web/scripts/serve.mjs");
  const { randomBytes } = await import("node:crypto");
  // (a userdebug emulator can be rooted, which Chrome's flags file and the app's private storage need; rooting restarts adbd, which drops what was reversed: so it is first)
  adbTry("root");
  adbTry("wait-for-device");
  await sleep(2000);
  const rooted = adbTry("shell", "id").includes("uid=0");
  const dist = resolve(root, "../web/dist");
  const config = { baseUrl: "http://127.0.0.1", secure: false, trustProxy: false, sessionDays: 30, quotaBytes: 1024 * 1024, secret: randomBytes(32), providers: {} };
  const db = openDatabase(":memory:");
  const mailer = new OutboxMailer();
  const accounts = new Accounts({ db, mailer, config });
  const api = createApi({ accounts, oauth: new OAuth({ db, accounts, config }), config });
  /** What the server was asked, and the pages that a redirect would lead to. */
  const seen = [];
  const landed = [];
  const logged = (req, res) => {
    if ((req.url ?? "").startsWith("/api/")) seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (req.url === "/api/redirect") {
      res.writeHead(302, { location: "/api/landing" });
      res.end();
      return true;
    }
    if (req.url === "/api/landing") {
      landed.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return true;
    }
    return api(req, res);
  };
  const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
  const site = createStaticServer({ dir: dist, api: logged });
  const port = await listen(site);
  config.baseUrl = `http://127.0.0.1:${port}`;
  const tls = selfSignedCertificate(mkdtempSync(join(tmpdir(), "zim-device-tls-")), []);
  const secure = createStaticServer({ dir: dist, tls: { key: tls.key, cert: tls.cert }, api });
  const securePort = await listen(secure);
  for (const p of [port, securePort]) adb("reverse", `tcp:${p}`, `tcp:${p}`);
  const base = `http://127.0.0.1:${port}`;
  await accounts.register("ada@example.org", "correct horse battery");
  accounts.verify("ada@example.org", /\b(\d{6})\b/.exec(mailer.sent.at(-1).text)[1]);

  let page = await launch();
  try {
    const hook = (expression) => page.evaluate(`(async () => { try { return { ok: await (${expression}) }; } catch (error) { return { failed: String(error?.message ?? error) }; } })()`);
    const account = "window.__zimShell.account";

    // the keychain: a value is sealed by a key of the device's keystore and kept in the app's private storage, and is there after the app is stopped and started
    let said = await hook(`${account}.secrets.set("device-check", "s3cret-value-1234")`);
    check(said.ok === null || said.ok === undefined, `a secret can be kept (${JSON.stringify(said)})`);
    check((await hook(`${account}.secrets.get("device-check")`)).ok === "s3cret-value-1234", "and read back");
    const stored = adbTry("shell", `run-as ${PKG} cat shared_prefs/zim_secrets.xml`);
    check(stored.includes("secret-device-check") && !stored.includes("s3cret-value-1234"), "kept sealed: the app's storage holds the name and not the value");
    page.close();
    page = await launch();
    check((await hook(`${account}.secrets.get("device-check")`)).ok === "s3cret-value-1234", "and it is still there after the app is stopped and started (the keystore's key is)");
    await hook(`${account}.secrets.remove("device-check")`);
    check((await hook(`${account}.secrets.get("device-check")`)).ok === null && !adbTry("shell", `run-as ${PKG} cat shared_prefs/zim_secrets.xml`).includes("secret-device-check"), "and forgotten when it is removed, from the storage too");
    check((await hook(`${account}.secrets.get("../escape")`)).failed?.includes("not a name"), "a name that is a path is refused");

    // the requests: made by the app, not by the page; only what an account server's address allows; no cookie, no origin, no redirect
    const asked = await hook(`${account}.request({ url: "${base}/api/providers", method: "GET", headers: { cookie: "zim=stolen", origin: "https://evil.example", referer: "https://evil.example/", "x-requested-with": "zim", accept: "application/json" } })`);
    check(asked.ok?.status === 200 && JSON.parse(asked.ok.body).email === true, `a request is made, to a server on this machine, over a reversed port (${JSON.stringify(asked).slice(0, 120)})`);
    const got = seen.find((r) => r.url === "/api/providers");
    check(got && !got.headers.cookie && !got.headers.origin && !got.headers.referer && got.headers["x-requested-with"] === "zim" && /ZimNotebook-Android/.test(got.headers["user-agent"] ?? ""), `with the headers of an app only (${JSON.stringify(got?.headers ?? null).slice(0, 200)})`);
    const redirected = await hook(`${account}.request({ url: "${base}/api/redirect", method: "GET", headers: { authorization: "Bearer t0ken" } })`);
    check(redirected.ok?.status === 302 && landed.length === 0, "a redirect is the answer, not a journey: the token goes to no other address");
    for (const [what, url, words] of [
      ["a server that is not on this device, over plain http", "http://example.org/api/me", "https"],
      ["an address that is not the account server's", `${base}/other`, "account server"],
      ["an address that climbs out of /api/ by a dot segment written with %2e (the client's parser would resolve it)", `${base}/api/%2e%2e/other`, "account server"],
      ["an address with a name and a password in it", `http://ada:secret@127.0.0.1:${port}/api/me`, "name or password"],
      ["an address that is not a server's", "file:///etc/passwd", "address"],
    ]) {
      const refused = await hook(`${account}.request({ url: ${JSON.stringify(url)}, method: "GET", headers: {} })`);
      check(refused.failed?.includes(words), `refuses ${what} (${refused.failed ?? JSON.stringify(refused.ok).slice(0, 60)})`);
    }
    const untrusted = await hook(`${account}.request({ url: "https://127.0.0.1:${securePort}/api/health", method: "GET", headers: {} })`);
    check(untrusted.failed?.includes("certificate is not one that this device trusts"), `refuses a server whose certificate the device does not trust, and says so (${untrusted.failed ?? JSON.stringify(untrusted.ok).slice(0, 60)})`);

    // the person's browser is only opened at an address that a person would go to: not a file of the app's own, not a script, not a web page over plain http
    for (const url of [`file:///data/data/${PKG}/shared_prefs/zim_secrets.xml`, "javascript:alert(1)", "http://example.org/", "intent://scan/#Intent;scheme=zxing;end"]) {
      await hook(`${account}.signIn.begin("${"a".repeat(22)}")`);
      const opening = await hook(`${account}.signIn.wait(${JSON.stringify(url)})`);
      check(opening.failed?.includes("only sent to an https address"), `refuses to open the browser at ${url.slice(0, 40)} (${opening.failed ?? "it did not"})`);
    }

    // the app opens the person's browser, and what comes back is checked: an address that is not the answer to this sign-in does not end the wait
    // (the real Chrome: its first-run questions are answered in advance, and its DevTools socket is where it is driven)
    if (!rooted) {
      console.log("skip  the rest of the account checks need a userdebug emulator (adb root) to drive Chrome");
    } else {
      adb("shell", "echo '_ --no-first-run --disable-fre --no-default-browser-check --disable-notifications' > /data/local/tmp/chrome-command-line; chmod 755 /data/local/tmp/chrome-command-line");
      adb("shell", "am force-stop com.android.chrome");
      adbTry("shell", "pm clear com.android.chrome");
      adbTry("shell", "pm grant com.android.chrome android.permission.POST_NOTIFICATIONS");
      page.close();
      page = await launch();
      const set = (target, selector, value) => target.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const click = (target, label) => target.evaluate(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no button ${label}'); b.click(); })()`);
      const status = () => page.evaluate("document.querySelector('#status')?.innerText ?? ''");
      const until = async (what, test, tries = 60, wait = 1000) => {
        for (let i = 0; i < tries; i++) {
          if (await test()) return true;
          await sleep(wait);
        }
        throw new Error(`never: ${what}`);
      };

      // (what the checks above asked by hand, a made-up token among it, is not what is looked at below)
      const asksBefore = seen.length;
      await menu(page, "Connect to an account server");
      await sleep(1000);
      await set(page, "#field-server", base);
      await sleep(500);
      shot("connect");
      await click(page, "Continue in the browser");
      // Chrome comes up at the server's page (the app asked the system for a browser), and the app waits
      await until("Chrome was opened at the server", async () => adbTry("shell", "dumpsys window | grep mCurrentFocus").includes("com.android.chrome"), 30);
      await until("Chrome's DevTools socket", async () => adbTry("shell", "cat /proc/net/unix").includes("chrome_devtools_remote"), 30);
      adb("forward", "tcp:9333", "localabstract:chrome_devtools_remote");
      let chrome;
      await until("Chrome's page", async () => {
        try {
          chrome = await connect(9333, (t) => t.type === "page" && t.url.startsWith(`${base}/`));
          return true;
        } catch {
          return false;
        }
      }, 30);
      check(true, "the app opened the device's own browser at the server's page");
      // the person signs in there, as they always do, and is asked whether to allow the app
      await until("the sign-in dialog in Chrome", () => chrome.evaluate("!!document.querySelector('dialog[open] #field-email')"), 40);
      await set(chrome, "#field-email", "ada@example.org");
      await set(chrome, "#field-password", "correct horse battery");
      await click(chrome, "Sign in");
      await until("the question in Chrome", () => chrome.evaluate("[...document.querySelectorAll('dialog[open] h2')].some((h) => h.textContent === 'Allow this app?')"), 40);
      await sleep(3000);
      shot("chrome-allow");
      const asked = await chrome.evaluate("document.querySelector('dialog[open]').innerText");
      check(/Android phone or tablet/.test(asked) && /ada@example.org/.test(asked), `Chrome asks whether to allow the Android app, for this account`);
      // another app sends this app an address like the one it waits for, with another state: it is not the answer, and the app goes on waiting (then back to Chrome, where the person is)
      adb("shell", `am start -a android.intent.action.VIEW -d "org.zimnotebook.app:/callback?code=evil&state=wrong" -c android.intent.category.BROWSABLE`);
      await sleep(2500);
      check(topWindow().includes(PKG) && (await page.evaluate("!!document.querySelector('dialog[open] .wait-address')")) && !(await status()).includes("Connected"), "an address like the app's own, with another state, while the app waits, is not taken for the answer: the app goes on waiting");
      adbTry("shell", "monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1");
      await until("Chrome is in front again", async () => adbTry("shell", "dumpsys window | grep mCurrentFocus").includes("com.android.chrome"), 20);
      await sleep(1500);
      // a real tap on Allow (a script's click is not a gesture; a page may only go to an app's address after one)
      const where = JSON.parse(await chrome.evaluate(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Allow'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
      await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: where.x, y: where.y, button: "left", clickCount: 1 });
      await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: where.x, y: where.y, button: "left", clickCount: 1 });
      chrome.close();
      // Chrome goes to org.zimnotebook.app:/callback?…, Android hands it to the app, and the app finishes
      await until("the app says it is connected", async () => (await status()).includes(`Connected to ${base} as ada@example.org`), 60);
      check(topWindow().includes(PKG), "Android took Chrome's last step, the app's own address, back to the app, which is in front again");
      shot("connected");
      const apps = db.prepare("select label, kind from sessions where kind = 'app'").all();
      check(JSON.stringify(apps) === JSON.stringify([{ label: "Zim Notebook for Android", kind: "app" }]), `the server has one app session, named for Android (${JSON.stringify(apps)})`);
      const token = (await hook(`${account}.secrets.get("account-token")`)).ok;
      check(typeof token === "string" && token.length >= 40 && !adbTry("shell", `run-as ${PKG} cat shared_prefs/zim_secrets.xml`).includes(token), "the token is in the app's keychain, sealed, and not in the clear in its storage");
      const outside = await page.evaluate("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie })");
      check(!outside.includes(token), "and not in what the page's scripts can read");
      check((await page.evaluate("performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/')).length")) === 0, "the page itself asked the server for nothing: every request was the app's");

      // a notebook is kept on the server with it, and the app is still connected after it is stopped and started
      await menu(page, "Keep this notebook on the server");
      await sleep(1500);
      await click(page, "Keep it there");
      await until("the notebook was kept", async () => (await status()).includes("is kept on the server"), 60);
      check(db.prepare("select count(*) as n from notebooks").get().n === 1, "a notebook is kept on the server with that token");
      const carried = seen.slice(asksBefore).filter((r) => r.headers.authorization);
      check(carried.length > 0 && carried.every((r) => r.headers.authorization === `Bearer ${token}`), `and every request that carried a token carried that one (${carried.length} of them)`);
      page.close();
      page = await launch();
      // (the app asks the server who it is at the start; the menu has the answer a moment later)
      await sleep(3000);
      await menu(page, "Account (ada@example.org)");
      await sleep(1500);
      check((await page.evaluate("document.querySelector('dialog[open]')?.innerText ?? ''")).includes("ada@example.org"), "the app is still connected after it was stopped and started (the token and the address were kept)");
      shot("account");
      await click(page, "Sign out of this app");
      await until("the app says it is signed out", async () => (await status()).includes("Signed out"), 30);
      check(db.prepare("select count(*) as n from sessions where kind = 'app'").get().n === 0 && (await hook(`${account}.secrets.get("account-token")`)).ok === null, "signed out: the server ended the token and the app forgot it");
      await sleep(500);
    }

    // the app's own address, handed to the app when nothing is waiting for it: nothing happens (no crash, no sign-in)
    const pidBefore = adbTry("shell", `pidof ${PKG}`);
    adb("shell", `am start -a android.intent.action.VIEW -d "org.zimnotebook.app:/callback?code=stray&state=stray" -c android.intent.category.BROWSABLE`);
    await sleep(3000);
    check(topWindow().includes(PKG) && adbTry("shell", `pidof ${PKG}`) === pidBefore && (await page.evaluate("!!document.querySelector('.cm-content')")), "an address like the app's own, with nothing waiting for it, is taken by the app and does nothing");
  } finally {
    page.close();
    for (const p of [port, securePort]) adbTry("reverse", "--remove", `tcp:${p}`);
    adbTry("forward", "--remove", "tcp:9333");
    site.closeAllConnections?.();
    secure.closeAllConnections?.();
    site.close();
    secure.close();
    db.close();
  }
}

try {
  let page = await launch();

  // what the app is
  const facts = JSON.parse(await page.evaluate(`JSON.stringify({ platform: window.Capacitor?.getPlatform?.(), secure: isSecureContext, opfs: !!navigator.storage?.getDirectory, hooks: Object.keys(window.__zimShell ?? {}), origin: location.origin, workers: 0 })`));
  facts.workers = await page.evaluate("navigator.serviceWorker.getRegistrations().then((r) => r.length)");
  check(facts.platform === "android" && facts.secure && facts.opfs && facts.origin === "https://localhost", `starts from its own files as an Android app, in a secure context (${JSON.stringify(facts)})`);
  check(facts.hooks.includes("saveFile") && facts.hooks.includes("version") && facts.hooks.includes("account") && facts.workers === 0, "has the shell's hooks (the account's too) and registers no worker");
  check((await page.evaluate("document.querySelector('.notebook-title')?.innerText")) === "Sample notebook", "shows the sample notebook");
  // the one permission that the app asks for is the network, for the requests to an account server that the person typed the address of (ZimNativePlugin); the other is the
  // app's own (AndroidX adds it to every app that has a receiver): nothing about storage, location, contacts, the camera, the microphone
  const aapt2 = join(sdk, "build-tools", readdirSync(join(sdk, "build-tools")).sort().at(-1), "aapt2");
  const requested = execFileSync(aapt2, ["dump", "permissions", join(root, "out/zim-notebook-debug.apk")], { encoding: "utf8" })
    .split("\n")
    .map((line) => /uses-permission: name='([^']+)'/.exec(line)?.[1])
    .filter(Boolean)
    .sort();
  check(JSON.stringify(requested) === JSON.stringify(["android.permission.INTERNET", `${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`]), `asks for the network permission and for nothing else (${requested.join(", ")})`);

  if (!only) {
  // the keyboard: the system's own, the app takes what is left and the formatting bar is right above it
  const before = JSON.parse(await page.evaluate("JSON.stringify([innerHeight, !!document.querySelector('.app.keyboard')])"));
  const state = async () => JSON.parse(await page.evaluate("JSON.stringify({ height: innerHeight, keyboard: !!document.querySelector('.app.keyboard'), editing: !!document.querySelector('.app.editing'), bar: document.querySelector('.format-bar')?.getBoundingClientRect().bottom, focus: document.activeElement?.classList.contains('cm-content') })"));
  // (a tap puts the caret in the text, and the system brings the keyboard up a moment later; the first tap of a fresh install may only wake the window)
  let during = await state();
  for (let tap = 0; tap < 3 && !during.keyboard; tap++) {
    adb("shell", "input tap 450 1000");
    for (let i = 0; i < 8 && !(during = await state()).keyboard; i++) await sleep(1000);
  }
  check(!before[1] && during.keyboard && during.editing && during.focus && during.height < before[0] - 150, `the keyboard comes up, the app shrinks (${before[0]} to ${during.height}) and is in the writing state`);
  check(during.bar > during.height - 16 && during.bar <= during.height + 1, `the formatting bar's bottom (${Math.round(during.bar)}) is within a few pixels of the bottom of what is left (${during.height})`);

  // text typed is kept across a stop
  await page.send("Input.insertText", { text: "KEPT-ON-DEVICE " });
  await sleep(3500);
  check((await page.evaluate("document.querySelector('.save-state')?.innerText")) === "Saved", "what was typed is saved");
  page.close();
  page = await launch();
  check(await page.evaluate("document.querySelector('.cm-content').innerText.includes('KEPT-ON-DEVICE')"), "and is there after the app is stopped and started");

  // the back gesture: a page back, then out
  await page.evaluate("location.hash = '#/Help%3AEditor'");
  await sleep(1500);
  adb("shell", "input keyevent KEYCODE_BACK");
  await sleep(1500);
  check((await page.evaluate("location.hash")) === "#/Home" && topWindow().includes(PKG), "back goes back a page and stays in the app");
  adb("shell", "input keyevent KEYCODE_BACK");
  await sleep(1500);
  check(!topWindow().includes(PKG), "and leaves the app at the first page");

  // a file is handed to the system's share sheet
  page.close();
  page = await launch();
  await menu(page, "Export notebook");
  for (let i = 0; i < 15 && !/ChooserActivity/.test(topWindow()); i++) await sleep(1000);
  check(/ChooserActivity/.test(topWindow()), "Export opens the system's share sheet");
  check(adb("shell", `run-as ${PKG} find cache/handed-over -type f`).endsWith("Sample_notebook.zip"), "with the zip in the app's cache");
  adb("shell", "input keyevent KEYCODE_BACK");
  await sleep(1000);
  page.close();
  }

  // an account, through the person's own browser (the real Chrome of the device)
  if (process.env.ACCOUNT !== "0" && (!only || only === "account")) {
    page.close();
    await accountChecks();
  }

  // the vault: a Worker, OPFS, WebAssembly and libsodium in the WebView
  if (process.env.VAULT && !only) {
    page = await launch();
    const set = (selector, value) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await menu(page, "New notebook");
    await sleep(1000);
    await set("#field-title", "Secret");
    await set("#choice-kind", "encrypted");
    await page.evaluate("[...document.querySelectorAll('dialog[open] button')].find((b) => /^create$/i.test(b.textContent.trim())).click()");
    await sleep(2500);
    await set("#field-passphrase", "correct horse battery staple");
    await set("#field-again", "correct horse battery staple");
    await page.evaluate("document.querySelector('#check-understood').click()");
    await page.evaluate("[...[...document.querySelectorAll('dialog[open]')].pop().querySelectorAll('button')].find((b) => !/cancel/i.test(b.textContent)).click()");
    const started = Date.now();
    for (let i = 0; i < 150 && (await page.evaluate("document.querySelectorAll('dialog[open]').length")) > 0; i++) await sleep(2000);
    check((await page.evaluate("document.querySelector('.notebook-title')?.innerText")) === "Secret", `an encrypted notebook can be made (${Math.round((Date.now() - started) / 1000)} s)`);
    page.close();
  }
} catch (error) {
  console.log(`FAIL ${error.stack ?? error}`);
  failures.push(String(error));
}
console.log(failures.length ? `\n${failures.length} failed` : "\nthe app works on the device");
process.exit(failures.length ? 1 : 0);
