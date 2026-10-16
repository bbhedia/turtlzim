// Sealed copies of a notebook, as the page asks the engine for them (core/turtl-core-rs/src/seal.rs, which says what is sealed and how). The key for them is the vault's: it is made inside the
// engine, kept in the vault's keychain with the vault's other keys, and never handed out; what leaves is the sealed objects, and the key wrapped by the passphrase (for the places that keep the
// account's copies). Every command needs the vault unlocked. The passphrase is normalised as the vault's is, so that the one typed to unlock is the one that wraps.
import { base64ToBytes, bytesToBase64 } from "./base64";
import type { CoreClient } from "./core-client";
import { normalizePassphrase } from "./vault";

/** A file of a notebook, as it goes to be sealed. */
export interface PlainFile {
  path: string;
  bytes: Uint8Array;
}

/** What sealing a file made: where it is kept (`name`), what to keep there (`sealed`), and what the index is to say of it. */
export interface SealedFile {
  path: string;
  name: string;
  sealed: Uint8Array;
  size: number;
  sha256: string;
}

/** What an index says of a file. */
export interface IndexFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

export interface SealedIndex {
  /** Goes up with each version: a device that remembers the highest it has seen can tell that an old copy was put back. */
  counter: number;
  title: string;
  files: IndexFile[];
}

/** The commands of the engine for sealed copies, over the core of an unlocked vault. */
export class VaultSeal {
  constructor(private readonly core: () => CoreClient) {}

  /** Whether this vault has a key for sealed copies. */
  async hasKey(): Promise<boolean> {
    return (await this.core().request<{ has: boolean }>("seal:master:status")).has === true;
  }

  /** Make the key (once), and give it back wrapped by the passphrase. */
  async createKey(passphrase: string): Promise<Uint8Array> {
    return base64ToBytes((await this.core().request<{ wrapped: string }>("seal:master:create", normalizePassphrase(passphrase))).wrapped);
  }

  /** The key again, wrapped by a passphrase (the one just chosen, after the vault's was changed). */
  async wrapKey(passphrase: string): Promise<Uint8Array> {
    return base64ToBytes((await this.core().request<{ wrapped: string }>("seal:master:wrap", normalizePassphrase(passphrase))).wrapped);
  }

  /** Take the key out of a wrapped one with the passphrase that wrapped it, and keep it in this vault; false if this vault had it already. */
  async takeKey(wrapped: Uint8Array, passphrase: string): Promise<boolean> {
    return (await this.core().request<{ kept: boolean }>("seal:master:unwrap", bytesToBase64(wrapped), normalizePassphrase(passphrase))).kept === true;
  }

  async seal(notebook: string, files: PlainFile[]): Promise<SealedFile[]> {
    const made = await this.core().request<Array<{ path: string; name: string; sealed: string; size: number; sha256: string }>>("seal:objects:seal", notebook, files.map((f) => ({ path: f.path, data: bytesToBase64(f.bytes) })));
    return made.map((m) => ({ ...m, sealed: base64ToBytes(m.sealed) }));
  }

  /** Open objects kept under their names. An object that does not open (another key, another name, a changed byte) fails the whole call. */
  async open(notebook: string, objects: Array<{ name: string; sealed: Uint8Array }>): Promise<Array<{ name: string; bytes: Uint8Array }>> {
    const opened = await this.core().request<Array<{ name: string; data: string }>>("seal:objects:open", notebook, objects.map((o) => ({ name: o.name, sealed: bytesToBase64(o.sealed) })));
    return opened.map((o) => ({ name: o.name, bytes: base64ToBytes(o.data) }));
  }

  async sealIndex(notebook: string, index: SealedIndex): Promise<Uint8Array> {
    return base64ToBytes((await this.core().request<{ sealed: string }>("seal:index:seal", notebook, index)).sealed);
  }

  async openIndex(notebook: string, sealed: Uint8Array): Promise<SealedIndex> {
    return this.core().request<SealedIndex>("seal:index:open", notebook, bytesToBase64(sealed));
  }
}
