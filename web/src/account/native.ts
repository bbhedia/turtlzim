// An account, from a native shell (the program on a computer, the app on a phone). The page's content policy lets it ask nowhere but its own address, and a shell's address is not the
// server's, so three things come from the shell (`AccountHooks` in `../app/shell.ts`): the requests (made by the shell itself, with no cookie and no cross-site rule to get around), the
// person's own browser (where they sign in as they always do: the app never sees the password), and a place for the token that is secret. The server's end of it is `server/src/apps.mjs`
// (RFC 8252 with PKCE): this app makes a secret and a random state, the browser says "yes, this app" and comes back to an address that only this app receives, with a code, and the app
// trades the code and its secret for a token that it keeps in the system's keychain (never in the page's storage, where a script could read it).
import { CERTIFICATE_CHANGED, CERTIFICATE_UNTRUSTED } from "../app/shell";
import type { AccountHooks, CertificateInfo } from "../app/shell";
import { AccountClient, ApiError, TransportError } from "./client";
import type { Account, Fetcher } from "./client";

/** The name that the address of the server is kept under (it is no secret: the token is, and lives in the shell's keychain). */
export const SERVER_SETTING = "account-server";
const TOKEN_NAME = "account-token";

export interface Settings {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The person stopped waiting for the browser (or the shell did). Not a failure to tell them about. */
export class SignInCancelled extends Error {
  constructor() {
    super("The sign-in was cancelled.");
    this.name = "SignInCancelled";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address of a server as a person types it, as the address that is used: only its origin. It is https (a server that is not on this computer is reached over a connection that
 * nobody on the way can read), or http to this computer's own address (a server being tried out); no name or password in it, no folder after it.
 */
export function parseServer(input: string): { server: string } | { problem: string } {
  const typed = input.trim();
  if (!typed) return { problem: "Type the address of your server, like https://notes.example.org." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { problem: "That does not look like the address of a server." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return { problem: url.protocol === "http:" ? "A server that is not on this computer has to be reached over https:, or what is sent to it could be read on the way." : "The address of the server starts with https://." };
  }
  if (url.username || url.password) return { problem: "Leave the name and the password out of the address: you sign in in your browser." };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return { problem: "Type only the address of the server, without a folder after it." };
  return { server: url.origin };
}

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `bytes` random bytes, as text that can be put in an address. */
export function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** What the server is shown of a secret (RFC 7636's `S256`): its SHA-256, as base64url. */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource)));
}

/** What a failure of the shell's request says: the shell's own words, which are written for a person (the certificate is not trusted, the name was not found), or a plain line. */
function reasonOf(error: unknown): string {
  const said = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error;
  return typeof said === "string" && said ? said : "The server can't be reached.";
}

/** The code of a failure about the server's certificate (the only codes that the page acts on), or nothing. */
function codeOf(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === CERTIFICATE_UNTRUSTED || code === CERTIFICATE_CHANGED ? code : undefined;
}

/** Why the person is asked about a certificate: the system does not know it and nothing was trusted for this server (`new`), or something was and the server shows another (`changed`). */
export type CertificateKind = "new" | "changed";

/** What the person is put to: the certificate that the server showed, what they trusted for it before (its fingerprint), the shell's own words for why it was refused, and the server. */
export interface CertificateQuestion {
  info: CertificateInfo;
  kind: CertificateKind;
  previous: string | null;
  reason: string;
  server: string;
}

/** Ask the person whether to trust a certificate (true: they do). */
export type TrustAsk = (question: CertificateQuestion) => Promise<boolean>;

/** The person did not trust the server's certificate: nothing was connected, and there is nothing to tell them beyond that. */
export class CertificateRefused extends Error {
  constructor() {
    super("You did not trust that server's certificate, so nothing was connected.");
    this.name = "CertificateRefused";
  }
}

/** Whether two fingerprints are the same one, however they are written (capitals or not, colons or spaces between the pairs). */
export function sameFingerprint(a: string, b: string): boolean {
  const plain = (text: string): string => text.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return plain(a).length === 64 && plain(a) === plain(b);
}

export class NativeAccount {
  /** The token, once read (undefined: not read yet). */
  private token: Promise<string | null> | undefined;
  private waiting = false;
  private cancelled = false;
  /** The client that talks to the server this app is connected to (the address is read when a request is made, so a connection made later is used by it). */
  readonly client: AccountClient;

  constructor(
    private readonly hooks: AccountHooks,
    private readonly settings: Settings,
  ) {
    this.client = new AccountClient(this.fetcher(() => this.server, () => this.readToken()));
  }

  /** The server this app is connected to (or has been, and the token may have gone), or null. */
  get server(): string | null {
    const kept = this.settings.get(SERVER_SETTING);
    return kept && "server" in parseServer(kept) ? kept : null;
  }

  /** The token that is kept, or null (a keychain that can't be read now is asked again the next time). */
  private readToken(): Promise<string | null> {
    if (!this.token) {
      const reading = this.hooks.secrets.get(TOKEN_NAME);
      this.token = reading;
      reading.catch(() => {
        if (this.token === reading) this.token = undefined;
      });
    }
    return this.token.catch(() => null);
  }

  /** The address to put in the dialog that connects: the server this app is connected to (or has been), else the one that the shell suggests, else none. */
  get suggested(): string {
    const suggestion = this.hooks.defaultServer;
    const parsed = typeof suggestion === "string" ? parseServer(suggestion) : null;
    return this.server ?? (parsed && "server" in parsed ? parsed.server : "");
  }

  /** Whether this app holds a token (it may be one that the server has since ended). */
  async hasToken(): Promise<boolean> {
    return (await this.readToken()) !== null;
  }

  /** A `fetch` for an account client: the request goes to the shell, to the server's own address (nothing the client asks can go elsewhere), with a token if there is one. */
  private fetcher(serverOf: () => string | null, tokenOf: () => Promise<string | null>): Fetcher {
    return async (input, init) => {
      const server = serverOf();
      if (!server) throw new TransportError("No server is set.");
      const url = new URL(input, `${server}/`);
      if (url.origin !== server || !url.pathname.startsWith("/api/")) throw new TransportError("That is not a request to the server.");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
      const token = await tokenOf();
      if (token) headers.authorization = `Bearer ${token}`;
      let answer;
      try {
        answer = await this.hooks.request({ url: url.href, method: init?.method ?? "GET", headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      } catch (error) {
        throw new TransportError(reasonOf(error), codeOf(error));
      }
      if (!Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) throw new TransportError("The server answered something unexpected.");
      return new Response([204, 205, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
    };
  }

  /**
   * Whether the shell can keep a certificate that the person trusts for a server whose certificate the system does not know (`TrustHooks`); without that such a server is refused.
   */
  get canTrustCertificates(): boolean {
    return this.hooks.trust !== undefined;
  }

  /** What the server at this address shows as its certificate, found out without sending it anything. */
  async inspect(server: string): Promise<CertificateInfo> {
    if (!this.hooks.trust) throw new Error("This app can't look at a server's certificate.");
    return this.hooks.trust.inspect(server);
  }

  /** The fingerprint that was trusted for this server, or null. */
  async pinned(server: string | null = this.server): Promise<string | null> {
    if (!server || !this.hooks.trust) return null;
    return this.hooks.trust.pinned(server).catch(() => null);
  }

  /** Trust this certificate for this server (what the server shows now has to be it: the shell looks again). */
  async trust(server: string, info: CertificateInfo): Promise<void> {
    if (!this.hooks.trust) throw new Error("This app can't keep a certificate that it trusts.");
    try {
      await this.hooks.trust.pin(server, info.fingerprint);
    } catch (failure) {
      throw new Error(`The certificate could not be trusted: ${reasonOf(failure)}`);
    }
  }

  /**
   * Is this an account server of this app, with a certificate that this device trusts, or that the person has trusted for it? A certificate that the system does not know (or that is not the one
   * the person trusted before) is put to the person with its fingerprint, if they can be asked (`ask`) and the shell can keep what they trust; after a yes the server is tried again, once.
   * A failure of any other kind says that the address does not work.
   */
  private async reach(server: string, plain: AccountClient, ask?: TrustAsk): Promise<void> {
    for (let round = 0; ; round++) {
      try {
        await plain.checkServer();
        return;
      } catch (error) {
        const refused = error instanceof ApiError && (error.code === CERTIFICATE_UNTRUSTED || error.code === CERTIFICATE_CHANGED) ? error : null;
        if (!refused || !this.hooks.trust || !ask || round > 0) throw new Error(`That address does not work as an account server: ${error instanceof ApiError ? error.message : "it did not answer."}`);
        let info: CertificateInfo;
        try {
          info = await this.inspect(server);
        } catch (failure) {
          throw new Error(`The server's certificate could not be looked at: ${reasonOf(failure)}`);
        }
        const previous = await this.pinned(server);
        if (this.cancelled) throw new SignInCancelled();
        const yes = await ask({ info, kind: refused.code === CERTIFICATE_CHANGED ? "changed" : "new", previous, reason: refused.message, server });
        if (this.cancelled) throw new SignInCancelled();
        if (!yes) throw new CertificateRefused();
        await this.trust(server, info);
      }
    }
  }

  /**
   * Connect to the account on the server at `address`: the person's browser is opened at the server (they sign in there, and allow this app), and the answer is waited for. `waiting` is
   * called with the address that the browser was sent to, once it has been, so that the screen can say what is being waited for (and give the address to a person whose browser did not open).
   * A server whose certificate the system does not know is put to the person first (`ask`: see `reach`). Resolves with the account; rejects with `SignInCancelled` if `cancel` was called, and
   * with `CertificateRefused` if the person did not trust the certificate.
   */
  async connect(address: string, waiting?: (url: string) => void, ask?: TrustAsk): Promise<Account> {
    const parsed = parseServer(address);
    if ("problem" in parsed) throw new Error(parsed.problem);
    const { server } = parsed;
    const before = this.server;
    this.cancelled = false;
    this.waiting = true;
    try {
      // (is it a Zim account server, with a certificate that this device trusts? asked before the browser is opened for nothing)
      const plain = new AccountClient(this.fetcher(() => server, async () => null));
      await this.reach(server, plain, ask);
      if (this.cancelled) throw new SignInCancelled();
      const verifier = randomToken(32);
      const state = randomToken(16);
      const challenge = await challengeOf(verifier);
      let redirectUri: string;
      let back;
      try {
        ({ redirectUri } = await this.hooks.signIn.begin(state));
        const params = new URLSearchParams({ app: "authorize", redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state });
        const url = `${server}/?${params}`;
        const wait = this.hooks.signIn.wait(url);
        waiting?.(url);
        back = await wait;
      } catch (error) {
        if (this.cancelled) throw new SignInCancelled();
        throw new Error(`The browser did not come back: ${error instanceof Error ? error.message : String(error)}`);
      }
      // (the answer has to be to this request, and nothing of it is shown but what is fixed here)
      if (back.state !== state) throw new Error("The browser came back with an answer that is not to this request. Try again.");
      if (back.error || !back.code) throw new Error("The sign-in did not work in the browser. Try again.");
      const granted = await plain.exchangeAppCode({ code: back.code, code_verifier: verifier, redirect_uri: redirectUri });
      try {
        await this.hooks.secrets.set(TOKEN_NAME, granted.token);
      } catch (error) {
        // (a token that can't be kept is of no use, and must not be left alive on the server: it is ended there)
        await new AccountClient(this.fetcher(() => server, async () => granted.token)).logout().catch(() => {});
        throw new Error(`The sign-in worked, but this device can't keep what it needs to stay signed in: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.token = Promise.resolve(granted.token);
      this.settings.set(SERVER_SETTING, server);
      // (what was trusted for the server that this one replaces is of no use any more)
      if (before && before !== server) await this.hooks.trust?.unpin(before).catch(() => {});
      return granted.account;
    } finally {
      this.waiting = false;
    }
  }

  /** Stop waiting for the browser. */
  cancel(): void {
    if (!this.waiting) return;
    this.cancelled = true;
    this.hooks.signIn.cancel();
  }

  /** The token is no good any more (the server ended this app's session): forget it, and keep the address, so that signing in again is one step. */
  async forgetToken(): Promise<void> {
    this.token = Promise.resolve(null);
    await this.hooks.secrets.remove(TOKEN_NAME).catch(() => {});
  }

  /** Sign out: the server is told (so that the token is dead there too) and everything this app kept is forgotten, a certificate that was trusted for the server included. Says whether the server could be told. */
  async disconnect(): Promise<boolean> {
    let told = true;
    const server = this.server;
    if (server && (await this.hasToken())) {
      try {
        await this.client.logout();
      } catch {
        told = false;
      }
    }
    await this.forgetToken();
    if (server) await this.hooks.trust?.unpin(server).catch(() => {});
    this.settings.remove(SERVER_SETTING);
    return told;
  }
}
