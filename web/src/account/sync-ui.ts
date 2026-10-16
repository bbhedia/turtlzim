// Keeping notebooks away from this device, as the person sees it: the menu's lines, the questions, and when a notebook is sent or fetched. Where a copy is kept is a `Remote`: the
// account's own space on the server (1 MB), or a folder of a service that was connected (Nextcloud and the like, which the server reaches for the person). What is decided is in sync.ts;
// the app gives this what it has of the open notebook (`SyncHost`). Only an open notebook is ever sent (never an encrypted one), and what is sent is in clear: the dialog says so.
import { showDialog } from "../app/dialogs";
import { h } from "../app/dom";
import type { NotebookInfo, NotebookStore } from "../notebook/store";
import { pathToPage } from "../notebook-core";
import { pagesFromFiles } from "../notebook/zim-files";
import type { ImportedFile } from "../notebook/zim-files";
import type { ZipEntry } from "../zip";
import { ApiError } from "./client";
import type { Connection, WireFile } from "./client";
import { SEALED_ID } from "./sealed";
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
}

export interface LinkStorage {
  get(id: string): string | null;
  set(id: string, value: string): void;
  remove(id: string): void;
}

/** How long after the last change a linked notebook is sent. */
export const AUTO_SEND_MS = 6000;

type Version = string | number;

/** What the other copy holds now: its version, and a mark for each of its files (a mark changes when the file's content does). */
interface Manifest {
  version: Version;
  marks: Record<string, string>;
}

/** Where a notebook's copy is kept. */
interface Remote {
  /** In words, for what is said to the person: “the server”, “My Nextcloud”. */
  place: string;
  /** What the copy holds now, or null if it is not there. */
  manifest(): Promise<Manifest | null>;
  /** Some of its files (all of them if no paths are given). */
  read(paths?: string[]): Promise<{ title?: string; files: WireFile[]; version: Version }>;
  /** Write these files and delete those, on top of the version `base` (the first write of a notebook has the base that a new one has: 0, or ""). */
  write(title: string, put: ZipEntry[], remove: string[], base: Version): Promise<{ version: Version }>;
  remove(): Promise<void>;
}

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

  constructor(
    private readonly host: SyncHost,
    private readonly account: AccountUi,
    private readonly links: LinkStorage,
  ) {}

  linkOf(id: string): Link | null {
    const email = this.account.account?.email;
    if (!email) return null;
    try {
      const link = JSON.parse(this.links.get(id) ?? "null") as Link | null;
      return link && link.account === email && typeof link.remoteId === "string" ? link : null;
    } catch {
      return null;
    }
  }

  private saveLink(id: string, link: Link): void {
    this.links.set(id, JSON.stringify(link));
  }

  private remoteFor(link: Link): Remote {
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
    if (notebook.kind === "open") {
      if (this.linkOf(notebook.id)) {
        lines.push({ label: "Sync this notebook now", run: () => void this.syncNow(false) }, { label: "Stop keeping this notebook on the server…", run: () => void this.stopDialog() });
      } else lines.push({ label: "Keep this notebook on the server…", run: () => void this.keepDialog() });
    }
    lines.push({ label: "Open a notebook from the server…", run: () => void this.fetchDialog() }, { label: "Connected services…", run: () => void this.servicesDialog() });
    return lines;
  }

  /** Called when the open notebook was saved: a linked one is sent soon, once typing has paused. */
  changed(): void {
    const notebook = this.host.notebook();
    window.clearTimeout(this.timer);
    if (!notebook || notebook.kind !== "open" || !this.linkOf(notebook.id) || this.held.has(notebook.id)) return;
    this.timer = window.setTimeout(() => void this.syncNow(true), AUTO_SEND_MS);
  }

  /** At the start, and when the account becomes known: bring the open notebook up to date, if it is linked. */
  async catchUp(): Promise<void> {
    const notebook = this.host.notebook();
    if (notebook && notebook.kind === "open" && this.linkOf(notebook.id)) {
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
    if (!notebook || !account || notebook.kind !== "open") return;
    await this.loadConnections();
    const where = [{ value: ACCOUNT, label: `The account's space on this server (${Math.floor(account.quotaBytes / 1024)} KB)` }, ...this.connections.map((c) => ({ value: String(c.id), label: nameOf(c) }))];
    await showDialog({
      title: "Keep this notebook on the server",
      body: [
        `A copy of “${notebook.title}” is kept, so that you can open it from another device. It is sent each time you stop typing, and fetched when the copy is newer.`,
        "The copy is stored as it is, not encrypted: anyone who runs the server, or who has access to the service you choose, can read it. (Notebooks that you encrypt can't be kept like this.)",
      ],
      choices: [{ name: "where", label: "Where", value: ACCOUNT, options: where }],
      confirm: "Keep it there",
      working: "Sending…",
      submit: async (values) => {
        try {
          await this.host.flush();
          const files = await this.host.files();
          const digest = await digestOf(files);
          const first: Link = values.where === ACCOUNT
            ? { remoteId: newRemoteId(), revision: 0, digest, account: account.email }
            : { remoteId: folderNameFor(notebook.title), target: { kind: "connector", connectorId: Number(values.where), dir: "" }, revision: "", digest, account: account.email };
          if (first.target) first.target.dir = first.remoteId;
          const remote = this.remoteFor(first);
          await remote.write(notebook.title, files, [], first.revision);
          const made = await remote.manifest();
          this.saveLink(notebook.id, { ...first, revision: made?.version ?? first.revision, files: await fileDigests(files), marks: made?.marks ?? {} });
        } catch (error) {
          return this.explain(error);
        }
        this.host.say(`“${notebook.title}” is kept ${values.where === ACCOUNT ? "on the server" : `on ${this.connections.find((c) => String(c.id) === values.where)?.label ?? "the service"}`}.`);
      },
    });
  }

  private async stopDialog(): Promise<void> {
    const notebook = this.host.notebook();
    if (!notebook) return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    await this.loadConnections();
    const remote = this.remoteFor(link);
    await showDialog({
      title: "Stop keeping this notebook on the server",
      body: [`The notebook stays on this device as it is. It is no longer sent to ${remote.place}.`],
      checks: [{ name: "delete", label: link.target ? "Also delete its files on the service" : "Also delete the copy on the server", checked: true }],
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
        this.links.remove(notebook.id);
        this.held.delete(notebook.id);
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
    if (!notebook || !account || notebook.kind !== "open") return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    if (auto && this.held.has(notebook.id)) return;
    const remote = this.remoteFor(link);
    try {
      await this.host.flush();
      const start = await this.host.files();
      const local = await fileDigests(start);
      const whole = await digestOf(start);
      const now = await remote.manifest();
      if (!now) {
        this.links.remove(notebook.id);
        this.host.say(auto ? `“${notebook.title}” is no longer on ${remote.place}.` : `“${notebook.title}” is no longer on ${remote.place}, so it is no longer kept there. “Keep this notebook on the server…” sends it again.`);
        return;
      }
      const base = baseOf(link, local, whole, now.version, now.marks);
      let plan = planMerge(base, local, now.marks);
      const upgraded = link.files === undefined || link.marks === undefined;
      if (plan.length === 0) {
        if (upgraded) this.saveLink(notebook.id, { ...link, revision: now.version, digest: whole, files: local, marks: now.marks });
        if (!auto) this.host.say(`This notebook is up to date on ${remote.place}.`);
        return;
      }
      // (what is brought here replaces pages on the screen: not while typing that is not saved yet could be lost with them)
      if (plan.some((p) => p.action !== "push" && p.action !== "pushDelete" && p.action !== "settled") && this.host.unsaved()) return;
      // the notebook's own file (its name and home page) is this device's when both sides changed it
      plan = plan.map((p) => (p.path === "notebook.zim" && p.action === "conflict" ? { path: p.path, action: local[p.path] === undefined ? ("pull" as const) : ("push" as const) } : p));

      // a page changed on both sides may have been changed the same way: only what really differs is asked about
      const maybe = plan.filter((p) => p.action === "conflict" && now.marks[p.path] !== undefined).map((p) => p.path);
      const theirs = new Map<string, Uint8Array>();
      if (maybe.length) for (const f of fromWire((await remote.read(maybe)).files)) theirs.set(f.path, f.bytes as Uint8Array);
      const identical = new Set<string>();
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
      this.saveLink(notebook.id, { ...link, revision: after.version, digest: await digestOf(await this.host.files()), files: known, marks: after.marks });
      this.held.delete(notebook.id);

      const sentCount = push.size + pushDelete.size + copyPaths.size;
      const broughtCount = pull.size + pullDelete.size + copies.size;
      const title = (this.host.notebook() ?? notebook).title;
      if (sentCount && broughtCount) this.host.say(`“${title}” was merged with ${remote.place} (${sentCount} sent, ${broughtCount} brought here${copies.size ? `; ${copies.size} other ${copies.size === 1 ? "copy was" : "copies were"} kept beside the page` : ""}).`);
      else if (sentCount) this.host.say(`“${title}” was sent to ${remote.place}.`);
      else if (broughtCount) this.host.say(`“${title}” was brought up to date from ${remote.place}.`);
      else if (!auto) this.host.say(`This notebook is up to date on ${remote.place}.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.host.say(`The copy on ${remote.place} changed while this was being sent. It will be looked at again.`);
        this.again = true;
        return;
      }
      if (auto && error instanceof ApiError && error.code === "offline") return;
      this.host.say(`Couldn't sync “${notebook.title}”: ${error instanceof Error ? error.message : String(error)}`);
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
        if (n.id !== SEALED_ID && !known.has(`a:${n.id}`)) options.push({ value: `a:${n.id}`, label: `${n.title} (the server, ${Math.max(1, Math.round((n.bytes ?? 0) / 1024))} KB)` });
      }
      for (const c of this.connections) {
        try {
          for (const dir of (await client.connectorFolders(c.id)).folders) if (!known.has(`c:${c.id}:${dir}`)) options.push({ value: `c:${c.id}:${dir}`, label: `${dir} (${c.label})` });
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
          this.host.say(`“${title}” was copied from ${remote.place}.`);
        } catch (error) {
          return this.explain(error);
        }
      },
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
        ...(kinds.some((k) => k.oauth && !k.available) ? [`Not set up on this server yet: ${kinds.filter((k) => k.oauth && !k.available).map((k) => k.label).join(", ")} (the person who runs the server has to register an app for it: see its documentation).`] : []),
      ],
      ...(has ? { choices: [{ name: "which", label: "Connection", value: String(services.connectors[0]!.id), options: services.connectors.map((c) => ({ value: String(c.id), label: nameOf(c) })) }] } : {}),
      confirm: has ? "Disconnect" : "Close",
      noCancel: !has,
      danger: has,
      // (a service that is reached through its own window is offered only where the server has an app for it)
      actions: kinds.filter((k) => !k.oauth || k.available).map((k) => ({ label: `Connect ${k.label}…`, run: (close: () => void) => ((next = k.kind), close()) })),
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
