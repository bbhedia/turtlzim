// Keeping notebooks on the account server, as the person sees it: the menu's lines, the questions, and when a notebook is sent or fetched. What is decided is in sync.ts;
// the app gives this what it has of the open notebook (`SyncHost`). Only an open notebook is ever sent (never an encrypted one), and what is sent is in clear: the dialog says so.
import { showDialog } from "../app/dialogs";
import type { NotebookInfo, NotebookStore } from "../notebook/store";
import { pagesFromFiles } from "../notebook/zim-files";
import { fileKey } from "../notebook/store";
import type { ZipEntry } from "../zip";
import type { AccountUi } from "./ui";
import { ApiError } from "./client";
import type { RemoteNotebook } from "./client";
import { decide, digestOf, fromWire, newRemoteId, toWire } from "./sync";
import type { Link } from "./sync";

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

export class SyncUi {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: number | undefined;
  /** Notebooks whose two copies both changed and have not been settled: not touched again until the person chooses. */
  private readonly held = new Set<string>();

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
    lines.push({ label: "Open a notebook from the server…", run: () => void this.fetchDialog() });
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
    if (notebook && notebook.kind === "open" && this.linkOf(notebook.id)) await this.syncNow(true);
  }

  // ---------------------------------------------------------------------------------------------- keeping

  private async keepDialog(): Promise<void> {
    const notebook = this.host.notebook();
    const account = this.account.account;
    if (!notebook || !account || notebook.kind !== "open") return;
    await showDialog({
      title: "Keep this notebook on the server",
      body: [
        `A copy of “${notebook.title}” is kept in your account, so that you can open it from another device. It is sent each time you stop typing, and fetched when the server has a newer one.`,
        `The copy is stored as it is: anyone who runs this server can read it. (Notebooks that you encrypt can't be kept here.) The account has ${Math.floor(account.quotaBytes / 1024)} KB for all its notebooks together.`,
      ],
      confirm: "Keep on the server",
      working: "Sending…",
      submit: async () => {
        try {
          await this.host.flush();
          const files = await this.host.files();
          const remoteId = newRemoteId();
          const sent = await this.account.client.putNotebook(remoteId, { title: notebook.title, baseRevision: 0, files: toWire(files) });
          this.saveLink(notebook.id, { remoteId, revision: sent.revision, digest: await digestOf(files), account: account.email });
        } catch (error) {
          return this.explain(error);
        }
        this.host.say(`“${notebook.title}” is kept on the server.`);
      },
    });
  }

  private async stopDialog(): Promise<void> {
    const notebook = this.host.notebook();
    if (!notebook) return;
    const link = this.linkOf(notebook.id);
    if (!link) return;
    await showDialog({
      title: "Stop keeping this notebook on the server",
      body: ["The notebook stays on this device as it is. It is no longer sent."],
      checks: [{ name: "delete", label: "Also delete the copy on the server", checked: true }],
      confirm: "Stop",
      working: "Working…",
      submit: async (values) => {
        if (values.delete) {
          try {
            await this.account.client.deleteNotebook(link.remoteId);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) return this.explain(error);
          }
        }
        this.links.remove(notebook.id);
        this.held.delete(notebook.id);
        this.host.say(values.delete ? "The copy on the server was deleted." : "This notebook is no longer sent to the server.");
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
    try {
      await this.host.flush();
      const files = await this.host.files();
      const digest = await digestOf(files);
      const remote = (await this.account.client.listNotebooks()).notebooks.find((n) => n.id === link.remoteId);
      if (!remote) {
        await this.missing(notebook, link, auto);
        return;
      }
      const what = this.held.has(notebook.id) ? "conflict" : decide(link, digest, remote.revision);
      if (what === "nothing") {
        if (!auto) this.host.say("This notebook is up to date on the server.");
      } else if (what === "send") await this.send(notebook, link, files, digest, remote.revision);
      else if (what === "fetch") {
        if (this.host.unsaved()) return; // (typing that is not saved yet is not replaced: the next time)
        await this.fetch(notebook, link, remote);
      } else await this.conflict(notebook, link, files, digest, remote);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.host.say("The server's copy changed while this was being sent. It will be looked at again.");
        this.again = true;
        return;
      }
      if (auto && error instanceof ApiError && error.code === "offline") return;
      this.host.say(`Couldn't sync “${notebook.title}”: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async send(notebook: Pick<NotebookInfo, "id" | "title">, link: Link, files: ZipEntry[], digest: string, baseRevision: number): Promise<void> {
    const sent = await this.account.client.putNotebook(link.remoteId, { title: notebook.title, baseRevision, files: toWire(files) });
    this.saveLink(notebook.id, { ...link, revision: sent.revision, digest });
    this.held.delete(notebook.id);
    this.host.say(`“${notebook.title}” was sent to the server.`);
  }

  /** Replace this device's copy by the server's. */
  private async fetch(notebook: Pick<NotebookInfo, "id" | "title" | "home">, link: Link, remote: RemoteNotebook): Promise<void> {
    const copy = await this.account.client.getNotebook(link.remoteId);
    const imported = pagesFromFiles(fromWire(copy.files));
    if (imported.pages.length === 0) throw new Error("The copy on the server has no pages, so it was not used.");
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
    const info = (await store.listNotebooks()).find((n) => n.id === notebook.id);
    if (info) await store.updateNotebook({ ...info, title: copy.title, home });
    await this.host.open(notebook.id);
    this.saveLink(notebook.id, { ...link, revision: remote.revision, digest: await digestOf(await this.host.files()) });
    this.held.delete(notebook.id);
    this.host.say(`“${copy.title}” was brought up to date from the server.`);
  }

  private async conflict(notebook: Pick<NotebookInfo, "id" | "title" | "home">, link: Link, files: ZipEntry[], digest: string, remote: RemoteNotebook): Promise<void> {
    this.held.add(notebook.id);
    let choice: "mine" | "theirs" | null = null;
    await showDialog({
      title: "This notebook changed in two places",
      body: [
        `“${notebook.title}” was changed on this device and also on the server (from another device) since they last agreed. One copy has to replace the other; the pages of the copy that is not kept are lost.`,
        "Nothing is sent or replaced until you choose.",
      ],
      confirm: "Keep this device's copy",
      danger: true,
      actions: [{ label: "Use the server's copy", run: (close) => ((choice = "theirs"), close()) }],
      submit: () => {
        choice = "mine";
      },
    });
    if (choice === "mine") await this.send(notebook, link, files, digest, remote.revision);
    else if (choice === "theirs") await this.fetch(notebook, link, remote);
    else this.host.say("Not synced: this notebook changed in two places. Choose “Sync this notebook now” to settle it.");
  }

  /** The server no longer has the copy (deleted from another device, or the account was started again). */
  private async missing(notebook: Pick<NotebookInfo, "id" | "title">, link: Link, auto: boolean): Promise<void> {
    if (auto) {
      this.host.say(`“${notebook.title}” is no longer on the server.`);
      this.links.remove(notebook.id);
      return;
    }
    this.links.remove(notebook.id);
    this.host.say(`“${notebook.title}” is no longer on the server, so it is no longer kept there. “Keep this notebook on the server…” sends it again.`);
    void link;
  }

  // ---------------------------------------------------------------------------------------------- fetching another

  private async fetchDialog(): Promise<void> {
    let list: RemoteNotebook[];
    try {
      list = (await this.account.client.listNotebooks()).notebooks;
    } catch (error) {
      this.host.say(`Couldn't ask the server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const known = new Set((await this.host.store.listNotebooks()).map((n) => this.linkOf(n.id)?.remoteId).filter(Boolean));
    const missing = list.filter((n) => !known.has(n.id));
    if (missing.length === 0) {
      await showDialog({ title: "Notebooks on the server", body: [list.length ? "Every notebook on the server is already on this device." : "There is nothing on the server yet. Open a notebook and choose “Keep this notebook on the server…”."], confirm: "Close", noCancel: true });
      return;
    }
    await showDialog({
      title: "Open a notebook from the server",
      body: ["The notebook is copied to this device and kept in step with the server."],
      choices: [{ name: "which", label: "Notebook", value: missing[0]!.id, options: missing.map((n) => ({ value: n.id, label: `${n.title} (${Math.max(1, Math.round((n.bytes ?? 0) / 1024))} KB)` })) }],
      confirm: "Open",
      working: "Fetching…",
      submit: async (values) => {
        const account = this.account.account;
        const remote = missing.find((n) => n.id === values.which);
        if (!account || !remote) return "That notebook is not on the server any more.";
        try {
          const copy = await this.account.client.getNotebook(remote.id);
          const imported = pagesFromFiles(fromWire(copy.files));
          if (imported.pages.length === 0) return "The copy on the server has no pages.";
          const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
          const home = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
          const info = await this.host.store.createNotebook({ title: copy.title, home, kind: "open" }, imported.pages, imported.files);
          await this.host.open(info.id);
          this.saveLink(info.id, { remoteId: remote.id, revision: copy.revision, digest: await digestOf(await this.host.files()), account: account.email });
          this.host.say(`“${copy.title}” was copied from the server.`);
        } catch (error) {
          return this.explain(error);
        }
      },
    });
  }

  private explain(error: unknown): string {
    if (error instanceof ApiError && error.status === 409) return "The notebook changed on the server meanwhile. Try again.";
    return error instanceof Error ? error.message : String(error);
  }
}
