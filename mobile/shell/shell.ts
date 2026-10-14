// The shell's script. It runs in the WebView before the web app starts, and gives the app the things that a WebView does not do by
// itself (web/src/app/shell.ts says which hooks there are and what a shell without one is). The web app depends on none of this.
import { App } from "@capacitor/app";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { ShellHooks } from "../../web/src/app/shell";

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

const hooks: ShellHooks = { version: __SHELL_VERSION__, saveFile };
(window as unknown as { __zimShell?: ShellHooks }).__zimShell = hooks;
