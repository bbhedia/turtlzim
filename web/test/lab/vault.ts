// A page that puts the vault in reach of the browser tests, which call `lab` from outside: they
// can't pass functions or classes across, so each call answers with plain data.
import { pageKey } from "../../src/notebook-core";
import type { PageChange, StoredFile, StoredPage } from "../../src/notebook/store";
import { Vault, VaultBusyError, WrongPassphraseError, NoVaultError, WorkerTransport, vaultSupport } from "../../src/vault";
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
/** How many times the engine's Worker has said anything since `listen`. */
let heard = 0;
const store = new TurtlStore(() => vault.core, pageKey);

const page = (name: string, text: string): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1 });
const file = (path: string, text: string, type: string): StoredFile => ({ path, blob: new Blob([text], { type }), modified: 2 });

const lab = {
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
// (the notebook rules are wasm too: the page is ready when they are loaded)
await initZim();
window.lab = lab;
