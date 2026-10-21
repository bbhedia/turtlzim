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

/** One request that the shell makes for the page: a method, an address, headers and a text body (every body of the account server's is JSON). */
export interface NetRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** What the server answered: the status, the headers (names in lower case) and the body as text. */
export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** What the person's own browser came back to the app with, after they signed in there (the query of the return address). */
export interface SignInResult {
  code?: string;
  state?: string;
  error?: string;
}

/** Signing in to an account through the person's own browser (`web/src/account/native.ts`; `server/src/apps.mjs` is the other end). */
export interface SignInHooks {
  /** Get ready to be sent back to, for a request that carries this `state`, and say where the browser is to be sent back to (an address that only this app receives). */
  begin(state: string): Promise<{ redirectUri: string }>;
  /** Open `url` in the person's browser and wait for it to come back to the return address. Rejects when `cancel` was called or the wait ran out. */
  wait(url: string): Promise<SignInResult>;
  /** Stop waiting (and stop being reachable at the return address). */
  cancel(): void;
}

/** What has to stay secret on this device, kept where the system keeps such things (a keychain) or, where there is none, in a file that only the person's account can read. */
export interface SecretHooks {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * The two ways that a shell can refuse a request for the sake of the server's certificate, as the `code` of the failure (`request` rejects with an error that has one, and words in its
 * `message`): the system does not know who made it and nothing was trusted for this address, or something was trusted for this address (`TrustHooks.pin`) and the server shows another.
 */
export const CERTIFICATE_UNTRUSTED = "certificate-untrusted";
export const CERTIFICATE_CHANGED = "certificate-changed";

/** What a server showed as its certificate (the first of the chain that it sent), as the shell saw it in a handshake in which nothing was sent to the server. */
export interface CertificateInfo {
  /**
   * The certificate's SHA-256 as 32 pairs of capital hexadecimal digits with a colon between them: what `openssl x509 -noout -fingerprint -sha256` says, what a browser's certificate viewer
   * shows, and what the person who runs the server is told when the server starts. It is what is compared and what is kept: nothing else of the certificate counts.
   */
  fingerprint: string;
  /** What the certificate says of itself, where the shell can read it (a person is shown what is there, and nothing is decided from any of it). */
  subject?: string;
  issuer?: string;
  /** The names (host names and addresses) that it says it is good for. */
  names?: string[];
  /** When it is valid, in milliseconds since the epoch. */
  notBefore?: number;
  notAfter?: number;
}

/**
 * Trusting, for a server, a certificate that the system does not know (a self-signed one, or one made by an authority of the person's own), by its fingerprint: the person looks at the
 * fingerprint that the shell saw, compares it with the one that the server's own console shows, and says yes or no. After a yes the shell makes a request to that address only if the server
 * shows that very certificate (the check is made in the handshake, before anything is sent: the shell never falls back to what the system trusts for that address), and a request
 * to a server that shows another one fails with `CERTIFICATE_CHANGED`. The shell keeps what was trusted; the page keeps nothing of it. An address is an origin (`https://host:port`).
 */
export interface TrustHooks {
  /** What the server at this origin shows, found out without sending it anything. Rejects, with words for a person, when it can't be reached. */
  inspect(origin: string): Promise<CertificateInfo>;
  /** Trust this certificate for this origin. The shell looks at what the server shows now and keeps nothing if it is not this one (it rejects, with words). It replaces what was trusted before. */
  pin(origin: string, fingerprint: string): Promise<void>;
  /** The fingerprint that was trusted for this origin, or null. */
  pinned(origin: string): Promise<string | null>;
  /** Stop trusting what was trusted for this origin (nothing trusted is not a failure). */
  unpin(origin: string): Promise<void>;
}

/**
 * What a shell gives for an account. The page's content policy lets it ask nowhere but its own address, so in a shell the account server is reached by the shell itself
 * (`request`: no cookies, no cross-site rules to get around, and only what the shell checks), the person signs in in their own browser (`signIn`), and the token that this
 * gives lives in `secrets`, never in the page's own storage.
 */
export interface AccountHooks {
  /** The address of the server that the shell suggests when the person connects (put there by whoever set the app up: a team's server, a test); nothing is asked of it until the person confirms. */
  defaultServer?: string | null;
  /**
   * An https request (or http, to this computer's own address). Rejects with words for a person when it can't be made (the certificate is not trusted, the server is not there), and, for a
   * failure about the certificate, with the `code` `CERTIFICATE_UNTRUSTED` or `CERTIFICATE_CHANGED` too.
   */
  request(request: NetRequest): Promise<NetResponse>;
  signIn: SignInHooks;
  secrets: SecretHooks;
  /** Trusting the certificate of a server that the system does not know. A shell without it refuses such a server, and says so. */
  trust?: TrustHooks;
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
  /** An account on a server, reached by the shell and signed in through the person's browser. */
  account?: AccountHooks;
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
