// The app in a real Android WebView, on the emulator (scripts/emulator.sh start) or a phone with USB debugging: `npm run test:device`.
// It installs the APK of `npm run apk`, starts the app, and drives it through the WebView's DevTools socket (Playwright's connectOverCDP does
// not take a WebView, so test/cdp.mjs speaks the protocol) and `adb` (taps, keys, what is on top). VAULT=1 adds the encrypted notebook
// (minutes on an emulator: scrypt at 128 MiB on emulated cores).
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const topWindow = () => adb("shell", "dumpsys window | grep mCurrentFocus");

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

try {
  let page = await launch();

  // what the app is
  const facts = JSON.parse(await page.evaluate(`JSON.stringify({ platform: window.Capacitor?.getPlatform?.(), secure: isSecureContext, opfs: !!navigator.storage?.getDirectory, hooks: Object.keys(window.__zimShell ?? {}), origin: location.origin, workers: 0 })`));
  facts.workers = await page.evaluate("navigator.serviceWorker.getRegistrations().then((r) => r.length)");
  check(facts.platform === "android" && facts.secure && facts.opfs && facts.origin === "https://localhost", `starts from its own files as an Android app, in a secure context (${JSON.stringify(facts)})`);
  check(facts.hooks.includes("saveFile") && facts.hooks.includes("version") && facts.workers === 0, "has the shell's hooks and registers no worker");
  check((await page.evaluate("document.querySelector('.notebook-title')?.innerText")) === "Sample notebook", "shows the sample notebook");
  const permissions = adbTry("shell", `dumpsys package ${PKG} | grep -E "android.permission" | grep -v "granted=false"`);
  check(!/INTERNET/.test(permissions), "has no network permission");

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

  // the vault: a Worker, OPFS, WebAssembly and libsodium in the WebView
  if (process.env.VAULT) {
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
