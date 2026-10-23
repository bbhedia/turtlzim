// The app in a real iPhone WebView, tried from the inside. There is no way to drive a WKWebView from outside in CI (Playwright can't take one), and no keyboard to press, so a
// build made for the test (`ZIM_E2E=1 npm run prepare:web`, which puts this script after the app's, and `window.__ZIM_TEST__` before it) does what a person would do, with the
// page's own DOM, and writes down what happened in a file of the app's Documents folder, which CI reads from the simulator's disk (`.github/workflows/desktop.yml`, job `ios`).
//
// It is run twice, and the second time is what a restart of the app does to what was written: run 1 writes a line in the home page, makes an encrypted notebook (the vault:
// a Worker, WebAssembly, the browser's file system, scrypt at 128 MiB), writes in it, locks, unlocks; run 2 (the app was closed and opened again) finds the line, and unlocks.
// Which run it is, it finds out from what is there (the line of run 1), so that a restart that lost everything shows as a second run 1.
//
// Where CI has started a real account server (`scripts/ios-server.mjs`, told in `Documents/e2e/server.json`), it also tries what the app's own code (ZimNativePlugin) does for an account
// against it, from the page's side, through the hooks that the shell gives the page: requests over plain http to the device's own address and over https to a server whose certificate no
// system knows, trusting that certificate by its fingerprint, a certificate that is made again (refused before a byte is sent), a token kept in the keychain over a restart. A third
// run, asked for by CI with a file (`return-test.json`), only listens for the app's own return address, to see how the system hands it over.
//
// In a browser (`npm run test:e2e-local`) it runs the same way (with stand-in hooks and a stand-in for `server.json`) and leaves its result in `window.__e2e`.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { AccountHooks } from "../../web/src/app/shell";

const PASSPHRASE = "a long passphrase for the test of the app";
const LINE = "e2e line one";
const SECRET = "vault line one";

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** The parts of the app that the test reaches for (what `window.__zim` is, with the test flag). */
interface Zim {
  app: {
    session: { text(name: string): string | undefined; info: { kind: string }; title: string } | null;
    flush(): Promise<void>;
  };
  editor: { getText(): string; view: { state: { doc: { length: number } }; dispatch(spec: unknown): void } };
}
declare global {
  interface Window {
    __zim?: Zim;
    __e2e?: unknown;
    __e2eErrors?: string[];
    __zimShell?: { account?: AccountHooks };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const steps: Step[] = [];
let phase = 0;
let run = 1;
const started = performance.now();

/** What the WebView can do, which is what decides whether the app can work in it: for whoever reads a result that is not all ok. */
function environment(): Record<string, unknown> {
  const w = window as unknown as Record<string, unknown>;
  const storage = navigator.storage as unknown as { getDirectory?: unknown } | undefined;
  return {
    userAgent: navigator.userAgent,
    origin: location.origin,
    secureContext: window.isSecureContext,
    crossOriginIsolated: w.crossOriginIsolated,
    worker: typeof Worker,
    webAssembly: typeof WebAssembly,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    opfs: typeof storage?.getDirectory,
    indexedDB: typeof indexedDB,
    cryptoSubtle: typeof crypto?.subtle,
    capacitor: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "none",
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

/** Write down what is known so far (after each step: an app that stops in the middle leaves what it did), and leave it where a browser test finds it. */
async function report(final: boolean, error?: string): Promise<void> {
  const result = { run, phase, final, ok: final && steps.length > 0 && steps.every((s) => s.ok) && !error, error, steps, seconds: Math.round((performance.now() - started) / 100) / 10, errors: (window.__e2eErrors ?? []).slice(0, 12), environment: environment() };
  window.__e2e = result;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Filesystem.writeFile({ path: `e2e/run-${run}.json`, data: JSON.stringify(result), directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
  } catch (failure) {
    console.error(`the result could not be written: ${String(failure)}`);
  }
}

/** A step: what failed is written down, and the test stops there, unless the step is `soft` (the ones after it do not need it: what else is wrong is told in the same run). */
async function step(name: string, work: () => Promise<void>, soft = false): Promise<void> {
  const at = performance.now();
  try {
    await work();
    steps.push({ name, ok: true, ms: Math.round(performance.now() - at) });
  } catch (failure) {
    steps.push({ name, ok: false, ms: Math.round(performance.now() - at), error: failure instanceof Error ? failure.message : String(failure) });
    await report(false);
    if (!soft) throw failure;
    return;
  }
  await report(false);
}

/** Write a file of the app's Documents folder (where CI reads it from the simulator's disk); nothing in a browser. */
async function write(path: string, text: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.writeFile({ path, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
}

async function exists(path: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await Filesystem.stat({ path, directory: Directory.Documents });
    return true;
  } catch {
    return false;
  }
}

/** Wait for something to be true (a person does: the app is never ready at the instant that it is asked). */
async function until<T>(what: string, check: () => T | Promise<T>, timeout = 60_000): Promise<NonNullable<T>> {
  const end = performance.now() + timeout;
  let last: unknown;
  while (performance.now() < end) {
    try {
      const found = await check();
      if (found) return found as NonNullable<T>;
    } catch (failure) {
      last = failure;
    }
    await sleep(100);
  }
  throw new Error(`never: ${what}${last ? ` (${String(last)})` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// what a person does, with the page's own DOM

const zim = (): Zim => {
  if (!window.__zim) throw new Error("the app was not given to the test (window.__zim)");
  return window.__zim;
};
const dialogs = () => [...document.querySelectorAll<HTMLDialogElement>("dialog.dialog")];
const buttonIn = (root: Element, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

function controlOf(root: Element, label: string, exact = true): HTMLInputElement | HTMLSelectElement {
  const found = [...root.querySelectorAll("label")].find((l) => (exact ? l.textContent?.trim() === label : (l.textContent ?? "").includes(label)));
  const control = found && (document.getElementById(found.getAttribute("for") ?? "") ?? found.querySelector("input,select"));
  if (!control) throw new Error(`no field called ${label}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

function fill(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  control.focus();
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

async function chooseFromMenu(item: string): Promise<void> {
  const opener = await until("the notebook button", () => document.querySelector<HTMLButtonElement>(".notebook-button"));
  opener.click();
  const entry = await until(`the menu line ${item}`, () => [...document.querySelectorAll<HTMLButtonElement>(".notebook-menu button[role=menuitem]")].find((b) => b.textContent?.trim() === item));
  entry.click();
}

/** The dialog with this heading, once it is there. */
async function dialogTitled(title: string): Promise<HTMLDialogElement> {
  return until(`the dialog ${title}`, () => dialogs().find((d) => d.querySelector("#dialog-title, h1, h2, h3")?.textContent?.trim() === title));
}

async function noDialogs(): Promise<void> {
  // (the notice about keeping a copy of the encrypted notebooks may come first: it is dismissed)
  await until("no dialog left", () => {
    for (const d of dialogs()) {
      const title = d.querySelector("#dialog-title, h1, h2, h3")?.textContent?.trim() ?? "";
      if (title.startsWith("Keep a copy of encrypted notebooks")) buttonIn(d, "OK")?.click();
    }
    return dialogs().length === 0;
  });
}

async function typeAtEnd(text: string): Promise<void> {
  const { editor, app } = zim();
  const end = editor.view.state.doc.length;
  editor.view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length } });
  await app.flush();
}

const pageText = (): string => zim().editor.getText();
const kind = (): string | undefined => zim().app.session?.info.kind;

async function newEncryptedNotebook(title: string): Promise<void> {
  await chooseFromMenu("New notebook…");
  const dialog = await dialogTitled("New notebook");
  fill(controlOf(dialog, "Name"), title);
  fill(controlOf(dialog, "Encryption"), "encrypted");
  buttonIn(dialog, "Create")?.click();
  // the first one makes the vault, which asks for a passphrase
  const making = await dialogTitled("Encrypted notebooks");
  fill(controlOf(making, "Passphrase"), PASSPHRASE);
  fill(controlOf(making, "Passphrase again"), PASSPHRASE);
  const understood = controlOf(making, "I understand", false) as HTMLInputElement;
  if (!understood.checked) understood.click();
  buttonIn(making, "Create encrypted notebooks")?.click();
  await until("an encrypted notebook open", () => kind() === "encrypted", 180_000);
  await noDialogs();
}

async function lock(): Promise<void> {
  const button = await until("the lock button", () => {
    const found = document.querySelector<HTMLButtonElement>(".lock-button");
    return found && !found.hidden ? found : null;
  });
  button.click();
  await until("the notebooks locked", () => kind() !== "encrypted" && document.querySelector<HTMLButtonElement>(".lock-button")?.hidden === true);
}

async function unlock(): Promise<void> {
  await chooseFromMenu("Unlock encrypted notebooks…");
  const dialog = await dialogTitled("Unlock encrypted notebooks");
  fill(controlOf(dialog, "Passphrase", false), PASSPHRASE);
  buttonIn(dialog, "Unlock")?.click();
  await until("the encrypted notebook open again", () => kind() === "encrypted", 180_000);
  await noDialogs();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// what the app's own code (ZimNativePlugin) does for an account, asked through the hooks that the shell gives the page, as the page asks; where the app has none (a browser) this is left out

/** What a hook said when it refused: the words (and, for a certificate, the code). */
async function refusal(work: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await work;
  } catch (failure) {
    const error = failure as { message?: string; code?: string };
    return { message: String(error.message ?? failure), ...(error.code ? { code: error.code } : {}) };
  }
  throw new Error("it was not refused");
}

function expectIncludes(what: string, text: string, part: string): void {
  if (!text.includes(part)) throw new Error(`${what}: ${JSON.stringify(text)} does not say ${JSON.stringify(part)}`);
}

async function accountSteps(account: AccountHooks): Promise<void> {
  if (phase === 1) {
    await step("the keychain keeps a secret, gives it back, and forgets it", async () => {
      await account.secrets.set("e2e-secret", "value one");
      if ((await account.secrets.get("e2e-secret")) !== "value one") throw new Error("the secret was not given back");
      await account.secrets.set("e2e-secret", "value two");
      if ((await account.secrets.get("e2e-secret")) !== "value two") throw new Error("the secret was not replaced");
      await account.secrets.remove("e2e-secret");
      if ((await account.secrets.get("e2e-secret")) !== null) throw new Error("the secret was not forgotten");
      expectIncludes("a name that is a path", (await refusal(account.secrets.set("a/b", "x"))).message, "not a name");
      await account.secrets.set("e2e-kept", "kept over a restart");
    }, true);
    await step("a request is made only to an account server: the rules refuse the rest, in words", async () => {
      const get = (url: string) => account.request({ url, method: "GET", headers: {} });
      expectIncludes("plain http to another server", (await refusal(get("http://example.org/api/me"))).message, "has to be reached over https");
      expectIncludes("another path", (await refusal(get("https://example.org/other"))).message, "not a request to the account server");
      expectIncludes("a dot segment", (await refusal(get("https://example.org/api/%2e%2e/x"))).message, "not a request to the account server");
      expectIncludes("a name and password", (await refusal(get("https://ada:secret@example.org/api/me"))).message, "no name or password");
      expectIncludes("another kind of address", (await refusal(get("file:///etc/passwd"))).message, "not an address");
    }, true);
    await step("the hooks for a certificate refuse what they should, and say so when nothing answers", async () => {
      const trust = account.trust;
      if (!trust) throw new Error("the shell gave no hooks for a certificate");
      expectIncludes("an address that is not https", (await refusal(trust.inspect("http://127.0.0.1:1"))).message, "only for an https address");
      expectIncludes("a page of a server", (await refusal(trust.inspect("https://127.0.0.1:1/api/me"))).message, "not for a page");
      expectIncludes("what is not a fingerprint", (await refusal(trust.pin("https://127.0.0.1:1", "zz"))).message, "not a fingerprint");
      if ((await trust.pinned("https://127.0.0.1:1")) !== null) throw new Error("something was trusted that never was");
      await trust.unpin("https://127.0.0.1:1");
      expectIncludes("a server that is not there", (await refusal(trust.inspect("https://127.0.0.1:1"))).message, "did not answer");
    }, true);
  } else {
    await step("the secret kept before the app was closed is there, in the keychain", async () => {
      if ((await account.secrets.get("e2e-kept")) !== "kept over a restart") throw new Error("the secret did not survive the restart");
      await account.secrets.remove("e2e-kept");
    }, true);
  }
  const server = await serverConfig();
  if (server) await serverSteps(account, server);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the same, against a real account server (scripts/ios-server.mjs: the server's own code, a certificate that no system knows, and a few doors that only the test has)

/** What the test server said of itself when it was ready: where it is, and the fingerprint of the certificate that it shows. */
interface ServerConfig {
  https: string;
  http: string;
  fingerprint: string;
  email: string;
  password: string;
}

/** What the test server was asked: never a token, only whether there was one. */
interface Seen {
  n: number;
  secure: boolean;
  method: string;
  url: string;
  userAgent: string | null;
  requestedWith: string | null;
  origin: string | null;
  authorization: boolean;
  cookie: boolean;
}

const RETURN_URI = "org.zimnotebook.app.ios:/callback";
/** The name of the token in the keychain: the test's own, not the page's (the page's is for what the person is signed in as). */
const TOKEN = "e2e-token";

async function serverConfig(): Promise<ServerConfig | null> {
  // (a test in a browser is handed it by the page that runs it)
  const given = (window as unknown as { __e2eServer?: ServerConfig }).__e2eServer;
  if (given) return given;
  if (!(await exists("e2e/server.json"))) return null;
  const read = await Filesystem.readFile({ path: "e2e/server.json", directory: Directory.Documents, encoding: Encoding.UTF8 });
  return JSON.parse(String(read.data)) as ServerConfig;
}

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function serverSteps(account: AccountHooks, server: ServerConfig): Promise<void> {
  const trust = account.trust;
  if (!trust) throw new Error("the shell gave no hooks for a certificate");
  /** A door of the test server, on its plain http side (an app may ask a server on its own device without a certificate): what it said, as data. */
  const door = async <T>(method: string, name: string, body?: unknown): Promise<T> => {
    const answer = await account.request({ url: `${server.http}/api/__e2e/${name}`, method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (answer.status !== 200) throw new Error(`the test server's door ${name} said ${answer.status}: ${answer.body.slice(0, 200)}`);
    return JSON.parse(answer.body) as T;
  };
  const serverState = () => door<{ seen: Seen[]; fingerprint: string }>("GET", "state");
  /** How many requests the server has had over https (a handshake is not one: a server that was only looked at, or that an app turned away, has had none). */
  const asked = async () => (await serverState()).seen.filter((entry) => entry.secure).length;
  const ask = (path: string, headers: Record<string, string> = {}) => account.request({ url: `${server.https}${path}`, method: "GET", headers: { accept: "application/json", ...headers } });
  const emailOf = (body: string) => (JSON.parse(body) as { user?: { email?: string } | null }).user?.email;

  if (phase === 1) {
    await step(
      "a request to a server on this device's own address goes over plain http, as an app makes it: with what an app sends, and nothing of the page's",
      async () => {
        const answer = await account.request({ url: `${server.http}/api/providers`, method: "GET", headers: { accept: "application/json", "x-requested-with": "zim", cookie: "session=taken", origin: "https://other.example" } });
        if (answer.status !== 200) throw new Error(`the answer was ${answer.status}`);
        if (!Array.isArray((JSON.parse(answer.body) as { providers?: unknown }).providers)) throw new Error(`the body was not the server's: ${answer.body.slice(0, 120)}`);
        const mine = (await serverState()).seen.filter((entry) => !entry.secure && entry.url === "/api/providers").pop();
        if (!mine) throw new Error("the server was not asked");
        if (mine.userAgent !== "ZimNotebook-iOS") throw new Error(`it was asked by ${mine.userAgent}`);
        if (mine.cookie || mine.origin !== null) throw new Error(`a header of the page's went with it (cookie ${mine.cookie}, origin ${mine.origin})`);
        if (mine.requestedWith !== "zim") throw new Error("the header that the server asks of a change did not go");
      },
      true,
    );
    await step(
      "a certificate that no system knows is refused, with its code, and nothing is sent to the server",
      async () => {
        const refused = await refusal(ask("/api/providers"));
        if (refused.code !== "certificate-untrusted") throw new Error(`the code was ${refused.code}: ${refused.message}`);
        expectIncludes("the words", refused.message, "not one that this device trusts");
        if ((await asked()) !== 0) throw new Error("the server was asked, with nothing trusted for it");
      },
      true,
    );
    await step(
      "what the server shows is looked at in a handshake, nothing is sent to it, and it is the server's own certificate",
      async () => {
        const shown = await trust.inspect(server.https);
        if (shown.fingerprint !== server.fingerprint) throw new Error(`the app saw ${shown.fingerprint}, the server's is ${server.fingerprint}`);
        if ((await asked()) !== 0) throw new Error("looking at the certificate sent the server something");
      },
      true,
    );
    await step(
      "trusting another certificate than the one that is shown keeps nothing, and trusting the one that is shown is kept",
      async () => {
        const other = server.fingerprint.replace(/^../, (pair) => (pair === "00" ? "11" : "00"));
        const refused = await refusal(trust.pin(server.https, other));
        if (refused.code !== "certificate-changed") throw new Error(`the code was ${refused.code}: ${refused.message}`);
        if ((await trust.pinned(server.https)) !== null) throw new Error("something was trusted that was refused");
        await trust.pin(server.https, server.fingerprint);
        if ((await trust.pinned(server.https)) !== server.fingerprint) throw new Error("what was trusted was not what was kept");
      },
      true,
    );
    await step(
      "with the certificate trusted, the server is asked and answers",
      async () => {
        const answer = await ask("/api/providers");
        if (answer.status !== 200) throw new Error(`the answer was ${answer.status}`);
        if ((await asked()) !== 1) throw new Error("the server was not asked once");
        const mine = (await serverState()).seen.filter((entry) => entry.secure).pop();
        if (!mine || mine.userAgent !== "ZimNotebook-iOS" || mine.cookie) throw new Error("it was not asked as an app asks");
      },
      true,
    );
    let token = "";
    await step(
      "an app is signed in as a person's browser would sign it in: the code is traded for a token, the keychain keeps it, it works, and it cannot make another",
      async () => {
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
        const allowed = await door<{ status: number; body: { label?: string; redirect?: string } }>("POST", "browser-allows", { redirect_uri: RETURN_URI, code_challenge: challenge, code_challenge_method: "S256", state });
        if (allowed.status !== 200 || !allowed.body.redirect) throw new Error(`the browser's part said ${allowed.status}: ${JSON.stringify(allowed.body)}`);
        if (allowed.body.label !== "Zim Notebook for iPhone") throw new Error(`the server named the app ${allowed.body.label}`);
        const back = new URL(allowed.body.redirect);
        if (back.searchParams.get("state") !== state) throw new Error("the state did not come back");
        const traded = await account.request({
          url: `${server.https}/api/app/token`,
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "zim", accept: "application/json" },
          body: JSON.stringify({ code: back.searchParams.get("code"), code_verifier: verifier, redirect_uri: RETURN_URI }),
        });
        if (traded.status !== 200) throw new Error(`trading the code said ${traded.status}: ${traded.body.slice(0, 160)}`);
        token = (JSON.parse(traded.body) as { token: string }).token;
        await account.secrets.set(TOKEN, token);
        if ((await account.secrets.get(TOKEN)) !== token) throw new Error("the keychain did not give the token back");
        const me = await ask("/api/me", { authorization: `Bearer ${token}` });
        if (emailOf(me.body) !== server.email) throw new Error(`the token was not the account's: ${me.status} ${me.body.slice(0, 120)}`);
        const again = await account.request({ url: `${server.https}/api/app/authorize`, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-requested-with": "zim" }, body: "{}" });
        if (again.status !== 403) throw new Error(`an app's token made another: ${again.status}`);
      },
      true,
    );
    let rotated = "";
    await step(
      "when the server's certificate is made again, the app refuses it before anything is sent (the token with it), and says it changed",
      async () => {
        const before = await asked();
        rotated = (await door<{ fingerprint: string }>("POST", "rotate-certificate")).fingerprint;
        if (rotated === server.fingerprint) throw new Error("the certificate was not made again");
        const refused = await refusal(ask("/api/me", { authorization: `Bearer ${token}` }));
        if (refused.code !== "certificate-changed") throw new Error(`the code was ${refused.code}: ${refused.message}`);
        expectIncludes("the words", refused.message, "not the one that you trusted");
        if ((await asked()) !== before) throw new Error("the server was sent a request by an app that had not checked its certificate");
      },
      true,
    );
    await step(
      "the new certificate is looked at and trusted again, and the same token is good with it",
      async () => {
        const shown = await trust.inspect(server.https);
        if (shown.fingerprint !== rotated) throw new Error(`the app saw ${shown.fingerprint}, the server's is ${rotated}`);
        await trust.pin(server.https, shown.fingerprint);
        const me = await ask("/api/me", { authorization: `Bearer ${token}` });
        if (emailOf(me.body) !== server.email) throw new Error(`the answer was ${me.status}: ${me.body.slice(0, 120)}`);
      },
      true,
    );
    await step(
      "what was trusted can be forgotten, and then the system's own refusal is back; trusted again, it is kept for the next start",
      async () => {
        await trust.unpin(server.https);
        if ((await trust.pinned(server.https)) !== null) throw new Error("what was trusted was not forgotten");
        const refused = await refusal(ask("/api/providers"));
        if (refused.code !== "certificate-untrusted") throw new Error(`the code was ${refused.code}: ${refused.message}`);
        await trust.pin(server.https, rotated);
      },
      true,
    );
  } else {
    await step(
      "the certificate that was trusted before the app was closed is still trusted, and the token that the keychain kept still works",
      async () => {
        const current = (await serverState()).fingerprint;
        if ((await trust.pinned(server.https)) !== current) throw new Error("what was trusted did not survive the restart");
        const kept = await account.secrets.get(TOKEN);
        if (!kept) throw new Error("the token did not survive the restart");
        const me = await ask("/api/me", { authorization: `Bearer ${kept}` });
        if (emailOf(me.body) !== server.email) throw new Error(`the token was not good: ${me.status} ${me.body.slice(0, 120)}`);
      },
      true,
    );
    await step(
      "signing out ends the token at the server, and the keychain forgets it",
      async () => {
        const kept = await account.secrets.get(TOKEN);
        if (!kept) throw new Error("there was no token");
        const out = await account.request({ url: `${server.https}/api/logout`, method: "POST", headers: { authorization: `Bearer ${kept}`, "content-type": "application/json", "x-requested-with": "zim" }, body: "{}" });
        if (out.status !== 200) throw new Error(`signing out said ${out.status}`);
        const me = await ask("/api/me", { authorization: `Bearer ${kept}` });
        if (emailOf(me.body) !== undefined) throw new Error("the token still worked after signing out");
        await account.secrets.remove(TOKEN);
        await trust.unpin(server.https);
      },
      true,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// how the system hands the app an address of its own scheme (the browser's return after a sign-in): tried in a run of its own, which CI asks for with a file and answers with `xcrun simctl openurl`

async function returnSteps(): Promise<void> {
  const seen: { via: string; url: string }[] = [];
  let via = "the system";
  void App.addListener("appUrlOpen", (event) => {
    seen.push({ via, url: event.url });
    void write("e2e/url-seen.json", JSON.stringify(seen));
  });
  await write("e2e/url-ready.json", "{}");
  await step(
    "an address of the app's own scheme that the system opens (xcrun simctl openurl) is handed to the app",
    async () => {
      await until("an address from the system", () => seen.length >= 1, 40_000);
      const [first] = seen;
      if (first?.url !== `${RETURN_URI}?code=from-the-system&state=ci`) throw new Error(`the app was handed ${first?.url}`);
    },
    true,
  );
  await step(
    "a page that goes to the app's own address (as a browser's return does) has it handed to the app too",
    async () => {
      via = "the page";
      window.location.href = `${RETURN_URI}?code=from-the-page&state=page`;
      await until("an address from the page", () => seen.some((one) => one.via === "the page"), 20_000);
    },
    true,
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    try {
      const there = await Filesystem.readdir({ path: "e2e", directory: Directory.Documents });
      run = there.files.filter((f) => /^run-\d+\.json$/.test(f.name)).length + 1;
    } catch {
      // (nothing written yet: the first run)
    }
  }
  await step("the app starts, with its editor", async () => {
    await until("the app", () => window.__zim?.app.session && document.querySelector(".cm-content"), 120_000);
    await until("the sample page in the editor", () => pageText().length > 20);
  });
  if (await exists("e2e/return-test.json")) {
    phase = 3;
    await report(false);
    await returnSteps();
    await report(true);
    return;
  }
  phase = pageText().includes(LINE) ? 2 : 1;
  await report(false);
  if (phase === 1) {
    await step("typing goes into the page and is saved", async () => {
      await typeAtEnd(`\n${LINE}\n`);
      await until("the page saved with the line", () => zim().app.session?.text("Home")?.includes(LINE));
    });
    await step("an encrypted notebook is made (a Worker, WebAssembly, the file system, scrypt)", async () => {
      await newEncryptedNotebook("E2E vault");
      await typeAtEnd(`\n${SECRET}\n`);
      await until("the secret saved in the encrypted notebook", () => pageText().includes(SECRET));
    });
    await step("the encrypted notebooks lock, and unlock with the passphrase", async () => {
      await lock();
      await unlock();
      await until("the secret back", () => pageText().includes(SECRET));
    });
    await step("and lock again, as an app that goes away does", lock);
    if (window.__zimShell?.account) await accountSteps(window.__zimShell.account);
  } else {
    await step("what was typed before the app was closed is there", async () => {
      await until("the line", () => pageText().includes(LINE));
    });
    await step("the encrypted notebook is there after a restart, and opens with the passphrase", async () => {
      await unlock();
      await until("the secret", () => pageText().includes(SECRET));
    });
    await step("and locks", lock);
    if (window.__zimShell?.account) await accountSteps(window.__zimShell.account);
  }
  await report(true);
}

window.addEventListener("load", () => {
  // (the app starts after the page has loaded: this waits for it)
  void main().catch(async (failure: unknown) => {
    await report(true, failure instanceof Error ? failure.message : String(failure));
  });
});
