// Keeping notebooks away from this device, as the person sees it: the menu's lines, the questions, and when a notebook is sent or fetched. Where a copy is kept is a `Remote`: the
// account's own space on the server (1 MB), or a folder of a service that was connected (Nextcloud and the like, which the server reaches for the person). What is decided is in sync.ts;
// the app gives this what it has of the open notebook (`SyncHost`). Only an open notebook is ever sent (never an encrypted one), and what is sent is in clear: the dialog says so.
import { showDialog } from "../app/dialogs";
import type { NotebookInfo, NotebookStore } from "../notebook/store";
import { fileKey } from "../notebook/store";
import { pagesFromFiles } from "../notebook/zim-files";
import type { ZipEntry } from "../zip";
import { ApiError } from "./client";
import type { Connection, WireFile } from "./client";
import { SEALED_ID } from "./sealed";
import { decide, digestOf, fileDigests, folderNameFor, fromWire, newRemoteId, toWire } from "./sync";
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

/** Where a notebook's copy is kept. */
interface Remote {
  /** In words, for what is said to the person: “the server”, “My Nextcloud”. */
  place: string;
  /** The copy's version now, or null if it is not there. */
  version(): Promise<Version | null>;
  read(): Promise<{ title?: string; files: WireFile[]; version: Version }>;
  /** Replace the copy by `files` (only what changed from `previous`, where a service can be told so); `base` is the version this was made from. */
  write(title: string, files: ZipEntry[], base: Version, previous: Link | null): Promise<{ version: Version }>;
  remove(): Promise<void>;
}

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
        version: async () => (await client.listNotebooks()).notebooks.find((n) => n.id === link.remoteId)?.revision ?? null,
        read: async () => {
          const copy = await client.getNotebook(link.remoteId);
          return { title: copy.title, files: copy.files, version: copy.revision };
        },
        write: async (title, files, base) => ({ version: (await client.putNotebook(link.remoteId, { title, baseRevision: Number(base), files: toWire(files) })).revision }),
        remove: async () => void (await client.deleteNotebook(link.remoteId)),
      };
    }
    const name = this.connections.find((c) => c.id === target.connectorId)?.label ?? "the connected service";
    return {
      place: name,
      version: async () => {
        const listed = await client.connectorList(target.connectorId, target.dir);
        return listed.version === "" ? null : listed.version;
      },
      read: async () => {
        const copy = await client.connectorRead(target.connectorId, target.dir);
        return { files: copy.files, version: copy.version };
      },
      write: async (_title, files, base, previous) => {
        const digests = await fileDigests(files);
        const before = previous?.files;
        const changed = files.filter((f) => !before || before[f.path] !== digests[f.path]);
        const gone = before ? Object.keys(before).filter((path) => !(path in digests)) : [];
        const sent = await client.connectorWrite(target.connectorId, target.dir, { baseVersion: String(base), put: toWire(changed), remove: gone });
        return { version: sent.version };
      },
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
    const where = [{ value: ACCOUNT, label: `The account's space on this server (${Math.floor(account.quotaBytes / 1024)} KB)` }, ...this.connections.map((c) => ({ value: String(c.id), label: `${c.service}: ${c.label}` }))];
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
          if (values.where === ACCOUNT) {
            const remoteId = newRemoteId();
            const link: Link = { remoteId, revision: 0, digest, account: account.email };
            const sent = await this.remoteFor(link).write(notebook.title, files, 0, null);
            this.saveLink(notebook.id, { ...link, revision: sent.version });
          } else {
            const connectorId = Number(values.where);
            const dir = folderNameFor(notebook.title);
            const link: Link = { remoteId: dir, target: { kind: "connector", connectorId, dir }, revision: "", digest, account: account.email };
            const sent = await this.remoteFor(link).write(notebook.title, files, "", null);
            this.saveLink(notebook.id, { ...link, revision: sent.version, files: await fileDigests(files) });
          }
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

  private async sync(auto: boolean): Promise<void> {
    const notebook = this.host.notebook();
    const account = this.account.account;
    if (!notebook || !account || notebook.kind !== "open") return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    const remote = this.remoteFor(link);
    try {
      await this.host.flush();
      const files = await this.host.files();
      const digest = await digestOf(files);
      const version = await remote.version();
      if (version === null) {
        this.links.remove(notebook.id);
        this.host.say(auto ? `“${notebook.title}” is no longer on ${remote.place}.` : `“${notebook.title}” is no longer on ${remote.place}, so it is no longer kept there. “Keep this notebook on the server…” sends it again.`);
        return;
      }
      const what = this.held.has(notebook.id) ? "conflict" : decide(link, digest, version);
      if (what === "nothing") {
        if (!auto) this.host.say(`This notebook is up to date on ${remote.place}.`);
      } else if (what === "send") await this.send(notebook, link, remote, files, digest, version);
      else if (what === "fetch") {
        if (this.host.unsaved()) return; // (typing that is not saved yet is not replaced: the next time)
        await this.fetch(notebook, link, remote);
      } else await this.conflict(notebook, link, remote, files, digest, version);
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

  private async send(notebook: Pick<NotebookInfo, "id" | "title">, link: Link, remote: Remote, files: ZipEntry[], digest: string, base: Version): Promise<void> {
    const sent = await remote.write(notebook.title, files, base, link);
    this.saveLink(notebook.id, { ...link, revision: sent.version, digest, ...(link.target ? { files: await fileDigests(files) } : {}) });
    this.held.delete(notebook.id);
    this.host.say(`“${notebook.title}” was sent to ${remote.place}.`);
  }

  /** Replace this device's copy by the other one. */
  private async fetch(notebook: Pick<NotebookInfo, "id" | "title" | "home">, link: Link, remote: Remote): Promise<void> {
    const copy = await remote.read();
    const imported = pagesFromFiles(fromWire(copy.files));
    if (imported.pages.length === 0) throw new Error(`The copy on ${remote.place} has no pages, so it was not used.`);
    const store = this.host.store;
    const pages = await store.loadPages(notebook.id);
    const present = await store.listFiles(notebook.id);
    const newPages = new Set(imported.pages.map((p) => p.name.toLowerCase()));
    const newFiles = new Set(imported.files.map((f) => fileKey(f.path)));
    await store.replacePages(notebook.id, {
      remove: pages.filter((p) => !newPages.has(p.name.toLowerCase())).map((p) => p.name),
      put: imported.pages,
      files: { remove: present.filter((f) => !newFiles.has(fileKey(f.path))).map((f) => f.path), put: imported.files },
    });
    const home = imported.config.home && newPages.has(imported.config.home.toLowerCase()) ? imported.config.home : newPages.has(notebook.home.toLowerCase()) ? notebook.home : (imported.pages[0] as { name: string }).name;
    const title = copy.title ?? imported.config.name ?? notebook.title;
    const info = (await store.listNotebooks()).find((n) => n.id === notebook.id);
    if (info) await store.updateNotebook({ ...info, title, home });
    await this.host.open(notebook.id);
    const local = await this.host.files();
    this.saveLink(notebook.id, { ...link, revision: copy.version, digest: await digestOf(local), ...(link.target ? { files: await fileDigests(local) } : {}) });
    this.held.delete(notebook.id);
    this.host.say(`“${title}” was brought up to date from ${remote.place}.`);
  }

  private async conflict(notebook: Pick<NotebookInfo, "id" | "title" | "home">, link: Link, remote: Remote, files: ZipEntry[], digest: string, version: Version): Promise<void> {
    this.held.add(notebook.id);
    let choice: "mine" | "theirs" | null = null;
    await showDialog({
      title: "This notebook changed in two places",
      body: [
        `“${notebook.title}” was changed on this device and also on ${remote.place} (from another device) since they last agreed. One copy has to replace the other; the pages of the copy that is not kept are lost.`,
        "Nothing is sent or replaced until you choose.",
      ],
      confirm: "Keep this device's copy",
      danger: true,
      actions: [{ label: remote.place === "the server" ? "Use the server's copy" : "Use the other copy", run: (close) => ((choice = "theirs"), close()) }],
      submit: () => {
        choice = "mine";
      },
    });
    if (choice === "mine") await this.send(notebook, link, remote, files, digest, version);
    else if (choice === "theirs") await this.fetch(notebook, link, remote);
    else this.host.say("Not synced: this notebook changed in two places. Choose “Sync this notebook now” to settle it.");
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
          const copy = await remote.read();
          const imported = pagesFromFiles(fromWire(copy.files));
          if (imported.pages.length === 0) return "That copy has no pages.";
          const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
          const home = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
          const title = copy.title ?? imported.config.name ?? link.remoteId;
          const info = await this.host.store.createNotebook({ title, home, kind: "open" }, imported.pages, imported.files);
          await this.host.open(info.id);
          const local = await this.host.files();
          this.saveLink(info.id, { ...link, revision: copy.version, digest: await digestOf(local), ...(link.target ? { files: await fileDigests(local) } : {}) });
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
        "Connecting a service lets this server read and write the folder you give it. Use an app password, not your main one, and a folder that holds only notebooks.",
      ],
      ...(has ? { choices: [{ name: "which", label: "Connection", value: String(services.connectors[0]!.id), options: services.connectors.map((c) => ({ value: String(c.id), label: `${c.service}: ${c.label}` })) }] } : {}),
      confirm: has ? "Disconnect" : "Close",
      noCancel: !has,
      danger: has,
      actions: kinds.map((k) => ({ label: `Connect ${k.label}…`, run: (close: () => void) => ((next = k.kind), close()) })),
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
    if (next === "webdav") await this.connectWebdavDialog();
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

  private explain(error: unknown): string {
    if (error instanceof ApiError && error.status === 409) return "The notebook changed meanwhile. Try again.";
    return error instanceof Error ? error.message : String(error);
  }
}
