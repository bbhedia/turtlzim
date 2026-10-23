// The app in a real iPhone WebView, tried from the inside. There is no way to drive a WKWebView from outside in CI (Playwright can't take one), and no keyboard to press, so a
// build made for the test (`ZIM_E2E=1 npm run prepare:web`, which puts this script after the app's, and `window.__ZIM_TEST__` before it) does what a person would do, with the
// page's own DOM, and writes down what happened in a file of the app's Documents folder, which CI reads from the simulator's disk (`.github/workflows/desktop.yml`, job `ios`).
//
// It is run twice, and the second time is what a restart of the app does to what was written: run 1 writes a line in the home page, makes an encrypted notebook (the vault:
// a Worker, WebAssembly, the browser's file system, scrypt at 128 MiB), writes in it, locks, unlocks; run 2 (the app was closed and opened again) finds the line, and unlocks.
// Which run it is, it finds out from what is there (the line of run 1), so that a restart that lost everything shows as a second run 1.
//
// In a browser (`npm run test:e2e-local`) it runs the same way and leaves its result in `window.__e2e`.
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

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

async function step(name: string, work: () => Promise<void>): Promise<void> {
  const at = performance.now();
  try {
    await work();
    steps.push({ name, ok: true, ms: Math.round(performance.now() - at) });
  } catch (failure) {
    steps.push({ name, ok: false, ms: Math.round(performance.now() - at), error: failure instanceof Error ? failure.message : String(failure) });
    await report(false);
    throw failure;
  }
  await report(false);
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
  } else {
    await step("what was typed before the app was closed is there", async () => {
      await until("the line", () => pageText().includes(LINE));
    });
    await step("the encrypted notebook is there after a restart, and opens with the passphrase", async () => {
      await unlock();
      await until("the secret", () => pageText().includes(SECRET));
    });
    await step("and locks", lock);
  }
  await report(true);
}

window.addEventListener("load", () => {
  // (the app starts after the page has loaded: this waits for it)
  void main().catch(async (failure: unknown) => {
    await report(true, failure instanceof Error ? failure.message : String(failure));
  });
});
