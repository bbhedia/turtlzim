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

/** Whether this vault has a key for sealed copies, and which one it is (a check value that two places can compare without a passphrase). */
export interface KeyStatus {
  has: boolean;
  check?: string;
}

/** A key wrapped by a passphrase, as it is kept where the account keeps its copies, and its check value. */
export interface WrappedKey {
  wrapped: Uint8Array;
  check: string;
}

/** The commands of the engine for sealed copies, over the core of an unlocked vault. */
export class VaultSeal {
  constructor(private readonly core: () => CoreClient) {}

  /** Whether this vault has a key for sealed copies. */
  async status(): Promise<KeyStatus> {
    const answer = await this.core().request<{ has: boolean; check?: string }>("seal:master:status");
    return answer.has === true ? { has: true, check: String(answer.check) } : { has: false };
  }

  async hasKey(): Promise<boolean> {
    return (await this.status()).has;
  }

  /**
   * Make a key for the account, wrapped by the passphrase, and keep nothing: the key goes into the vault (`takeKey`) once the place that keeps the wrapped one has accepted it. The passphrase
   * has to be the vault's, which the engine checks (it fails like a wrong passphrase at unlocking does).
   */
  async makeKey(passphrase: string): Promise<WrappedKey> {
    const made = await this.core().request<{ wrapped: string; check: string }>("seal:master:make", normalizePassphrase(passphrase));
    return { wrapped: base64ToBytes(made.wrapped), check: made.check };
  }

  /** The vault's key again, wrapped by the vault's passphrase (the new one, after it was changed). */
  async wrapKey(passphrase: string): Promise<WrappedKey> {
    const made = await this.core().request<{ wrapped: string; check: string }>("seal:master:wrap", normalizePassphrase(passphrase));
    return { wrapped: base64ToBytes(made.wrapped), check: made.check };
  }

  /** Take the key out of a wrapped one with the passphrase that wrapped it, and keep it in this vault; `kept` is false if this vault had it already. */
  async takeKey(wrapped: Uint8Array, passphrase: string): Promise<{ kept: boolean; check: string }> {
    const taken = await this.core().request<{ kept: boolean; check: string }>("seal:master:unwrap", bytesToBase64(wrapped), normalizePassphrase(passphrase));
    return { kept: taken.kept === true, check: taken.check };
  }

  /**
   * Forget this vault's key for sealed copies, so that it can take another (`takeKey`). The vault's own passphrase is needed (the engine checks it): what this vault sealed with the key and
   * that is kept where only it opens (a copy on a connected service) can't be opened here afterwards, and the key can't be got back from here. Tells whether there was a key to forget.
   */
  async forgetKey(passphrase: string): Promise<boolean> {
    const done = await this.core().request<{ forgot: boolean }>("seal:master:forget", normalizePassphrase(passphrase));
    return done.forgot === true;
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
