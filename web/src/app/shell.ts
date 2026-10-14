// The app inside a native shell: a WebView in an installed app (Capacitor on a phone, Android and iOS: mobile/; Tauri on a computer,
// Windows and Linux: desktop/). The web app depends on no shell. A shell makes itself known by what its WebView has before any
// script of the page runs (`window.Capacitor`, or `window.__TAURI_INTERNALS__`), and gives the app the few things that a WebView does not do
// by itself through `window.__zimShell`, which the shell's own script (mobile/shell/, desktop/src-tauri/shell.js) puts there before the app starts. What a shell does not give
// is done as in a browser, so a shell without a hook is a browser with less.

/** What a shell does for the app that a browser does itself. */
export interface ShellHooks {
  /** What this shell is, for the "About this version" dialog: the app's version and the version of the web build inside it. */
  version?: string;
  /**
   * Hand a file to the person to save or send (the system's own sheet). A WebView does nothing with a link to a Blob that has
   * `download`, which is how a browser saves a file. Resolves when the file was handed over, not when it was saved.
   */
  saveFile?(fileName: string, blob: Blob): Promise<void>;
}

/** The part of the window that a shell fills in. */
export interface ShellWindow {
  Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean };
  /** Tauri puts this in every page of its WebView. */
  __TAURI_INTERNALS__?: unknown;
  __zimShell?: ShellHooks;
}

/** The platform of the shell that the page runs in (`android`, `ios`, `desktop`), or null in a browser. */
export function shellPlatform(win: ShellWindow = window as ShellWindow): string | null {
  if (win.__TAURI_INTERNALS__ !== undefined) return "desktop";
  const capacitor = win.Capacitor;
  if (!capacitor) return null;
  const platform = capacitor.getPlatform?.() ?? (capacitor.isNativePlatform?.() ? "native" : "web");
  return platform === "web" ? null : platform;
}

/** What the shell gives, which is nothing in a browser. */
export function shellHooks(win: ShellWindow = window as ShellWindow): ShellHooks {
  return shellPlatform(win) !== null ? (win.__zimShell ?? {}) : {};
}
