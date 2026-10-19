// Keeping notebooks away from this device, as the person sees it: the menu's lines, the questions, and when a notebook is sent or fetched. Where a copy is kept is a `Remote`: the
// account's own space on the server (1 MB), or a folder of a service that was connected (Nextcloud and the like, which the server reaches for the person). What is decided is in sync.ts;
// the app gives this what it has of the open notebook (`SyncHost`). A notebook that is not encrypted is sent as it is, and the dialog says so. An encrypted one is sent **sealed**: every page is
// sealed here (sealed-remote.ts, the engine's keys) before it leaves, and what the place that keeps it holds are objects that it can't read. The link of an encrypted notebook, which names its
// pages, is kept in the vault with the notebook and nowhere else; the key for sealed copies is in the vault, and, wrapped by the vault's passphrase, in the account.
import { showDialog } from "../app/dialogs";
import { h } from "../app/dom";
import type { NotebookInfo, NotebookStore } from "../notebook/store";
import { isEncryptedId } from "../notebook/routed-store";
import { pathToPage } from "../notebook-core";
import { pagesFromFiles } from "../notebook/zim-files";
import type { ImportedFile } from "../notebook/zim-files";
import { CoreError } from "../vault/core-client";
import { base64ToBytes, bytesToBase64 } from "../vault/base64";
import type { KeyStatus, VaultSeal } from "../vault/seal";
import type { ZipEntry } from "../zip";
import { ApiError } from "./client";
import type { Connection } from "./client";
import type { Manifest, Remote, Version } from "./remote";
import { SEALED_ID } from "./sealed";
import { SEALED_PREFIX, SealedCopyError, SealedRemote } from "./sealed-remote";
import { baseOf, conflictCopyPath, digestOf, fileDigests, folderNameFor, fromWire, newRemoteId, planMerge, toWire } from "./sync";
import type { Link } from "./sync";
import type { AccountUi } from "./ui";

export interface SyncHost {
  say(text: string): void;
  /** The notebook that is open. */
  notebook(): Pick<NotebookInfo, "id" | "title" | "home" | "kind"> | null;
  /** Its files, as they would be exported. */
  files(): Promise<ZipEntry[]>;
  /** Write what is typed. */
  flush(): Promise<void>;
  /** Whether there is typing that is not saved yet. */
  unsaved(): boolean;
  /** Show a notebook (again, from the store). */
  open(id: string): Promise<void>;
  store: NotebookStore;
  /** The vault's engine, for the keys of sealed copies; null while the encrypted notebooks are locked. */
  seal(): VaultSeal | null;
  /** An encrypted notebook's link is kept in the vault, with the notebook. */
  readVaultLink(id: string): Promise<string | null>;
  writeVaultLink(id: string, text: string | null): Promise<void>;
  /** Get the vault unlocked (or made) for what is about to be done in it: null if it is, else what to tell the person. */
  prepareVault(): Promise<string | null>;
}

export interface LinkStorage {
  get(id: string): string | null;
  set(id: string, value: string): void;
  remove(id: string): void;
}

/** How long after the last change a linked notebook is sent. */
export const AUTO_SEND_MS = 6000;

/** Where a kept notebook stands with its other copy: up to date, changes waiting to be sent, being synced, two sides that changed the same page, a problem, or no network. */
export type SyncState = "ok" | "pending" | "sending" | "conflict" | "error" | "offline";

/** What the interface says of a notebook that is kept elsewhere. */
export interface SyncStatus {
  /** In words: “server”, or the name of the connected service. */
  place: string;
  /** Not known until the notebook has been synced in this session. */
  state?: SyncState;
}

/** The notebooks that can be kept elsewhere: ones that are not encrypted, as they are, and encrypted ones, sealed. (A folder of Zim files on the computer is its own copy.) */
const kept = (kind: NotebookInfo["kind"]): boolean => kind === "open" || kind === "encrypted";

/** The SHA-256 of a wrapped key, in hex, as the account's server names a key: what a replacement or a deletion says it saw. */
async function sumOfKey(wrapped: string): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", base64ToBytes(wrapped) as BufferSource));
  return [...sum].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What is said where the sealed copies were deleted and the question was only about opening one. */
const NOTHING_LEFT = "The sealed copies of this account were deleted, so there is nothing to open.";

/** A connection as the person is shown it: “Dropbox”, or “GitLab project: My notes”. */
const nameOf = (c: Connection): string => (c.label === c.service ? c.service : `${c.service}: ${c.label}`);

/** The notebook's slug for a service's folder is made in sync.ts; this is the choice a person is given. */
const ACCOUNT = "account";

export class SyncUi {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: number | undefined;
  /** Notebooks whose two copies both changed and have not been settled: not touched again until the person chooses. */
  private readonly held = new Set<string>();
  private connections: Connection[] = [];
  /** What is known of each linked notebook's state (only what happened in this session). */
  private readonly states = new Map<string, SyncState>();
  /** Told when a notebook's state changed or a link was made or ended, so that the screen can say so. */
  onStatus: (() => void) | null = null;
  /** The links of the encrypted notebooks, as read from the vault when it was unlocked (and forgotten when it is locked): nothing about them is kept anywhere else. */
  private readonly vaultLinks = new Map<string, string>();
  /** Writing a link into the vault, one at a time. */
  private persisting: Promise<void> = Promise.resolve();
  /** The links of the vault have been read. */
  private linksReady: Promise<void> = Promise.resolve();
  /** Whether the vault has a key for sealed copies (as last asked: for the menu, which can't wait). */
  private keyStatus: KeyStatus | null = null;

  constructor(
    private readonly host: SyncHost,
    private readonly account: AccountUi,
    private readonly links: LinkStorage,
  ) {}

  linkOf(id: string): Link | null {
    const email = this.account.account?.email;
    if (!email) return null;
    try {
      const link = JSON.parse((isEncryptedId(id) ? this.vaultLinks.get(id) : this.links.get(id)) ?? "null") as Link | null;
      return link && link.account === email && typeof link.remoteId === "string" ? link : null;
    } catch {
      return null;
    }
  }

  private saveLink(id: string, link: Link): void {
    const text = JSON.stringify(link);
    if (isEncryptedId(id)) {
      // (a sync that was under way when the vault was locked does not put back what the lock took away)
      if (!this.host.seal()) return;
      this.vaultLinks.set(id, text);
      this.persist(id, text);
    } else this.links.set(id, text);
    this.onStatus?.();
  }

  /** Forget a link (the notebook is no longer kept elsewhere). */
  private dropLink(id: string): void {
    if (isEncryptedId(id)) {
      this.vaultLinks.delete(id);
      this.persist(id, null);
    } else this.links.remove(id);
    this.onStatus?.();
  }

  /** Write an encrypted notebook's link into the vault, in order, and say if it can't be. */
  private persist(id: string, text: string | null): void {
    this.persisting = this.persisting
      .then(() => (this.host.seal() ? this.host.writeVaultLink(id, text) : undefined))
      .catch((error: unknown) => this.host.say(`Couldn't remember where an encrypted notebook is kept: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Say something about a notebook; an encrypted one is not named once the vault is locked (what is on the screen after a lock names nothing, whatever was still under way). */
  private tell(id: string, text: string): void {
    if (isEncryptedId(id) && !this.host.seal()) return;
    this.host.say(text);
  }

  private setState(id: string, state: SyncState | null): void {
    // (once the vault is locked, nothing of an encrypted notebook is held: not even what state it was in)
    if (isEncryptedId(id) && !this.host.seal()) {
      this.states.delete(id);
      return;
    }
    if (state === null) this.states.delete(id);
    else this.states.set(id, state);
    this.onStatus?.();
  }

  /** The vault was unlocked: read the links of its notebooks (they are kept in it), and whether it has a key for sealed copies. */
  loadVaultLinks(): Promise<void> {
    this.linksReady = (async () => {
      this.vaultLinks.clear();
      try {
        for (const n of (await this.host.store.listNotebooks()).filter((n) => n.kind === "encrypted")) {
          const text = await this.host.readVaultLink(n.id);
          if (text) this.vaultLinks.set(n.id, text);
        }
        this.keyStatus = (await this.host.seal()?.status()) ?? null;
      } catch {
        // (a vault that can't be read now has no links to show; the notebooks are as they were)
      }
      this.onStatus?.();
    })();
    return this.linksReady;
  }

  /** The vault was locked: nothing of its notebooks is held any more, and nothing is sent. */
  dropVaultLinks(): void {
    window.clearTimeout(this.timer);
    this.vaultLinks.clear();
    this.keyStatus = null;
    for (const id of [...this.states.keys()]) if (isEncryptedId(id)) this.states.delete(id);
    this.onStatus?.();
  }

  /** Whether a notebook is kept on a server or a service by any account (there is a link for it): for what is said when a page is moved into or out of it. */
  keptAnywhere(id: string): boolean {
    return (isEncryptedId(id) ? this.vaultLinks.get(id) : this.links.get(id)) != null;
  }

  /** What to say of a notebook: null if it is only on this device. */
  statusOf(id: string): SyncStatus | null {
    const link = this.linkOf(id);
    if (!link) return null;
    const place = link.target ? (this.connections.find((c) => c.id === link.target?.connectorId)?.label ?? "service") : "server";
    const state = this.states.get(id);
    return state ? { place, state } : { place };
  }

  /** The services that were connected, as last known (they are asked for when a dialog needs them). */
  async whereOptions(): Promise<Array<{ value: string; label: string }>> {
    const account = this.account.account;
    if (!account) return [];
    await this.loadConnections();
    return [{ value: ACCOUNT, label: `On the server: this account's space (${Math.floor(account.quotaBytes / 1024)} KB)` }, ...this.connections.map((c) => ({ value: String(c.id), label: `On ${nameOf(c)}` }))];
  }

  private remoteFor(link: Link): Remote {
    const base = this.objectsFor(link);
    if (!link.sealed) return base;
    const seal = this.host.seal();
    if (!seal) throw new Error("The encrypted notebooks are locked.");
    return new SealedRemote(base, seal, link.remoteId, link.counter ?? 0, () => this.host.notebook()?.title ?? "");
  }

  /** The place that keeps what a notebook's copy is made of: the account's own space, or a folder of a connected service. */
  private objectsFor(link: Link): Remote {
    const client = this.account.client;
    const target = link.target;
    if (!target) {
      return {
        place: "the server",
        manifest: async () => {
          try {
            const m = await client.getManifest(link.remoteId);
            return { version: m.revision, marks: Object.fromEntries(m.files.map((f) => [f.path, f.mark])) };
          } catch (error) {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          }
        },
        read: async (paths) => {
          const copy = paths ? await client.readNotebookFiles(link.remoteId, paths) : await client.getNotebook(link.remoteId);
          return { title: copy.title, files: copy.files, version: copy.revision };
        },
        write: async (title, put, remove, base) =>
          base === 0
            ? { version: (await client.putNotebook(link.remoteId, { title, baseRevision: 0, files: toWire(put) })).revision }
            : { version: (await client.patchNotebook(link.remoteId, { title, baseRevision: Number(base), put: toWire(put), remove })).revision },
        remove: async () => void (await client.deleteNotebook(link.remoteId)),
      };
    }
    const name = this.connections.find((c) => c.id === target.connectorId)?.label ?? "the connected service";
    return {
      place: name,
      manifest: async () => {
        const listed = await client.connectorList(target.connectorId, target.dir);
        return listed.version === "" ? null : { version: listed.version, marks: Object.fromEntries(listed.files.map((f) => [f.path, f.mark])) };
      },
      read: async (paths) => {
        const copy = await client.connectorRead(target.connectorId, target.dir, paths);
        return { files: copy.files, version: copy.version };
      },
      write: async (_title, put, remove, base) => ({ version: (await client.connectorWrite(target.connectorId, target.dir, { baseVersion: String(base), put: toWire(put), remove })).version }),
      remove: async () => {
        const listed = await client.connectorList(target.connectorId, target.dir);
        await client.connectorWrite(target.connectorId, target.dir, { baseVersion: listed.version, put: [], remove: listed.files.map((f) => f.path) });
      },
    };
  }

  /** The lines of the menu for this notebook, when someone is signed in. */
  menu(): Array<{ label: string; run: () => void }> {
    const notebook = this.host.notebook();
    if (!this.account.account || !notebook) return [];
    const lines: Array<{ label: string; run: () => void }> = [];
    if (kept(notebook.kind)) {
      if (this.linkOf(notebook.id)) {
        lines.push({ label: "Sync this notebook now", run: () => void this.syncNow(false) }, { label: "Stop keeping this notebook on the server…", run: () => void this.stopDialog() });
      } else lines.push({ label: "Keep this notebook on the server…", run: () => void this.keepDialog() });
    }
    lines.push({ label: "Open a notebook from the server…", run: () => void this.fetchDialog() }, { label: "Connected services…", run: () => void this.servicesDialog() });
    // (the key for sealed copies is wrapped by the vault's passphrase wherever the account keeps it: when that is changed it has to be wrapped again)
    if (this.keyStatus?.has) lines.push({ label: "Update the passphrase of the sealed copies…", run: () => void this.rewrapDialog() });
    return lines;
  }

  /** Called when the open notebook was saved: a linked one is sent soon, once typing has paused. */
  changed(): void {
    const notebook = this.host.notebook();
    window.clearTimeout(this.timer);
    if (!notebook || !kept(notebook.kind) || !this.linkOf(notebook.id) || this.held.has(notebook.id)) return;
    if (this.states.get(notebook.id) !== "pending" && this.states.get(notebook.id) !== "sending") this.setState(notebook.id, "pending");
    this.timer = window.setTimeout(() => void this.syncNow(true), AUTO_SEND_MS);
  }

  /** At the start, and when the account becomes known: bring the open notebook up to date, if it is linked. */
  async catchUp(): Promise<void> {
    await this.linksReady;
    const notebook = this.host.notebook();
    if (notebook && kept(notebook.kind) && this.linkOf(notebook.id)) {
      await this.loadConnections();
      await this.syncNow(true);
    }
  }

  private async loadConnections(): Promise<void> {
    try {
      this.connections = (await this.account.client.listConnectors()).connectors;
    } catch {
      // (the names of services are only for what is said: a copy on the account's own space does not need them)
    }
  }

  // ---------------------------------------------------------------------------------------------- keeping

  private async keepDialog(): Promise<void> {
    const notebook = this.host.notebook();
    const account = this.account.account;
    if (!notebook || !account || !kept(notebook.kind)) return;
    const where = await this.whereOptions();
    const sealed = notebook.kind === "encrypted";
    await showDialog({
      title: "Keep this notebook on the server",
      body: sealed
        ? [
            `A sealed copy of “${notebook.title}” is kept, so that you can open it from another device. Its pages are encrypted here, before they are sent, with a key that only your passphrase opens: whoever keeps the copy (the server, or the service you choose) holds objects that it cannot read, and sees only that they exist, how big they are and when they change. It is sent each time you stop typing, and fetched when the copy is newer.`,
            "To open it on another device you need this account and the passphrase of your encrypted notebooks. Nobody can recover that passphrase for you.",
          ]
        : [
            `A copy of “${notebook.title}” is kept, so that you can open it from another device. It is sent each time you stop typing, and fetched when the copy is newer.`,
            "The copy is stored as it is, not encrypted: anyone who runs the server, or who has access to the service you choose, can read it. (A notebook that you encrypt is kept sealed instead.)",
          ],
      choices: [{ name: "where", label: "Where", value: ACCOUNT, options: where.map((w) => ({ ...w, label: w.label.replace(/^On the server: /, "").replace(/^On /, "") })) }],
      confirm: "Keep it there",
      working: "Sending…",
      submit: async (values) => this.keepIn(String(values.where)),
    });
  }

  /**
   * Send the open notebook for the first time, to the account's space (`ACCOUNT`) or to a connected service (its id): from then on it is kept in step. Gives the message to show if it
   * can't be done. (While it is sent the notebook is both here and there: that is the one moment a notebook is in two places, and it ends with the first send.) An encrypted notebook is
   * sent sealed, which needs the key for sealed copies: the account's, wrapped by the passphrase (asked for once, here).
   */
  async keepIn(where: string): Promise<string | void> {
    const notebook = this.host.notebook();
    const account = this.account.account;
    if (!notebook || !account || !kept(notebook.kind)) return "This notebook can't be kept on a server.";
    const sealed = notebook.kind === "encrypted";
    try {
      if (sealed) {
        const problem = await this.ensureSealKey();
        if (problem) return problem;
      }
      await this.host.flush();
      const files = await this.host.files();
      const digest = await digestOf(files);
      // (a sealed notebook is called by an id that says it is one and nothing else, also as the folder of a service: its name is in the sealed index only)
      const remoteId = sealed ? `${SEALED_PREFIX}${newRemoteId()}` : where === ACCOUNT ? newRemoteId() : folderNameFor(notebook.title);
      const first: Link = where === ACCOUNT
        ? { remoteId, revision: 0, digest, account: account.email }
        : { remoteId, target: { kind: "connector", connectorId: Number(where), dir: remoteId }, revision: "", digest, account: account.email };
      if (sealed) first.sealed = true;
      const remote = this.remoteFor(first);
      await remote.write(notebook.title, files, [], first.revision);
      const made = await remote.manifest();
      this.saveLink(notebook.id, { ...first, revision: made?.version ?? first.revision, files: await fileDigests(files), marks: made?.marks ?? {}, ...(remote.counter !== undefined ? { counter: remote.counter } : {}) });
      this.setState(notebook.id, "ok");
    } catch (error) {
      return this.explain(error);
    }
    this.tell(notebook.id, `“${notebook.title}” is kept ${where === ACCOUNT ? "on the server" : `on ${this.connections.find((c) => String(c.id) === where)?.label ?? "the service"}`}${sealed ? ", sealed" : ""}.`);
  }

  private async stopDialog(): Promise<void> {
    const notebook = this.host.notebook();
    if (!notebook) return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    await this.loadConnections();
    let remote: Remote;
    try {
      remote = this.remoteFor(link);
    } catch (error) {
      this.host.say(this.explain(error));
      return;
    }
    await showDialog({
      title: "Stop keeping this notebook on the server",
      body: [`The notebook stays on this device as it is. It is no longer sent to ${remote.place}.`],
      checks: [{ name: "delete", label: link.sealed ? (link.target ? "Also delete its sealed copy on the service" : "Also delete its sealed copy on the server") : link.target ? "Also delete its files on the service" : "Also delete the copy on the server", checked: true }],
      confirm: "Stop",
      working: "Working…",
      submit: async (values) => {
        if (values.delete) {
          try {
            await remote.remove();
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) return this.explain(error);
          }
        }
        this.dropLink(notebook.id);
        this.held.delete(notebook.id);
        this.setState(notebook.id, null);
        this.host.say(values.delete ? "The copy was deleted." : `This notebook is no longer sent to ${remote.place}.`);
      },
    });
  }

  // ---------------------------------------------------------------------------------------------- syncing

  /** Make the two copies agree, where only one changed; ask where both did. `auto`: nothing is said unless something happened, and nothing is asked of the network when offline. */
  syncNow(auto: boolean): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.sync(auto).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow(true);
      }
    });
    return this.running;
  }

  /**
   * Bring the two copies together, page by page, from what each side has changed since they last agreed (`planMerge`): pages changed on one side only go to the other, pages changed on
   * both sides are asked about, and what is brought here is applied before what is sent, so that what is sent is this side as it is then. `auto`: nothing is said unless something happened,
   * and a network that is not there is not an error.
   */
  private async sync(auto: boolean): Promise<void> {
    const notebook = this.host.notebook();
    const account = this.account.account;
    if (!notebook || !account || !kept(notebook.kind)) return;
    // (an encrypted notebook is synced only while the vault is open: sealing needs its keys)
    if (isEncryptedId(notebook.id) && !this.host.seal()) return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    if (auto && this.held.has(notebook.id)) return;
    let remote: Remote;
    try {
      remote = this.remoteFor(link);
    } catch {
      return;
    }
    const id = notebook.id;
    this.setState(id, "sending");
    try {
      await this.host.flush();
      const start = await this.host.files();
      const local = await fileDigests(start);
      const whole = await digestOf(start);
      const now = await remote.manifest();
      if (!now) {
        this.dropLink(notebook.id);
        this.setState(id, null);
        this.tell(id, auto ? `“${notebook.title}” is no longer on ${remote.place}.` : `“${notebook.title}” is no longer on ${remote.place}, so it is no longer kept there. “Keep this notebook on the server…” sends it again.`);
        return;
      }
      const base = baseOf(link, local, whole, now.version, now.marks);
      let plan = planMerge(base, local, now.marks);
      const upgraded = link.files === undefined || link.marks === undefined;
      if (plan.length === 0) {
        if (upgraded || (remote.counter !== undefined && remote.counter !== link.counter)) this.saveLink(notebook.id, { ...link, revision: now.version, digest: whole, files: local, marks: now.marks, ...(remote.counter !== undefined ? { counter: remote.counter } : {}) });
        this.setState(id, "ok");
        if (!auto) this.host.say(`This notebook is up to date on ${remote.place}.`);
        return;
      }
      // (what is brought here replaces pages on the screen: not while typing that is not saved yet could be lost with them)
      if (plan.some((p) => p.action !== "push" && p.action !== "pushDelete" && p.action !== "settled") && this.host.unsaved()) {
        this.setState(id, "pending");
        return;
      }
      // the notebook's own file (its name and home page) is this device's when both sides changed it
      plan = plan.map((p) => (p.path === "notebook.zim" && p.action === "conflict" ? { path: p.path, action: local[p.path] === undefined ? ("pull" as const) : ("push" as const) } : p));

      // a page changed on both sides may have been changed the same way: only what really differs is asked about
      const identical = new Set<string>();
      // (a mark that is this side's own digest says so at once: that is how the account's space and a sealed copy mark their files)
      for (const p of plan) if (p.action === "conflict" && local[p.path] !== undefined && now.marks[p.path] === local[p.path]) identical.add(p.path);
      const maybe = plan.filter((p) => p.action === "conflict" && !identical.has(p.path) && now.marks[p.path] !== undefined).map((p) => p.path);
      const theirs = new Map<string, Uint8Array>();
      if (maybe.length) for (const f of fromWire((await remote.read(maybe)).files)) theirs.set(f.path, f.bytes as Uint8Array);
      for (const path of maybe) {
        const bytes = theirs.get(path);
        if (bytes && local[path] !== undefined && (await fileDigests([{ path, bytes }]))[path] === local[path]) identical.add(path);
      }
      const asked = plan.filter((p) => p.action === "conflict" && !identical.has(p.path)).map((p) => p.path);
      let choice: "both" | "mine" | "theirs" = "both";
      if (asked.length) {
        const answer = await this.askConflicts(notebook, remote, asked);
        if (answer === null) {
          this.held.add(notebook.id);
          this.setState(id, "conflict");
          this.host.say("Not synced: some pages changed in two places. Choose “Sync this notebook now” to settle it.");
          return;
        }
        choice = answer;
      }

      // what each side is to be told, file by file
      const push = new Set<string>();
      const pushDelete = new Set<string>();
      const pull = new Set<string>();
      const pullDelete = new Set<string>();
      const copies = new Map<string, string>();
      const taken = (path: string) => local[path] !== undefined || now.marks[path] !== undefined || [...copies.values()].includes(path);
      for (const { path, action } of plan) {
        if (action === "push") push.add(path);
        else if (action === "pushDelete") pushDelete.add(path);
        else if (action === "pull") pull.add(path);
        else if (action === "pullDelete") pullDelete.add(path);
        else if (action === "conflict" && !identical.has(path)) {
          const mine = local[path] !== undefined;
          const there = now.marks[path] !== undefined;
          if (choice === "mine") (mine ? push : pushDelete).add(path);
          else if (choice === "theirs") (there ? pull : pullDelete).add(path);
          else if (mine && there) {
            push.add(path);
            copies.set(path, conflictCopyPath(path, taken));
          } else if (there) pull.add(path);
          else push.add(path);
        }
      }
      for (const path of [...pushDelete]) if (now.marks[path] === undefined) pushDelete.delete(path); // (already gone there)

      // 1. bring here what is to be brought, and show it
      const incoming = [...pull, ...copies.keys()].filter((path) => !theirs.has(path));
      if (incoming.length) for (const f of fromWire((await remote.read(incoming)).files)) theirs.set(f.path, f.bytes as Uint8Array);
      const put: ImportedFile[] = [...pull].filter((path) => theirs.has(path)).map((path) => ({ path, bytes: theirs.get(path) }));
      for (const [path, copy] of copies) if (theirs.has(path)) put.push({ path: copy, bytes: theirs.get(path) });
      const removed = [...pullDelete].filter((path) => path !== "notebook.zim");
      if (put.length || removed.length) {
        await this.applyLocal(notebook, put, removed);
        await this.host.open(notebook.id);
      }

      // 2. send what is to be sent, as this side is now (with the copies it just made, which the other side has not got)
      const now2 = await this.host.files();
      const sentDigests = await fileDigests(now2);
      const copyPaths = new Set(put.filter((f) => [...copies.values()].includes(f.path)).map((f) => f.path));
      const toSend = now2.filter((f) => push.has(f.path) || copyPaths.has(f.path));
      const toDelete = [...pushDelete];
      let after: Manifest = now;
      const current = this.host.notebook() ?? notebook;
      if (toSend.length || toDelete.length) {
        await remote.write(current.title, toSend, toDelete, now.version);
        after = (await remote.manifest()) ?? now;
      }

      // 3. remember where the two sides agree now: what was sent as it was sent, what was brought as it is here, the rest as it was when this began (so typing since then shows as a change)
      const final = await fileDigests(await this.host.files());
      const known: Record<string, string> = { ...local };
      for (const path of push) if (sentDigests[path] !== undefined) known[path] = sentDigests[path]!;
      for (const path of copyPaths) if (sentDigests[path] !== undefined) known[path] = sentDigests[path]!;
      for (const path of pushDelete) delete known[path];
      for (const path of pull) if (final[path] !== undefined) known[path] = final[path]!;
      for (const path of pullDelete) delete known[path];
      for (const { path, action } of plan) if (action === "settled") delete known[path];
      for (const path of identical) known[path] = local[path]!;
      this.saveLink(notebook.id, { ...link, revision: after.version, digest: await digestOf(await this.host.files()), files: known, marks: after.marks, ...(remote.counter !== undefined ? { counter: remote.counter } : {}) });
      this.held.delete(notebook.id);
      this.setState(id, "ok");

      const sentCount = push.size + pushDelete.size + copyPaths.size;
      const broughtCount = pull.size + pullDelete.size + copies.size;
      const title = (this.host.notebook() ?? notebook).title;
      if (sentCount && broughtCount) this.tell(id, `“${title}” was merged with ${remote.place} (${sentCount} sent, ${broughtCount} brought here${copies.size ? `; ${copies.size} other ${copies.size === 1 ? "copy was" : "copies were"} kept beside the page` : ""}).`);
      else if (sentCount) this.tell(id, `“${title}” was sent to ${remote.place}.`);
      else if (broughtCount) this.tell(id, `“${title}” was brought up to date from ${remote.place}.`);
      else if (!auto) this.tell(id, `This notebook is up to date on ${remote.place}.`);
    } catch (error) {
      // the vault was locked while this was under way: nothing of the notebook is said or kept any more (what is on the screen after a lock names nothing)
      if (isEncryptedId(id) && !this.host.seal()) {
        this.states.delete(id);
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        this.host.say(`The copy on ${remote.place} changed while this was being sent. It will be looked at again.`);
        this.setState(id, "pending");
        this.again = true;
        return;
      }
      if (error instanceof ApiError && error.code === "offline") {
        this.setState(id, "offline");
        if (auto) return;
      } else this.setState(id, "error");
      this.tell(id, `Couldn't sync “${notebook.title}”: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // (what was learnt of an encrypted notebook's link is in the vault before this is over)
      await this.persisting;
    }
  }

  /** Put what was brought into this device's copy of the notebook: pages written or deleted, files written or deleted, and its name and home page where the other side changed them. */
  private async applyLocal(notebook: Pick<NotebookInfo, "id" | "title" | "home">, put: ImportedFile[], removePaths: string[]): Promise<void> {
    const empty = new Uint8Array();
    const hasConfig = put.some((f) => f.path === "notebook.zim");
    // (a notebook file in the list makes the folder's top the notebook's top, whichever files are in it: the importer reads the paths relative to it)
    const incoming = pagesFromFiles([...(hasConfig ? [] : [{ path: "notebook.zim", bytes: empty }]), ...put]);
    const gone = pagesFromFiles([{ path: "notebook.zim", bytes: empty }, ...removePaths.map((path) => ({ path, bytes: empty }))]);
    const store = this.host.store;
    await store.replacePages(notebook.id, { remove: gone.pages.map((p) => p.name), put: incoming.pages, files: { remove: gone.files.map((f) => f.path), put: incoming.files } });
    if (hasConfig && (incoming.config.name || incoming.config.home)) {
      const info = (await store.listNotebooks()).find((n) => n.id === notebook.id);
      if (info) {
        const pages = new Set((await store.loadPages(notebook.id)).map((p) => p.name.toLowerCase()));
        const home = incoming.config.home && pages.has(incoming.config.home.toLowerCase()) ? incoming.config.home : info.home;
        await store.updateNotebook({ ...info, title: incoming.config.name || info.title, home });
      }
    }
  }

  /** Pages that were changed on both sides: what to do with them, or null if the person would rather decide later. */
  private async askConflicts(notebook: Pick<NotebookInfo, "title">, remote: Remote, paths: string[]): Promise<"both" | "mine" | "theirs" | null> {
    const nameOf = (path: string): string => {
      try {
        return path.endsWith(".txt") ? pathToPage(path) : path;
      } catch {
        return path;
      }
    };
    const shown = paths.slice(0, 8).map((path) => h("li", { text: nameOf(path) }));
    if (paths.length > 8) shown.push(h("li", { text: `… and ${paths.length - 8} more` }));
    let choice: "both" | "mine" | "theirs" | null = null;
    await showDialog({
      title: "Some pages changed in two places",
      body: [
        `${paths.length === 1 ? "A page" : `${paths.length} pages`} of “${notebook.title}” changed on this device and also on ${remote.place} since they last agreed. Everything else has merged by itself.`,
        h("ul", { class: "skipped" }, ...shown),
        "Keeping both keeps this device's version of each page and saves the other one next to it as “… (conflict copy)”, so that nothing is lost. Nothing is sent or replaced until you choose.",
      ],
      confirm: "Keep both",
      actions: [
        { label: "Use this device's versions", run: (close) => ((choice = "mine"), close()) },
        { label: "Use the other versions", run: (close) => ((choice = "theirs"), close()) },
      ],
      submit: () => {
        choice = "both";
      },
    });
    return choice;
  }

  // ---------------------------------------------------------------------------------------------- fetching another

  private async fetchDialog(): Promise<void> {
    const client = this.account.client;
    await this.loadConnections();
    const options: Array<{ value: string; label: string }> = [];
    const known = new Set<string>();
    for (const n of await this.host.store.listNotebooks()) {
      const link = this.linkOf(n.id);
      if (link) known.add(link.target ? `c:${link.target.connectorId}:${link.target.dir}` : `a:${link.remoteId}`);
    }
    try {
      for (const n of (await client.listNotebooks()).notebooks) {
        // (the sealed copy of the encrypted notebooks is not a notebook that can be opened: it is restored by its own line of the menu)
        const size = `${Math.max(1, Math.round((n.bytes ?? 0) / 1024))} KB`;
        if (n.id !== SEALED_ID && !known.has(`a:${n.id}`)) options.push({ value: `a:${n.id}`, label: n.id.startsWith(SEALED_PREFIX) ? `Encrypted notebook, sealed (the server, ${size})` : `${n.title} (the server, ${size})` });
      }
      for (const c of this.connections) {
        try {
          for (const dir of (await client.connectorFolders(c.id)).folders) if (!known.has(`c:${c.id}:${dir}`)) options.push({ value: `c:${c.id}:${dir}`, label: dir.startsWith(SEALED_PREFIX) ? `Encrypted notebook, sealed (${c.label})` : `${dir} (${c.label})` });
        } catch {
          // (a service that can't be reached is left out; the others are still offered)
        }
      }
    } catch (error) {
      this.host.say(`Couldn't ask the server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (options.length === 0) {
      await showDialog({ title: "Notebooks on the server", body: ["There is nothing to open: every notebook there is already on this device, or there is none yet. Open a notebook and choose “Keep this notebook on the server…”, or connect a service."], confirm: "Close", noCancel: true });
      return;
    }
    await showDialog({
      title: "Open a notebook from the server",
      body: ["The notebook is copied to this device and kept in step with where it came from."],
      choices: [{ name: "which", label: "Notebook", value: options[0]!.value, options }],
      confirm: "Open",
      working: "Fetching…",
      submit: async (values) => {
        const account = this.account.account;
        if (!account) return "You are signed out.";
        const [kind, first, ...rest] = String(values.which).split(":");
        try {
          const link: Link = kind === "a" ? { remoteId: String(first), revision: 0, digest: "", account: account.email } : { remoteId: rest.join(":"), target: { kind: "connector", connectorId: Number(first), dir: rest.join(":") }, revision: "", digest: "", account: account.email };
          // (what is sealed is opened with the vault's keys: the vault first, then the key, then the pages)
          if (link.remoteId.startsWith(SEALED_PREFIX)) return await this.openSealed({ ...link, sealed: true });
          const remote = this.remoteFor(link);
          const listed = await remote.manifest();
          if (!listed) return "That notebook is not there any more.";
          const copy = await remote.read();
          const imported = pagesFromFiles(fromWire(copy.files));
          if (imported.pages.length === 0) return "That copy has no pages.";
          const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
          const home = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
          const title = copy.title ?? imported.config.name ?? link.remoteId;
          const info = await this.host.store.createNotebook({ title, home, kind: "open" }, imported.pages, imported.files);
          await this.host.open(info.id);
          const local = await this.host.files();
          this.saveLink(info.id, { ...link, revision: listed.version, digest: await digestOf(local), files: await fileDigests(local), marks: listed.marks });
          this.setState(info.id, "ok");
          this.host.say(`“${title}” was copied from ${remote.place}.`);
        } catch (error) {
          return this.explain(error);
        }
      },
    });
  }

  /**
   * Copy a sealed notebook to this device, as an encrypted notebook of its vault: the vault is unlocked (or made) first, then the account's key is taken from the account with the passphrase
   * that sealed it (asked for once, here), and then the pages are opened and put in the vault. Gives the message to show if it can't be done.
   */
  private async openSealed(first: Link): Promise<string | void> {
    const account = this.account.account;
    if (!account) return "You are signed out.";
    const locked = await this.host.prepareVault();
    if (locked) return locked;
    await this.loadVaultLinks();
    // (a sealed notebook that is on this device already is not copied a second time: the list could not say so while the vault was locked)
    for (const [id, text] of this.vaultLinks) {
      try {
        const there = JSON.parse(text) as Link;
        if (there.remoteId === first.remoteId && !!there.target === !!first.target && there.target?.connectorId === first.target?.connectorId) return "That notebook is on this device already: open it from the list of notebooks.";
      } catch {
        // (a link that can't be read is no link)
      }
      void id;
    }
    const problem = await this.ensureSealKey({ create: false });
    if (problem) return problem;
    const link: Link = { ...first, sealed: true };
    const remote = this.remoteFor(link);
    const listed = await remote.manifest();
    if (!listed) return "That notebook is not there any more.";
    const copy = await remote.read();
    const imported = pagesFromFiles(fromWire(copy.files));
    if (imported.pages.length === 0) return "That copy has no pages.";
    const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
    const home = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
    const title = copy.title || imported.config.name || "Encrypted notebook";
    const info = await this.host.store.createNotebook({ title, home, kind: "encrypted" }, imported.pages, imported.files);
    await this.host.open(info.id);
    const local = await this.host.files();
    this.saveLink(info.id, { ...link, revision: listed.version, digest: await digestOf(local), files: await fileDigests(local), marks: listed.marks, ...(remote.counter !== undefined ? { counter: remote.counter } : {}) });
    this.setState(info.id, "ok");
    this.tell(info.id, `“${title}” was copied from ${remote.place}, sealed.`);
  }

  // ---------------------------------------------------------------------------------------------- the key for sealed copies

  /** What a refused passphrase says, whichever way the engine says it. */
  private passphraseProblem(error: unknown, sealing: boolean): string {
    if (error instanceof CoreError && error.subtype === "Unauthorized") return "That is not the passphrase of the encrypted notebooks.";
    if (error instanceof CoreError && /authentication|wrong passphrase|wrapped key/i.test(error.message)) return sealing ? "That passphrase does not open the key: it is not the one that sealed it." : "That is not the passphrase of the encrypted notebooks.";
    return this.explain(error);
  }

  /**
   * Make sure that this vault and this account have the same key for sealed copies, so that what is sealed here can be opened elsewhere. Where there is none, one is made and kept (wrapped by the
   * vault's passphrase, which is asked for once, here, and checked); where the account has one and this vault has not, it is taken with the passphrase that wrapped it. Gives the message
   * to show if it can't be done.
   */
  private async ensureSealKey(options: { create?: boolean } = {}): Promise<string | void> {
    const seal = this.host.seal();
    if (!seal) return "The encrypted notebooks are locked.";
    const client = this.account.client;
    let local: KeyStatus;
    let server: { wrapped: string | null; check?: string };
    try {
      local = await seal.status();
      server = await client.getKeychain();
    } catch (error) {
      return this.explain(error);
    }
    if (local.has && server.wrapped) {
      this.keyStatus = local;
      if (server.check === local.check) return;
      // not the same key: another vault made the account's, or its copies were started over since. The person chooses how to get out of it, and then it is tried again.
      const way = await this.mismatchDialog(seal, server.wrapped);
      if (way) return way === "reset" && options.create === false ? NOTHING_LEFT : this.ensureSealKey(options);
      return "The key for sealed copies that this browser has is not the one of this account, so nothing was sent. Sealed copies of this account can't be opened with it.";
    }
    if (!server.wrapped && options.create === false) return "This account has no key for sealed copies, so no sealed notebook of it can be opened.";
    const taking = !local.has && !!server.wrapped;
    let finished = false;
    let forgot = false;
    const done = await showDialog({
      title: taking ? "Open the key for sealed copies" : "Seal your encrypted notebooks for the server",
      body: taking
        ? [
            "This account keeps sealed copies of encrypted notebooks. To open them here, this browser needs the key that seals them: type the passphrase that they were sealed with, which is the passphrase of the encrypted notebooks of the device that sent them.",
            "It is asked for once: the key is then kept in this browser's encrypted notebooks.",
            "If you forgot it, nobody can open the sealed copies: “I forgot it…” deletes them and the key, and lets you start again.",
          ]
        : [
            "A sealed copy is encrypted here, before it is sent: the server keeps pages that it cannot read. For that, your encrypted notebooks get a key for sealed copies, kept with them and, wrapped by your passphrase, in your account, so that your other devices can open the copies.",
            "Type the passphrase of your encrypted notebooks. It is the same one: there is not a second one to remember.",
            h("p", {}, h("strong", { text: "Nobody can recover it for you. " }), "If you forget it, the sealed copies are lost for good, as the encrypted notebooks are: not even the server can open them."),
          ],
      fields: [{ name: "passphrase", label: "Passphrase of the encrypted notebooks", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Type the passphrase.") }],
      confirm: taking ? "Open the key" : "Seal and continue",
      working: taking ? "Opening…" : "Sealing…",
      ...(taking ? { actions: [{ label: "I forgot it…", run: (close: () => void) => ((forgot = true), close()) }] } : {}),
      submit: async (values) => {
        const passphrase = String(values.passphrase);
        try {
          if (taking) {
            await seal.takeKey(base64ToBytes(server.wrapped as string), passphrase);
          } else if (!local.has) {
            const made = await seal.makeKey(passphrase);
            try {
              await client.putKeychain({ wrapped: bytesToBase64(made.wrapped), check: made.check, expect: "none" });
            } catch (error) {
              // another device made the account's key at the same moment: that one is the key, and this vault takes it
              const theirs = error instanceof ApiError && error.status === 409 ? (error.data as { wrapped?: string }).wrapped : undefined;
              if (!theirs) throw error;
              await seal.takeKey(base64ToBytes(theirs), passphrase);
              this.keyStatus = await seal.status();
              finished = true;
              return;
            }
            await seal.takeKey(made.wrapped, passphrase);
          } else {
            // (this vault has a key and the account has none: the vault's key is what the account keeps, wrapped)
            const wrapped = await seal.wrapKey(passphrase);
            try {
              await client.putKeychain({ wrapped: bytesToBase64(wrapped.wrapped), check: wrapped.check, expect: "none" });
            } catch (error) {
              const theirs = error instanceof ApiError && error.status === 409 ? (error.data as { check?: string }).check : undefined;
              if (theirs === undefined) throw error;
              if (theirs !== wrapped.check) return "This account got a different key for sealed copies at the same moment.";
            }
          }
          this.keyStatus = await seal.status();
          finished = true;
        } catch (error) {
          return this.passphraseProblem(error, taking);
        }
      },
    });
    if (!done && forgot && (await this.startOverDialog(server.wrapped as string))) return options.create === false ? NOTHING_LEFT : this.ensureSealKey(options);
    return done && finished ? undefined : "The passphrase was not given, so nothing was sent.";
  }

  /**
   * This browser has a key for sealed copies and the account has another. Two ways out, said in the dialog: forget this browser's key (it takes the vault's passphrase) and then take the account's
   * with the passphrase that wraps it (the usual question comes next), or start the account's sealed copies over. Says which of the two was done, if one was.
   */
  private async mismatchDialog(seal: VaultSeal, serverWrapped: string): Promise<"forgot" | "reset" | null> {
    let changed = false;
    let startOver = false;
    await showDialog({
      title: "This browser's key is not the account's",
      body: [
        "Your account keeps sealed copies made with another key than the one in this browser's encrypted notebooks: another vault made them, or the account's copies were started over since. Two ways out.",
        h("p", {}, h("strong", { text: "Use the account's key. " }), "This browser forgets its own key, then asks for the passphrase that wraps the account's. A copy that this browser sealed with its own key on a connected service can't be opened here afterwards (the notebooks are not touched: keeping them again seals them with the account's key)."),
        h("p", {}, h("strong", { text: "Or start the account's sealed copies over. " }), "The key and the sealed notebooks that the account keeps on the server are deleted, and this browser's key becomes the account's."),
      ],
      fields: [{ name: "passphrase", label: "Passphrase of the encrypted notebooks (to forget this browser's key)", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Type the passphrase.") }],
      confirm: "Forget this browser's key",
      working: "Forgetting…",
      actions: [{ label: "Start the account's copies over…", run: (close) => ((startOver = true), close()) }],
      submit: async (values) => {
        try {
          await seal.forgetKey(String(values.passphrase));
          this.keyStatus = await seal.status();
        } catch (error) {
          return this.passphraseProblem(error, false);
        }
        changed = true;
      },
    });
    if (changed) return "forgot";
    return startOver && (await this.startOverDialog(serverWrapped)) ? "reset" : null;
  }

  /**
   * Delete the key for sealed copies that the account keeps, and the sealed notebooks in its space on the server, so that a key can be made again: for a passphrase that is forgotten, or a key that
   * is not the one of this person's devices. It names the key it saw, so that a key made by another device meanwhile is not deleted unseen. Copies on a connected service are not touched. Gives true if it was done.
   */
  private async startOverDialog(serverWrapped: string): Promise<boolean> {
    const client = this.account.client;
    let count: number | null = null;
    try {
      count = (await client.listNotebooks()).notebooks.filter((n) => n.id.startsWith(SEALED_PREFIX)).length;
    } catch {
      // (the number is only for the words: the deletion itself says if the server can't be reached)
    }
    let done = false;
    await showDialog({
      title: "Start the sealed copies over",
      body: [
        `This deletes the key for sealed copies that your account keeps, and ${count === null ? "the sealed notebooks" : count === 1 ? "the sealed notebook" : `the ${count} sealed notebooks`} kept in its space on the server. Nothing on your devices is touched: the encrypted notebooks stay as they are, and can be kept again afterwards with a new key.`,
        "What a connected service holds is not deleted: its sealed folders can't be opened with a new key, and can be deleted there by hand.",
        h("p", {}, h("strong", { text: "This can't be undone. " }), "A sealed copy that is deleted here can only be made again from a device that has the notebook."),
      ],
      checks: [{ name: "understood", label: "I understand that these sealed copies will be gone from the server for good." }],
      confirm: "Delete the key and the sealed copies",
      working: "Deleting…",
      danger: true,
      submit: async (values) => {
        if (!values.understood) return "Tick the box to say you understand.";
        try {
          await client.resetKeychain(await sumOfKey(serverWrapped));
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            done = true; // (there was none any more: that is what was asked)
            return;
          }
          if (error instanceof ApiError && error.status === 409) return "Another device changed the account's key while you were deciding. Close this, and try again from the start.";
          return this.explain(error);
        }
        done = true;
      },
    });
    if (done) this.host.say("The key for sealed copies, and the sealed notebooks on the server, were deleted.");
    return done;
  }

  /** The vault's passphrase was changed: the key that the account keeps is wrapped again by the new one (what it is wrapped by is the vault's passphrase, so a new device takes it with that). */
  async rewrap(passphrase: string, explainNothing = false): Promise<string | void> {
    const seal = this.host.seal();
    if (!seal) return "The encrypted notebooks are locked.";
    if (!this.account.account) return "You are not signed in, so the key that your account keeps was not changed.";
    const client = this.account.client;
    try {
      const local = await seal.status();
      if (!local.has) return explainNothing ? "This browser has no key for sealed copies, so there is nothing to update." : undefined;
      const server = await client.getKeychain();
      if (!server.wrapped) return explainNothing ? "Your account keeps no key for sealed copies yet, so there is nothing to update." : undefined;
      if (server.check !== local.check) return "The key that this account keeps is not this browser's, so it was not changed.";
      const wrapped = await seal.wrapKey(passphrase);
      await client.putKeychain({ wrapped: bytesToBase64(wrapped.wrapped), check: wrapped.check, expect: await sumOfKey(server.wrapped) });
      this.host.say("The key that the account keeps for sealed copies is wrapped by the new passphrase now.");
    } catch (error) {
      return this.passphraseProblem(error, false);
    }
  }

  /** Whether some encrypted notebook is kept elsewhere (read from the vault when it was unlocked). */
  hasVaultLinks(): boolean {
    return this.vaultLinks.size > 0;
  }

  /** Whether this browser has a key for sealed copies that the account may keep wrapped (the menu offers to wrap it again only then). */
  hasKeptKey(): boolean {
    return !!this.keyStatus?.has;
  }

  private async rewrapDialog(): Promise<void> {
    await showDialog({
      title: "Update the passphrase of the sealed copies",
      body: [
        "Your account keeps the key for sealed copies wrapped by the passphrase of your encrypted notebooks, so that a new device can take it. If you changed that passphrase while you were not signed in, or without network, the account's copy is still wrapped by the old one.",
        "Type the passphrase that the encrypted notebooks have now, to wrap the key again.",
      ],
      fields: [{ name: "passphrase", label: "Passphrase of the encrypted notebooks", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Type the passphrase.") }],
      confirm: "Wrap the key again",
      working: "Wrapping…",
      submit: async (values) => this.rewrap(String(values.passphrase), true),
    });
  }

  // ---------------------------------------------------------------------------------------------- connected services

  private async servicesDialog(): Promise<void> {
    const client = this.account.client;
    let services;
    try {
      services = await client.listConnectors();
    } catch (error) {
      this.host.say(`Couldn't ask the server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.connections = services.connectors;
    const kinds = services.services;
    let next: string | null = null;
    const has = services.connectors.length > 0;
    await showDialog({
      title: "Connected services",
      body: [
        has ? "Services that this account keeps notebooks on. The server holds the password you gave (sealed) so that it can reach the service for you." : "No service is connected. A notebook can be kept on this server, or on a service of yours: connect it here, then choose it in “Keep this notebook on the server…”.",
        "Connecting a service lets this server read and write the folder you give it. Use an app password, not your main one, and a folder that holds only notebooks. Dropbox and Google Drive are allowed in their own window (this server never sees your password), and see only a folder made for this app.",
        ...(!this.account.inBrowser && kinds.some((k) => k.oauth && k.available) ? ["Dropbox and Google Drive are allowed in the web app, in a browser (they use their own window): once connected there, they are listed here."] : []),
        ...(kinds.some((k) => k.oauth && !k.available) ? [`Not set up on this server yet: ${kinds.filter((k) => k.oauth && !k.available).map((k) => k.label).join(", ")} (the person who runs the server has to register an app for it: see its documentation).`] : []),
      ],
      ...(has ? { choices: [{ name: "which", label: "Connection", value: String(services.connectors[0]!.id), options: services.connectors.map((c) => ({ value: String(c.id), label: nameOf(c) })) }] } : {}),
      confirm: has ? "Disconnect" : "Close",
      noCancel: !has,
      danger: has,
      // (a service that is reached through its own window is offered only where the server has an app for it)
      actions: kinds.filter((k) => !k.oauth || (k.available && this.account.inBrowser)).map((k) => ({ label: `Connect ${k.label}…`, run: (close: () => void) => ((next = k.kind), close()) })),
      working: "Disconnecting…",
      submit: async (values) => {
        if (!has) return;
        const id = Number(values.which);
        const used = (await this.host.store.listNotebooks()).filter((n) => this.linkOf(n.id)?.target?.connectorId === id);
        try {
          await client.deleteConnector(id);
        } catch (error) {
          return this.explain(error);
        }
        for (const n of used) this.links.remove(n.id);
        this.host.say(used.length ? `Disconnected. ${used.length} notebook${used.length === 1 ? " is" : "s are"} no longer kept there (nothing was deleted on either side).` : "Disconnected.");
      },
    });
    if (next !== null && kinds.find((k) => k.kind === next)?.oauth) await this.allowThroughWindow(next);
    else if (next === "webdav") await this.connectWebdavDialog();
    else if (next === "github") await this.connectGithubDialog();
    else if (next === "gitlab") await this.connectGitlabDialog();
  }

  /** Off to the service's own window to allow access; it sends the browser back here (the app starts again and says how it went). What is typed is saved first. */
  private async allowThroughWindow(kind: string): Promise<void> {
    await this.host.flush();
    window.location.assign(`/api/connectors/oauth/${encodeURIComponent(kind)}/start`);
  }

  private async connectWebdavDialog(): Promise<void> {
    await showDialog({
      title: "Connect Nextcloud / ownCloud / WebDAV",
      body: [
        "Give the address of the folder that will hold your notebooks (each notebook gets a folder of its own inside). For Nextcloud it looks like https://cloud.example.org/remote.php/dav/files/YOUR-NAME/Notebooks/ (make the folder first).",
        "Use an app password (Nextcloud: Settings → Security), not your main password. The address has to be a public https address.",
      ],
      fields: [
        { name: "label", label: "Name", value: "", placeholder: "My Nextcloud" },
        { name: "url", label: "Folder address", placeholder: "https://cloud.example.org/remote.php/dav/files/…", validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : "Enter a web address.") },
        { name: "username", label: "User name", validate: (v) => (v.trim() ? null : "Enter the user name.") },
        { name: "password", label: "App password", type: "password", autocomplete: "new-password", validate: (v) => (v ? null : "Enter the password.") },
      ],
      confirm: "Test and connect",
      working: "Testing…",
      submit: async (values) => {
        try {
          const made = await this.account.client.addConnector("webdav", String(values.label).trim(), { url: String(values.url).trim(), username: String(values.username).trim(), password: String(values.password) });
          this.connections = [...this.connections, made];
          this.host.say(`Connected: ${made.label}. Choose it in “Keep this notebook on the server…”.`);
        } catch (error) {
          return this.explain(error);
        }
      },
    });
  }

  private async connectGithubDialog(): Promise<void> {
    await showDialog({
      title: "Connect a GitHub repository",
      body: [
        "Notebooks are kept as folders of files in a repository of yours, one commit for each time they are sent. The repository needs at least one commit already (a README does), and it should be private: the notebooks are stored as they are, not encrypted.",
        "Use a fine-grained personal access token (GitHub: Settings → Developer settings → Personal access tokens) for that one repository only, with “Contents: Read and write”. This server keeps it sealed and uses it only to read and write that folder.",
      ],
      fields: [
        { name: "label", label: "Name", value: "", placeholder: "My notes repository" },
        { name: "repo", label: "Repository", placeholder: "owner/name", validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v.trim()) ? null : "Write it as owner/name.") },
        { name: "branch", label: "Branch", value: "main", validate: (v) => (v.trim() ? null : "Give the branch.") },
        { name: "root", label: "Folder in the repository", value: "notebooks", hint: "Each notebook gets a folder inside it. Leave empty for the top of the repository." },
        { name: "token", label: "Access token", type: "password", autocomplete: "new-password", validate: (v) => (v.trim() ? null : "Paste the token.") },
      ],
      confirm: "Test and connect",
      working: "Testing…",
      submit: async (values) => {
        try {
          const made = await this.account.client.addConnector("github", String(values.label).trim(), { repo: String(values.repo).trim(), branch: String(values.branch).trim(), root: String(values.root).trim(), token: String(values.token).trim() });
          this.connections = [...this.connections, made];
          this.host.say(`Connected: ${made.label}. Choose it in “Keep this notebook on the server…”.`);
        } catch (error) {
          return this.explain(error);
        }
      },
    });
  }

  private async connectGitlabDialog(): Promise<void> {
    await showDialog({
      title: "Connect a GitLab project",
      body: [
        "Notebooks are kept as folders of files in a project of yours, one commit for each time they are sent. The project needs at least one commit already (a README does), and it should be private: the notebooks are stored as they are, not encrypted.",
        "Use a personal or project access token with the “api” scope and the Developer role (GitLab: Settings → Access tokens), for that one project if you can. This server keeps it sealed and uses it only to read and write that folder.",
      ],
      fields: [
        { name: "label", label: "Name", value: "", placeholder: "My notes project" },
        { name: "host", label: "GitLab address", value: "gitlab.com", hint: "Change it only for a GitLab of your own (a public https address).", validate: (v) => (/^[\w.-]+(:\d+)?$/.test(v.trim()) ? null : "Give only the host name, like gitlab.com.") },
        { name: "project", label: "Project", placeholder: "group/name", validate: (v) => (/^[\w.-]+(\/[\w.-]+)+$/.test(v.trim()) ? null : "Write it as group/name.") },
        { name: "branch", label: "Branch", value: "main", validate: (v) => (v.trim() ? null : "Give the branch.") },
        { name: "root", label: "Folder in the project", value: "notebooks", hint: "Each notebook gets a folder inside it. Leave empty for the top of the project." },
        { name: "token", label: "Access token", type: "password", autocomplete: "new-password", validate: (v) => (v.trim() ? null : "Paste the token.") },
      ],
      confirm: "Test and connect",
      working: "Testing…",
      submit: async (values) => {
        try {
          const made = await this.account.client.addConnector("gitlab", String(values.label).trim(), { host: String(values.host).trim(), project: String(values.project).trim(), branch: String(values.branch).trim(), root: String(values.root).trim(), token: String(values.token).trim() });
          this.connections = [...this.connections, made];
          this.host.say(`Connected: ${made.label}. Choose it in “Keep this notebook on the server…”.`);
        } catch (error) {
          return this.explain(error);
        }
      },
    });
  }

  private explain(error: unknown): string {
    if (error instanceof ApiError && error.status === 409) return "The notebook changed meanwhile. Try again.";
    return error instanceof Error ? error.message : String(error);
  }
}
