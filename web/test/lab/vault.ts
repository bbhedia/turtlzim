// A page that puts the vault in reach of the browser tests, which call `lab` from outside: they
// can't pass functions or classes across, so each call answers with plain data.
import { Vault, VaultBusyError, WrongPassphraseError, NoVaultError, vaultSupport } from "../../src/vault";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; message: string };

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

const vault = new Vault();

const lab = {
  support: () => vaultSupport(),
  secureContext: () => globalThis.isSecureContext,
  unlocked: () => vault.unlocked,
  exists: () => attempt(() => vault.exists()),
  create: (passphrase: string) => attempt(() => vault.create(passphrase)),
  unlock: (passphrase: string) => attempt(() => vault.unlock(passphrase)),
  lock: () => attempt(() => vault.lock()),
  erase: () => attempt(() => vault.erase()),
  /** What the core says about who is logged in: proof that the core answers through the Worker. */
  whoAmI: () => attempt(async () => (await vault.core.request<{ user: { username: string } }>("profile:load")).user.username),
  accounts: () => attempt(() => vault.core.request<string[]>("user:local-accounts")),
  errors: { VaultBusyError: VaultBusyError.name, WrongPassphraseError: WrongPassphraseError.name, NoVaultError: NoVaultError.name },
  /** Every byte the origin-private file system holds, as [path, bytes]; the vault has to be locked (nothing may hold its files). */
  opfsFiles: () =>
    attempt(async () => {
      const found: Array<[string, number[]]> = [];
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
          else found.push([`${prefix}${name}`, [...new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer())]]);
        }
      };
      await walk(await navigator.storage.getDirectory(), "");
      return found;
    }),
};

declare global {
  interface Window {
    lab: typeof lab;
  }
}
window.lab = lab;
