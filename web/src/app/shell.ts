// The app inside a native shell: a WebView in an installed app (Capacitor on a phone, Android and iOS: mobile/; Tauri on a computer,
// Windows and Linux: desktop/). The web app depends on no shell. A shell makes itself known by what its WebView has before any
// script of the page runs (`window.Capacitor`, or `window.__TAURI_INTERNALS__`), and gives the app the few things that a WebView does not do
// by itself through `window.__zimShell`, which the shell's own script (mobile/shell/, desktop/src-tauri/shell.js) puts there before the app starts. What a shell does not give
// is done as in a browser, so a shell without a hook is a browser with less.

/** A folder that the person chose to keep a notebook in. The page knows it by an id, never by a path. */
export interface FolderRoot {
  id: string;
  /** The name of the folder. */
  name: string;
  /** Whether it is still there. */
  exists: boolean;
}

/** A file of a notebook folder: its path in it (`/` between folders, nothing hidden), its size and when it was last changed (ms since the epoch). */
export interface FolderEntry {
  path: string;
  size: number;
  modified: number;
}

/** A change of files that is made entirely or not at all: files are moved (all read before any is written), then deleted, then written. */
export interface FolderChange {
  /** `modified` is the time the file is to say it was changed (ms since the epoch). */
  writes: Array<{ path: string; bytes: Uint8Array; modified?: number }>;
  deletes: string[];
  moves: Array<[from: string, to: string]>;
}

/** Notebooks as folders of Zim files on the computer (a shell that has a file system of its own to give: the desktop program). */
export interface FolderHooks {
  /** The folders that are notebooks. */
  roots(): Promise<FolderRoot[]>;
  /** Ask where, with the system's folder dialog, and list the folder it names; null if the person cancelled. */
  pick(): Promise<FolderRoot | null>;
  /** Stop listing a folder as a notebook. Nothing in it is touched. */
  forget(id: string): Promise<void>;
  /** Every file of the folder that is not hidden. */
  list(id: string): Promise<FolderEntry[]>;
  read(id: string, path: string): Promise<Uint8Array>;
  apply(id: string, change: FolderChange): Promise<void>;
}

/** What a shell does for the app that a browser does itself. */
export interface ShellHooks {
  /** What this shell is, for the "About this version" dialog: the app's version and the version of the web build inside it. */
  version?: string;
  /**
   * Hand a file to the person to save or send (the system's own sheet). A WebView does nothing with a link to a Blob that has
   * `download`, which is how a browser saves a file. Resolves when the file was handed over, not when it was saved.
   */
  saveFile?(fileName: string, blob: Blob): Promise<void>;
  /** Notebooks kept as folders of files on the computer. */
  folders?: FolderHooks;
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
