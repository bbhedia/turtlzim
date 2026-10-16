// A page that puts the vault in reach of the browser tests, which call `lab` from outside: they
// can't pass functions or classes across, so each call answers with plain data.
import sodium from "libsodium-wrappers-sumo";
import { pageKey } from "../../src/notebook-core";
import type { PageChange, StoredFile, StoredPage } from "../../src/notebook/store";
import { Vault, VaultBusyError, VaultExistsError, WrongPassphraseError, NoVaultError, NotABackupError, WorkerTransport, vaultSupport } from "../../src/vault";
import { base64ToBytes, bytesToBase64 } from "../../src/vault/base64";
import { VaultSeal } from "../../src/vault/seal";
import { TurtlStore } from "../../src/vault/turtl-store";
import { initZim } from "../../src/zim";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; message: string };

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The Worker transport of the engine started last, so that a test can end it as closing the tab would. */
let lastTransport: WorkerTransport | null = null;
const query = new URLSearchParams(location.search);
const vault = new Vault({
  connect: () => (lastTransport = new WorkerTransport()),
  // (`?memory` keeps the databases in memory instead of the private file system: to tell what the file system costs)
  persistence: query.has("memory") ? null : undefined,
  // (`?silence=3000`: how long an engine that is waited for may say nothing before it is taken to be dead)
  silenceMs: query.has("silence") ? Number(query.get("silence")) : undefined,
});
/** What the vault said happened to it, in order. */
const happened: string[] = [];
vault.onChange((event) => happened.push(event.kind === "lost" ? `lost: ${event.reason}` : event.kind));
/** The changes of passphrase that unlocking settled, in order: true when it finished one, false when it undid one. */
const settledChanges: boolean[] = [];
vault.onSettled((finished) => settledChanges.push(finished));

/** Every byte the origin-private file system holds, as [path, bytes]. */
async function readOpfs(): Promise<Array<[string, Uint8Array]>> {
  const found: Array<[string, Uint8Array]> = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
      else found.push([`${prefix}${name}`, new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer())]);
    }
  };
  await walk(await navigator.storage.getDirectory(), "");
  return found;
}

/** The text of a file's bytes, one character to a byte (what a search for ASCII text needs, whatever else the bytes are). */
const asLatin1 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
};
/** How many times the engine's Worker has said anything since `listen`. */
let heard = 0;
const store = new TurtlStore(() => vault.core, pageKey);

const page = (name: string, text: string): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1 });
const file = (path: string, text: string, type: string): StoredFile => ({ path, blob: new Blob([text], { type }), modified: 2 });

const sealer = new VaultSeal(() => vault.core);
const textBytes = (text: string) => new TextEncoder().encode(text);

const lab = {
  /** Sealed copies (src/vault/seal.ts): what a page hands a test is base64. */
  sealStatus: () => attempt(() => sealer.hasKey()),
  sealCreate: (passphrase: string) => attempt(async () => bytesToBase64(await sealer.createKey(passphrase))),
  sealWrap: (passphrase: string) => attempt(async () => bytesToBase64(await sealer.wrapKey(passphrase))),
  sealTake: (wrapped: string, passphrase: string) => attempt(() => sealer.takeKey(base64ToBytes(wrapped), passphrase)),
  sealFiles: (notebook: string, files: Array<{ path: string; text: string }>) =>
    attempt(async () => (await sealer.seal(notebook, files.map((f) => ({ path: f.path, bytes: textBytes(f.text) })))).map((o) => ({ ...o, sealed: bytesToBase64(o.sealed) }))),
  openObjects: (notebook: string, objects: Array<{ name: string; sealed: string }>) =>
    attempt(async () => (await sealer.open(notebook, objects.map((o) => ({ name: o.name, sealed: base64ToBytes(o.sealed) })))).map((o) => ({ name: o.name, text: new TextDecoder().decode(o.bytes) }))),
  sealIndex: (notebook: string, index: { counter: number; title: string; files: Array<{ path: string; name: string; size: number; sha256: string }> }) => attempt(async () => bytesToBase64(await sealer.sealIndex(notebook, index))),
  openIndex: (notebook: string, sealed: string) => attempt(() => sealer.openIndex(notebook, base64ToBytes(sealed))),
  /** Count what the engine's Worker says to the page (its heartbeat included) from now on. */
  listen: () => {
    const transport = lastTransport;
    if (!transport) return false;
    const before = transport.onHeard;
    heard = 0;
    transport.onHeard = () => {
      heard++;
      before?.();
    };
    return true;
  },
  heard: () => heard,
  /** End the engine's Worker without a word, as a browser short of memory does: nothing is sent and nothing is thrown. */
  killSilently: () => {
    (lastTransport as unknown as { worker: Worker | null }).worker?.terminate();
  },
  happened: () => [...happened],
  settled: () => [...settledChanges],
  changePassphrase: (current: string, next: string) => attempt(() => vault.changePassphrase(current, next)),
  /** A backup of the vault, as base64 (what a page can hand to a test). */
  exportBackup: () => attempt(async () => bytesToBase64(new Uint8Array(await (await vault.exportBackup()).arrayBuffer()))),
  restoreBackup: (backup: string) => attempt(() => vault.restoreBackup(new Blob([base64ToBytes(backup) as BlobPart]))),
  /** Start restoring a backup, end the engine `after` ms later as a closed tab would, and say how it ended. */
  restoreBackupAndCrash: (backup: string, after: number) =>
    attempt(async () => {
      const restoring = vault.restoreBackup(new Blob([base64ToBytes(backup) as BlobPart]));
      setTimeout(() => lastTransport?.kill("the tab was closed"), after);
      return restoring.then(() => "finished", (error: Error) => `stopped: ${error.message}`);
    }),
  /** Start changing the passphrase, end the engine `after` ms later as a closed tab would, and say how it ended. */
  changePassphraseAndCrash: (current: string, next: string, after: number) =>
    attempt(async () => {
      const changing = vault.changePassphrase(current, next);
      setTimeout(() => lastTransport?.kill("the tab was closed"), after);
      return changing.then(() => "finished", (error: Error) => `stopped: ${error.message}`);
    }),
  /**
   * How many of the things the browser keeps are sealed with the key that `passphrase` makes for the account `name`, and how
   * many such things there are: found the way a thief with the files and a guess would, by trying every sealed thing in every file
   * (the live ones and any copy a database left behind in a page it freed) with the key. The vault has to be locked.
   */
  sealedWith: (name: string, passphrase: string) =>
    attempt(async () => {
      await sodium.ready;
      // (the key as the core makes it: scrypt at what a vault is made at, with a salt that is made from the account's name)
      const salt = sodium.crypto_hash_sha512(sodium.from_string(`v0/${name}`)).slice(0, sodium.crypto_pwhash_scryptsalsa208sha256_SALTBYTES);
      const key = sodium.crypto_pwhash_scryptsalsa208sha256(32, sodium.from_string(passphrase), salt, 4194304, 134217728);
      let found = 0;
      let opened = 0;
      const where: string[] = [];
      const tried = new Set<string>();
      for (const [path, bytes] of await readOpfs()) {
        const text = asLatin1(bytes);
        // a sealed thing is a header (version 6, one byte of description, 12 bytes of nonce) and the ciphertext: written in base64 in the rows, in hex in the account's auth
        const candidates: Array<[Uint8Array, string]> = [];
        for (const match of text.matchAll(/AAYBAA[wxyz][A-Za-z0-9+/]{16,}={0,2}/g)) {
          if (tried.has(match[0])) continue;
          tried.add(match[0]);
          try {
            candidates.push([sodium.from_base64(match[0], sodium.base64_variants.ORIGINAL), `${path}: ${text.slice(Math.max(0, (match.index ?? 0) - 12), match.index)}…`]);
          } catch {
            // not a whole sealed thing (the text it was found in goes on, or it is not base64 after all)
          }
        }
        for (const match of text.matchAll(/000601000c[0-9a-f]{40,}/g)) {
          if (tried.has(match[0])) continue;
          tried.add(match[0]);
          try {
            candidates.push([sodium.from_hex(match[0]), `${path}: ${text.slice(Math.max(0, (match.index ?? 0) - 12), match.index)}…`]);
          } catch {
            // not a whole sealed thing (an odd number of digits: it was cut)
          }
        }
        for (const [sealed, context] of candidates) {
          // version(2) description-length(1) description(1) nonce-length(1) nonce(12) ciphertext
          if (sealed.length < 17 + 16 || sealed[2] !== 1 || sealed[4] !== 12) continue;
          found++;
          try {
            sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, sealed.subarray(17), sealed.subarray(0, 17), sealed.subarray(5, 17), key);
            opened++;
            where.push(`opened ${sealed.length}: ${context.replace(/[^\x20-\x7e]/g, ".")}`);
          } catch {
            // sealed with another key
            where.push(`not ${sealed.length}: ${context.replace(/[^\x20-\x7e]/g, ".")}`);
          }
        }
      }
      return { found, opened, where };
    }),
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
  /** Any command of the core, for a test that needs one the lab has no name for. */
  core: (command: string, ...args: unknown[]) => attempt(() => vault.core.request(command, ...args)),
  /** How long each of `count` writes of a note takes (ms), made inside one batch of the core. */
  timeWrites: (count: number) =>
    attempt(async () => {
      const space = (await vault.core.request<{ id: string }>("profile:sync:model", "add", "space", { user_id: "0", title: "timing", color: "#000000" })).id;
      const times: number[] = [];
      await vault.core.request("profile:batch:begin");
      for (let i = 0; i < count; i++) {
        const started = performance.now();
        await vault.core.request("profile:sync:model", "add", "note", { space_id: space, user_id: "0", type: "zim-page", title: `Timing ${i}`, text: "lorem ipsum dolor sit amet ".repeat(40) + i });
        times.push(performance.now() - started);
      }
      const committing = performance.now();
      await vault.core.request("profile:batch:commit");
      return { times, commit: performance.now() - committing };
    }),
  /** The notebooks, as plain data. */
  notebooks: {
    list: () => attempt(() => store.listNotebooks()),
    create: (title: string, pages: Array<[string, string]>, files: Array<[string, string, string]>) =>
      attempt(() => store.createNotebook({ title, home: "Home", kind: "encrypted" }, pages.map(([name, text]) => page(name, text)), files.map(([path, text, type]) => file(path, text, type)))),
    pages: (id: string) => attempt(async () => (await store.loadPages(id)).map((p) => [p.name, p.text, p.bom, p.lineEnding, p.modified])),
    files: (id: string) => attempt(async () => await Promise.all((await store.listFiles(id)).map(async (f) => [f.path, f.type, f.size, f.modified, await (await store.loadFile(id, f.path))?.text()]))),
    /** Replace pages by name (text) and files by path: what a test needs of `replacePages`. */
    replace: (id: string, remove: string[], put: Array<[string, string]>, files?: { move?: Array<[string, string]>; remove?: string[]; put?: Array<[string, string, string]> }) =>
      attempt(() => {
        const change: PageChange = { remove, put: put.map(([name, text]) => page(name, text)) };
        if (files) change.files = { move: files.move, remove: files.remove, put: files.put?.map(([path, text, type]) => file(path, text, type)) };
        return store.replacePages(id, change);
      }),
    /** Start writing `count` pages (so that it takes a while), end the engine `after` ms later as a closed tab would, and say how it ended. */
    writeAndCrash: (id: string, count: number, after: number) =>
      attempt(async () => {
        const writing = store.replacePages(id, { remove: [], put: Array.from({ length: count }, (_, i) => page(`Crash ${i}`, `written ${i}`)) });
        setTimeout(() => lastTransport?.kill("the tab was closed"), after);
        return writing.then(() => "finished", (error: Error) => `stopped: ${error.message}`);
      }),
  },
  /** Run the real network cut-off in a Worker of its own (probe-worker.ts), and report what that Worker can do before it and after. */
  probeCutOff: (url: string) =>
    attempt(
      () =>
        new Promise<{ before: string; after: Record<string, string>; restored: string[]; stillRefused: boolean }>((resolve, reject) => {
          const worker = new Worker(new URL("./probe-worker.ts", import.meta.url), { type: "module" });
          // (a probe that says nothing is a failure to report, not a test to wait for for ever)
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("the probe said nothing for 15 seconds"));
          }, 15_000);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message));
          };
          worker.postMessage({ url });
        }),
    ),
  errors: { VaultBusyError: VaultBusyError.name, VaultExistsError: VaultExistsError.name, WrongPassphraseError: WrongPassphraseError.name, NoVaultError: NoVaultError.name, NotABackupError: NotABackupError.name },
  /** Every byte the origin-private file system holds, as [path, bytes]; the vault has to be locked (nothing may hold its files). */
  opfsFiles: () => attempt(async () => (await readOpfs()).map(([path, bytes]): [string, number[]] => [path, [...bytes]])),
};

declare global {
  interface Window {
    lab: typeof lab;
  }
}
// (the notebook rules are wasm too: the page is ready when they are loaded)
await initZim();
window.lab = lab;
