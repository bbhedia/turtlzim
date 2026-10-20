// The shell's script. It runs in the WebView before the web app starts, and gives the app the things that a WebView does not do by
// itself (web/src/app/shell.ts says which hooks there are and what a shell without one is). The web app depends on none of this.
import { App } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { AccountHooks, NetRequest, NetResponse, ShellHooks, SignInHooks, SignInResult } from "../../web/src/app/shell";
import { answerOf, REDIRECT_URI } from "./callback";

/** The version of this app and of the web build inside it, put in by scripts/prepare.mjs. */
declare const __SHELL_VERSION__: string;

/** Where files are put to be handed over, in the app's own cache folder: no other app can read it. */
const OUT = "handed-over";

/** The bytes of a Blob as base64, which is what the Filesystem plugin takes. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** A file name that every file system takes. */
function safeName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
}

/**
 * Put the file in the app's cache folder and open the system's share sheet on it: from there the person saves it ("Files", "Drive")
 * or sends it. (A link to a Blob that has `download`, which is how a browser saves a file, does nothing in a WebView.) Each file has a
 * folder of its own, so that the name that the sheet shows is the file's.
 */
async function saveFile(fileName: string, blob: Blob): Promise<void> {
  const name = safeName(fileName);
  const written = await Filesystem.writeFile({ path: `${OUT}/${Date.now()}/${name}`, data: await base64Of(blob), directory: Directory.Cache, recursive: true });
  await Share.share({ title: name, files: [written.uri] });
}

// What a previous run handed over (a plain copy of a notebook, maybe) is not kept: nothing is being handed over when the app starts.
void Filesystem.rmdir({ path: OUT, directory: Directory.Cache, recursive: true }).catch(() => undefined);

/**
 * The system's back gesture: it closes the dialog that is open, else goes back in the history of the pages (the app keeps an address per
 * page, as in a browser), and leaves the app at the first. (Left alone, Capacitor leaves the app at once, whatever the history holds.)
 */
void App.addListener("backButton", () => {
  const dialog = document.querySelector("dialog[open]");
  const close = dialog && [...dialog.querySelectorAll("button")].find((button) => /^(cancel|close)$/i.test(button.textContent?.trim() ?? ""));
  if (close) return close.click();
  const navigation = (window as unknown as { navigation?: { canGoBack: boolean } }).navigation;
  if (navigation ? navigation.canGoBack : history.length > 1) history.back();
  else void App.exitApp();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// an account on a server (web/src/account/native.ts is the page's side). The page's content policy lets it ask nowhere but its own address, so the app's own code makes
// the requests and keeps the token (android/app/src/main/java/org/zimnotebook/app/ZimNativePlugin.java), and the person signs in in their own browser, which sends them
// back to this app by an address of its own that Android hands to it (`appUrlOpen`).

interface ZimNative {
  request(options: NetRequest): Promise<NetResponse>;
  openBrowser(options: { url: string }): Promise<void>;
  secretGet(options: { name: string }): Promise<{ value: string | null }>;
  secretSet(options: { name: string; value: string }): Promise<void>;
  secretRemove(options: { name: string }): Promise<void>;
}
const ZimNative = registerPlugin<ZimNative>("ZimNative");

/** How long the browser is waited for: long enough to sign in, read the page and perhaps make an account (a code is mailed). */
const WAIT_MS = 5 * 60 * 1000;

let expectedState: string | null = null;
let stopWaiting: ((reason: Error) => void) | null = null;

const signIn: SignInHooks = {
  async begin(state) {
    stopWaiting?.(new Error("Another sign-in was begun."));
    expectedState = state;
    return { redirectUri: REDIRECT_URI };
  },
  wait(url) {
    return new Promise<SignInResult>((resolve, reject) => {
      let finished = false;
      let listener: PluginListenerHandle | undefined;
      const end = (finish: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void listener?.remove();
        stopWaiting = null;
        expectedState = null;
        finish();
      };
      const timer = setTimeout(() => end(() => reject(new Error("The browser did not come back in time."))), WAIT_MS);
      stopWaiting = (reason) => end(() => reject(reason));
      void App.addListener("appUrlOpen", (event) => {
        const answer = answerOf(event.url, expectedState);
        if (answer) end(() => resolve(answer));
      }).then((handle) => {
        listener = handle;
        if (finished) void handle.remove();
      });
      ZimNative.openBrowser({ url }).catch((error: unknown) => end(() => reject(error instanceof Error ? error : new Error(String(error)))));
    });
  },
  cancel() {
    stopWaiting?.(new Error("The sign-in was cancelled."));
  },
};

const account: AccountHooks = {
  request: (request) => ZimNative.request(request),
  signIn,
  secrets: {
    get: async (name) => (await ZimNative.secretGet({ name })).value,
    set: (name, value) => ZimNative.secretSet({ name, value }),
    remove: (name) => ZimNative.secretRemove({ name }),
  },
};

const hooks: ShellHooks = { version: __SHELL_VERSION__, saveFile, account };
(window as unknown as { __zimShell?: ShellHooks }).__zimShell = hooks;
