// The vault: where the encrypted notebooks live. It is one account of the core (which runs without
// a server, in a Worker of its own) that one passphrase unlocks; each encrypted notebook is a space
// in it, with a key of its own that the passphrase's key protects. Locking ends the Worker, so the
// keys and everything decrypted go with it.
import { CoreClient, CoreError, WorkerTransport } from "./core-client";
import type { CoreTransport } from "./core-client";
import type { Persistence } from "./protocol";

/** The origin-private directory the vault's databases are kept in. */
export const VAULT_DIRECTORY = "turtl-core";

/** The passphrase is wrong (or this is not the vault that passphrase belongs to). */
export class WrongPassphraseError extends Error {
  constructor() {
    super("That is not the passphrase for these encrypted notebooks.");
    this.name = "WrongPassphraseError";
  }
}

/** Another tab has the encrypted notebooks open: only one can at a time. */
export class VaultBusyError extends Error {
  constructor() {
    super("The encrypted notebooks are open in another tab or window. Lock them there (or close it), then try again.");
    this.name = "VaultBusyError";
  }
}

/** This browser can't keep encrypted notebooks (see `Vault.support`). */
export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

/** There is no vault to unlock here: none was made, or the browser's data was cleared. */
export class NoVaultError extends Error {
  constructor() {
    super("There are no encrypted notebooks in this browser (they may have been erased, or this is a different browser or profile).");
    this.name = "NoVaultError";
  }
}

/** A vault is made once: after that it is unlocked. */
export class VaultExistsError extends Error {
  constructor() {
    super("There are already encrypted notebooks in this browser: unlock them instead.");
    this.name = "VaultExistsError";
  }
}

export type VaultSupport = { ok: true } | { ok: false; reason: string };

/** Whether this browser can keep a vault: the engine runs in a Worker, and the private files it keeps data in exist only on secure pages. */
export function vaultSupport(): VaultSupport {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    return { ok: false, reason: "This browser can't run the engine that encrypts notebooks." };
  }
  if (!globalThis.isSecureContext) {
    return { ok: false, reason: "Encrypted notebooks need a secure page: open this app over https://, or from localhost." };
  }
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    return { ok: false, reason: "This browser can't keep private files, which encrypted notebooks are stored in." };
  }
  return { ok: true };
}

/** The shortest passphrase the app accepts for a vault, in characters. */
export const MIN_PASSPHRASE_LENGTH = 10;

const COMMON = new Set(["password", "passphrase", "1234567890", "0123456789", "qwertyuiop", "letmein123", "iloveyou123", "administrator"]);

/** Why `passphrase` won't do for a vault, or null if it will. (Anyone who copies the vault's data can try passphrases as fast as their machines go, so a short or common one isn't enough.) */
export function checkPassphrase(passphrase: string): string | null {
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters: a few unrelated words make a good passphrase that is easy to remember.`;
  if (new Set([...passphrase]).size < 4) return "That passphrase repeats too few different characters.";
  if (COMMON.has(passphrase.toLowerCase())) return "That passphrase is one of the first a stranger would try.";
  return null;
}

/**
 * The passphrase as it is made into a key. A passphrase with an accent in it can be typed in more than
 * one way that looks the same (é as one character, or as e and a combining accent: keyboards and systems
 * differ), and each way is different bytes, so a vault made on one computer would not open on another.
 * Unicode's compatibility normalisation (NFKC, which password managers also use) makes them the same.
 * It is the same for ASCII, so it changes nothing for most passphrases, and it has to be the same for as
 * long as there are vaults: changing it would change every key.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFKC");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What happens to a vault: it is `unlocked` or `locked` as asked, or `lost` when its engine dies on its own (and then it is locked too). */
export type VaultEvent = { kind: "unlocked" } | { kind: "locked" } | { kind: "lost"; reason: string };

export interface VaultOptions {
  /** Starts a core and says how to reach it. The default is the real thing: a Worker. */
  connect?: () => CoreTransport;
  /** Where the databases are kept. The default is the vault's directory; tests that have no file system pass null. */
  persistence?: Persistence | null;
}

export class Vault {
  private client: CoreClient | null = null;
  private readonly connect: () => CoreTransport;
  private readonly persistence: Persistence | null;
  private readonly listeners = new Set<(event: VaultEvent) => void>();
  /** Whether the browser promised to keep the vault's data when it is short of room (null: not asked, or not told). Without that promise it may delete it. */
  persisted: boolean | null = null;
  /** The unlock or lock in progress: they go one at a time. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(options: VaultOptions = {}) {
    this.connect = options.connect ?? (() => new WorkerTransport());
    this.persistence = options.persistence === undefined ? { directory: VAULT_DIRECTORY } : options.persistence;
  }

  get unlocked(): boolean {
    return this.client !== null;
  }

  /** Be told when the vault is unlocked, locked, or lost. Returns the function that stops it. */
  onChange(listener: (event: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VaultEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The vault is open on `client` from now on: and ends if the engine dies. */
  private adopt(client: CoreClient): void {
    this.client = client;
    client.onLost((reason) => {
      if (this.client !== client) return;
      this.client = null;
      this.emit({ kind: "lost", reason });
    });
    this.emit({ kind: "unlocked" });
  }

  /** The core, for whoever reads and writes the notebooks: only while unlocked. */
  get core(): CoreClient {
    if (!this.client) throw new Error("The encrypted notebooks are locked.");
    return this.client;
  }

  /** Whether encrypted notebooks were made in this browser (looks inside, so it takes a moment). Leaves the vault as it was. */
  async exists(): Promise<boolean> {
    if (this.client) return true;
    return this.exclusive(async () => {
      const client = await this.boot();
      try {
        return (await client.request<string[]>("user:local-accounts")).length > 0;
      } finally {
        await client.close();
      }
    });
  }

  /** Make the vault, with this passphrase, and leave it unlocked. */
  async create(passphrase: string): Promise<void> {
    const problem = checkPassphrase(passphrase);
    if (problem) throw new Error(problem);
    await this.exclusive(async () => {
      if (this.client) throw new VaultExistsError();
      const client = await this.boot();
      try {
        if ((await client.request<string[]>("user:local-accounts")).length > 0) throw new VaultExistsError();
        // a name of its own, which is part of what the passphrase is made into a key with: nobody else's key is made the same way
        const name = hex(crypto.getRandomValues(new Uint8Array(16)));
        await client.request("user:join", name, normalizePassphrase(passphrase));
      } catch (error) {
        await client.close();
        throw error;
      }
      this.adopt(client);
      await this.askToKeep();
    });
  }

  /** Unlock the vault with its passphrase. Throws `WrongPassphraseError` if it isn't. */
  async unlock(passphrase: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.client) return;
      const client = await this.boot();
      try {
        const accounts = await client.request<string[]>("user:local-accounts");
        const name = accounts[0];
        if (name === undefined) throw new NoVaultError();
        try {
          await client.request("user:login", name, normalizePassphrase(passphrase));
        } catch (error) {
          if (error instanceof CoreError && error.kind === "api" && error.subtype === "Unauthorized") throw new WrongPassphraseError();
          throw error;
        }
      } catch (error) {
        await client.close();
        throw error;
      }
      this.adopt(client);
      void this.askToKeep();
    });
  }

  /** Lock the vault: the core logs out and its Worker is ended, so nothing decrypted or secret stays in memory. */
  async lock(): Promise<void> {
    await this.exclusive(async () => {
      const client = this.client;
      if (!client) return;
      this.client = null;
      // the logout closes the databases; its answer comes a second later, but the event is immediate
      const loggedOut = new Promise<void>((resolve) => {
        const stop = client.onEvent((event) => {
          if (event.e === "user:logout") {
            stop();
            resolve();
          }
        });
      });
      client.request("user:logout", false).catch(() => undefined);
      await Promise.race([loggedOut, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      await client.close();
      this.emit({ kind: "locked" });
    });
  }

  /**
   * Erase the vault and everything in it (for someone who has lost the passphrase, or is done with
   * encrypted notebooks): what the browser holds of it is deleted. The vault has to be locked.
   */
  async erase(): Promise<void> {
    await this.exclusive(async () => {
      if (this.client) throw new Error("Lock the encrypted notebooks first.");
      const root = await navigator.storage.getDirectory();
      // (a Worker that was just ended lets go of its files a moment later: another tab that has them doesn't)
      for (let attempt = 1; ; attempt++) {
        try {
          await root.removeEntry(VAULT_DIRECTORY, { recursive: true });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "NotFoundError") return;
          if (error instanceof DOMException && error.name === "NoModificationAllowedError") {
            if (attempt >= 30) throw new VaultBusyError();
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw error;
        }
      }
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.busy.then(work);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** Start a core, turning what can go wrong with the storage into errors the app can explain. */
  private async boot(): Promise<CoreClient> {
    if (this.persistence) {
      const support = vaultSupport();
      if (!support.ok) throw new VaultUnavailableError(support.reason);
    }
    try {
      return await CoreClient.boot(this.connect(), this.persistence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/in use by another tab/i.test(message)) throw new VaultBusyError();
      if (/persistent storage/i.test(message)) throw new VaultUnavailableError("This browser won't keep private files for encrypted notebooks.");
      throw error;
    }
  }

  /** Ask the browser not to clear the vault's data when it is short of room: the data can't be recovered if it does. */
  private async askToKeep(): Promise<void> {
    try {
      this.persisted = (await navigator.storage?.persist?.()) ?? null;
    } catch {
      // not allowed here: the notebooks are kept all the same, just not guaranteed to stay
      this.persisted = null;
    }
  }
}
