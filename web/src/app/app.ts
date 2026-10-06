// The notebook app: a page tree, the editor, search, backlinks, and everything that changes a notebook
// (new page, rename, delete, import, export), over a NotebookSession. The notebook's rules are the
// Rust ones in wasm; the pages live in a store; this file is only the interface between a person and
// those.
import { createZimEditor } from "../editor";
import type { LinkInfo, LinkStatus, ZimEditor } from "../editor";
import { anchorsIn, checkPageName, newPageText, pageKey, zimTimestamp } from "../notebook-core";
import type { Backlink, SearchHit } from "../notebook-core";
import { IndexedDbStore } from "../notebook/idb";
import { createSampleNotebook } from "../notebook/sample";
import { NotebookSession, createEmptyNotebook } from "../notebook/session";
import type { SessionEvent } from "../notebook/session";
import { MemoryStore } from "../notebook/store";
import type { NotebookInfo, NotebookStore } from "../notebook/store";
import { pagesFromFiles } from "../notebook/zim-files";
import type { Imported, ImportedFile } from "../notebook/zim-files";
import { createZip, readZip } from "../zip";
import { showDialog, showMessage } from "./dialogs";
import { clear, h, highlighted } from "./dom";
import { TreeView } from "./tree-view";

const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`zim:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`zim:${key}`, value);
    } catch {
      // a browser that won't remember settings still works
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(`zim:${key}`);
    } catch {
      // see above
    }
  },
};

/**
 * Typing that has not reached the notebook's store yet. The store is written asynchronously, and a
 * page that is closing (or reloading) may be gone before a write finishes, so what is on screen is
 * also put where a closing page can still put it: localStorage is synchronous. The next start puts
 * it in the notebook (see `App.recoverDraft`).
 */
interface Draft {
  notebook: string;
  name: string;
  text: string;
  /** When it was written: ms since the epoch. */
  at: number;
}

function readDraft(): Draft | null {
  try {
    const draft: unknown = JSON.parse(prefs.get("draft") ?? "null");
    if (draft && typeof draft === "object") {
      const { notebook, name, text, at } = draft as Record<string, unknown>;
      if (typeof notebook === "string" && typeof name === "string" && typeof text === "string" && typeof at === "number") return { notebook, name, text, at };
    }
  } catch {
    // not a draft
  }
  return null;
}

/** The address bar's way of naming a page: `#/Projects%3AGarden`. */
const hashFor = (name: string) => `#/${encodeURIComponent(name)}`;
function pageFromHash(): string | null {
  const match = /^#\/(.+)$/.exec(location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

/** Addresses the app will open from a link: nothing a page could use to run code (`javascript://...`). */
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "ftp:"]);

const SAVE_DELAY_MS = 700;

interface Current {
  name: string;
  /** Whether the page has text in the notebook yet (a page you've only looked at doesn't). */
  exists: boolean;
}

export class App {
  session!: NotebookSession;
  editor!: ZimEditor;
  current: Current | null = null;

  private readonly store: NotebookStore;
  private readonly keptInMemory: boolean;
  private readonly tree: TreeView;
  private readonly linkCache = new Map<string, LinkStatus>();
  private saveTimer: number | undefined;
  private dirty = false;
  private saveFailed = false;
  /** Saves started and not yet finished. */
  private saving = 0;
  private saveChain: Promise<void> = Promise.resolve();
  private loading = false;
  private navigation = 0;
  private searchHits: SearchHit[] = [];
  private searchActive = -1;
  private readonly els: {
    root: HTMLElement;
    page: HTMLElement;
    sidebarToggle: HTMLButtonElement;
    notebookButton: HTMLButtonElement;
    notebookMenu: HTMLElement;
    search: HTMLInputElement;
    searchResults: HTMLElement;
    markup: HTMLInputElement;
    breadcrumb: HTMLElement;
    notice: HTMLElement;
    editorHost: HTMLElement;
    backlinks: HTMLDetailsElement;
    backlinkCount: HTMLElement;
    backlinkList: HTMLElement;
    status: HTMLElement;
    saveState: HTMLElement;
    rename: HTMLButtonElement;
    subpage: HTMLButtonElement;
    download: HTMLButtonElement;
    remove: HTMLButtonElement;
    folderInput: HTMLInputElement;
    zipInput: HTMLInputElement;
  };

  private constructor(root: HTMLElement, store: NotebookStore, keptInMemory: boolean) {
    this.store = store;
    this.keptInMemory = keptInMemory;
    this.tree = new TreeView({ onOpen: (name) => void this.openPage(name, { push: true, closeSidebar: true }), onFoldChange: (folded) => prefs.set(`folded:${this.session?.info.id}`, JSON.stringify([...folded])) });
    this.els = this.build(root);
  }

  /** Open the notebook storage, build the interface, and open the last notebook (the sample one the first time). */
  static async start(root: HTMLElement): Promise<App> {
    let store: NotebookStore;
    let keptInMemory = false;
    try {
      store = await IndexedDbStore.open(pageKey);
      void IndexedDbStore.requestPersistence();
    } catch {
      store = new MemoryStore(pageKey);
      keptInMemory = true;
    }
    const app = new App(root, store, keptInMemory);
    await app.openInitialNotebook();
    return app;
  }

  // ------------------------------------------------------------------------------------------
  // the interface

  private build(root: HTMLElement): App["els"] {
    clear(root);
    const button = (text: string, extra: Record<string, unknown> = {}) => h("button", { type: "button", text, ...extra });

    const sidebarToggle = h("button", { type: "button", class: "icon-button", "aria-label": "Show or hide the page tree", "aria-controls": "sidebar", "aria-expanded": "true", on: { click: () => this.toggleSidebar() } }, h("span", { class: "burger", "aria-hidden": "true" }));
    const notebookButton = h("button", { type: "button", class: "notebook-button", "aria-haspopup": "menu", "aria-expanded": "false", on: { click: () => this.toggleNotebookMenu() } });
    const notebookMenu = h("div", { class: "menu", role: "menu", hidden: true, "aria-label": "Notebooks" });
    const search = h("input", { id: "search", type: "search", class: "search-input", placeholder: "Search pages   ( / )", "aria-label": "Search pages", role: "combobox", "aria-expanded": "false", "aria-controls": "search-results", "aria-autocomplete": "list", autocomplete: "off", spellcheck: "false" });
    const searchResults = h("div", { id: "search-results", class: "search-results", role: "listbox", hidden: true, "aria-label": "Search results" });
    const markup = h("input", { id: "markup", type: "checkbox", on: { change: () => { this.editor.setShowMarkup(markup.checked); prefs.set("markup", markup.checked ? "1" : "0"); } } });
    const folderInput = h("input", { type: "file", hidden: true, multiple: true, webkitdirectory: true, "aria-label": "Choose a notebook folder" });
    const zipInput = h("input", { type: "file", hidden: true, accept: ".zip,application/zip", "aria-label": "Choose a zip file" });

    const breadcrumb = h("nav", { class: "breadcrumb", "aria-label": "Page path" });
    const rename = h("button", { type: "button", text: "Rename", on: { click: () => void this.renamePage() } });
    const subpage = h("button", { type: "button", text: "New sub-page", on: { click: () => void this.newPage(this.current ? `${this.current.name}:` : "") } });
    const download = h("button", { type: "button", text: "Download", title: "Download this page as a .txt file", on: { click: () => this.downloadPage() } });
    const remove = h("button", { type: "button", class: "danger-text", text: "Delete", on: { click: () => void this.deletePage() } });
    const notice = h("div", { class: "notice", role: "status", hidden: true });
    const editorHost = h("div", { id: "editor", class: "editor-host" });
    const backlinkCount = h("span", { class: "count" });
    const backlinkList = h("ul", { class: "backlink-list" });
    const backlinks = h("details", { class: "backlinks", open: true }, h("summary", {}, "Linked from ", backlinkCount), backlinkList);
    const status = h("span", { id: "status", class: "status", role: "status", "aria-live": "polite" });
    const saveState = h("span", { class: "save-state", "aria-hidden": "true" });

    const sidebar = h(
      "aside",
      { id: "sidebar", class: "sidebar", "aria-label": "Page tree" },
      h("div", { class: "sidebar-tools" }, button("Fold all", { on: { click: () => this.tree.foldAll(true) } }), button("Unfold all", { on: { click: () => this.tree.foldAll(false) } })),
      this.tree.element,
    );
    const page = h("main", { class: "page" }, h("div", { class: "pagebar" }, breadcrumb, h("div", { class: "page-actions" }, rename, subpage, download, remove)), notice, editorHost, backlinks);

    root.append(
      h(
        "div",
        { class: "app", "data-sidebar": window.matchMedia("(max-width: 48rem)").matches ? "closed" : prefs.get("sidebar") === "closed" ? "closed" : "open" },
        h("header", { class: "topbar" }, sidebarToggle, h("div", { class: "notebook-menu" }, notebookButton, notebookMenu), h("div", { class: "search" }, search, searchResults), button("New page", { class: "primary", on: { click: () => void this.newPage(this.current?.name.includes(":") ? `${this.current.name.slice(0, this.current.name.lastIndexOf(":") + 1)}` : "") } }), h("label", { class: "check", for: "markup" }, markup, " Show markup")),
        sidebar,
        page,
        h("footer", { class: "statusbar" }, status, saveState),
        folderInput,
        zipInput,
      ),
    );

    markup.checked = prefs.get("markup") === "1";
    this.editor = createZimEditor(editorHost, "", {
      showMarkup: markup.checked,
      linkStatus: (target) => this.linkStatus(target),
      onChange: () => this.onEditorChange(),
      onNavigate: (link) => void this.followLink(link),
    });
    sidebarToggle.setAttribute("aria-expanded", String(root.querySelector(".app")?.getAttribute("data-sidebar") === "open"));

    // search
    search.addEventListener("input", () => this.runSearch(search.value));
    search.addEventListener("keydown", (e) => this.onSearchKey(e));
    search.addEventListener("focus", () => search.value && this.runSearch(search.value));
    document.addEventListener("click", (e) => {
      const target = e.target as Node;
      if (!search.contains(target) && !searchResults.contains(target)) this.closeSearch();
      if (!notebookMenu.contains(target) && !notebookButton.contains(target)) this.closeNotebookMenu();
    });
    document.addEventListener("keydown", (e) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, select, [contenteditable='true']") !== null);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        search.focus();
        search.select();
      } else if (e.key === "Escape") {
        this.closeNotebookMenu();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.flush().then(() => this.say(this.saveFailed ? "Couldn't save: see the message at the bottom." : "Saved."));
      }
    });
    // keep what was typed: the page may be about to go away
    const leaving = () => {
      this.keepDraft();
      void this.flush();
    };
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && leaving());
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", (e) => {
      // Typing that is on its way to the store is safe (see keepDraft); typing the store refused is not.
      if (this.saveFailed) e.preventDefault();
    });
    window.addEventListener("popstate", () => {
      const name = pageFromHash();
      if (name && (!this.current || name !== this.current.name)) void this.openPage(name, { push: false });
    });

    folderInput.addEventListener("change", () => void this.readPickedFiles(folderInput, "folder"));
    zipInput.addEventListener("change", () => void this.readPickedFiles(zipInput, "zip"));

    return { root, page, sidebarToggle, notebookButton, notebookMenu, search, searchResults, markup, breadcrumb, notice, editorHost, backlinks, backlinkCount, backlinkList, status, saveState, rename, subpage, download, remove, folderInput, zipInput };
  }

  private toggleSidebar(): void {
    const app = this.els.root.querySelector<HTMLElement>(".app")!;
    const open = app.dataset.sidebar !== "open";
    app.dataset.sidebar = open ? "open" : "closed";
    this.els.sidebarToggle.setAttribute("aria-expanded", String(open));
    if (!window.matchMedia("(max-width: 48rem)").matches) prefs.set("sidebar", open ? "open" : "closed");
  }

  private closeSidebarIfNarrow(): void {
    if (window.matchMedia("(max-width: 48rem)").matches) {
      this.els.root.querySelector<HTMLElement>(".app")!.dataset.sidebar = "closed";
      this.els.sidebarToggle.setAttribute("aria-expanded", "false");
    }
  }

  /** Say something in the status line. */
  say(text: string): void {
    this.els.status.textContent = text;
  }

  // ------------------------------------------------------------------------------------------
  // notebooks

  private async openInitialNotebook(): Promise<void> {
    let notebooks = await this.store.listNotebooks();
    if (notebooks.length === 0) {
      await createSampleNotebook(this.store);
      notebooks = await this.store.listNotebooks();
    }
    const draft = readDraft();
    const last = prefs.get("notebook");
    const info = notebooks.find((n) => n.id === draft?.notebook) ?? notebooks.find((n) => n.id === last) ?? (notebooks[0] as NotebookInfo);
    const draftHere = draft && draft.notebook === info.id ? draft : null;
    await this.openNotebook(info.id, pageFromHash() ?? draftHere?.name ?? null);
    if (draftHere) await this.recoverDraft(draftHere);
    else if (draft) prefs.remove("draft"); // for a notebook that is gone
    if (this.keptInMemory) this.showNotice("This browser won't keep notebooks for this site, so what you write is lost when the tab closes. Use Export in the notebook menu to keep a copy.");
  }

  async openNotebook(id: string, pageName: string | null = null): Promise<void> {
    await this.flush();
    const session = await NotebookSession.open(this.store, id);
    this.session?.close();
    this.session = session;
    this.current = null;
    session.onChange((event) => this.onSessionEvent(event));
    prefs.set("notebook", id);
    this.els.notebookButton.replaceChildren(h("span", { class: "notebook-title", text: session.title }), h("span", { class: "caret-down", "aria-hidden": "true" }));
    this.els.notebookButton.title = "Notebooks";
    // sections start folded, until the person has chosen otherwise
    this.tree.setNodes(session.tree());
    this.tree.setFolded(this.savedFolds(id));
    await this.openPage(pageName && session.exists(pageName) ? pageName : session.home, { push: false, replace: true });
  }

  /** The sections this person left folded in a notebook, or null if they have never chosen. */
  private savedFolds(id: string): string[] | null {
    try {
      const saved: unknown = JSON.parse(prefs.get(`folded:${id}`) ?? "null");
      return Array.isArray(saved) && saved.every((k) => typeof k === "string") ? (saved as string[]) : null;
    } catch {
      return null;
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.kind !== "structure") return;
    this.linkCache.clear();
    this.tree.setNodes(this.session.tree());
    this.editor?.refreshLinks();
    if (this.current) {
      this.renderBreadcrumb();
      this.renderBacklinks();
      this.renderActions();
    }
  }

  private toggleNotebookMenu(): void {
    const open = this.els.notebookMenu.hidden;
    if (!open) return this.closeNotebookMenu();
    void this.store.listNotebooks().then((notebooks) => {
      const item = (text: string, onClick: () => void, extra: Record<string, unknown> = {}) =>
        h("button", { type: "button", role: "menuitem", class: "menu-item", text, on: { click: () => { this.closeNotebookMenu(); onClick(); } }, ...extra });
      clear(this.els.notebookMenu);
      for (const notebook of notebooks) {
        this.els.notebookMenu.append(item(notebook.title, () => void this.openNotebook(notebook.id), { role: "menuitemradio", "aria-checked": String(notebook.id === this.session.info.id) }));
      }
      this.els.notebookMenu.append(
        h("hr", {}),
        item("New notebook…", () => void this.newNotebook()),
        item("Rename notebook…", () => void this.renameNotebook()),
        item("Import a folder…", () => this.els.folderInput.click()),
        item("Import a zip…", () => this.els.zipInput.click()),
        item("Export notebook (zip)", () => this.exportNotebook()),
        h("hr", {}),
        item("Delete notebook…", () => void this.deleteNotebook(), { class: "menu-item danger-text" }),
      );
      this.els.notebookMenu.hidden = false;
      this.els.notebookButton.setAttribute("aria-expanded", "true");
      (this.els.notebookMenu.querySelector("button") as HTMLElement | null)?.focus();
    });
  }

  private closeNotebookMenu(): void {
    this.els.notebookMenu.hidden = true;
    this.els.notebookButton.setAttribute("aria-expanded", "false");
  }

  private async newNotebook(): Promise<void> {
    await showDialog({
      title: "New notebook",
      fields: [{ name: "title", label: "Name", value: "My notebook", validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      choices: [{ name: "start", label: "Start with", value: "empty", options: [{ value: "empty", label: "An empty notebook" }, { value: "sample", label: "The sample notebook" }] }],
      confirm: "Create",
      submit: async (values) => {
        const title = String(values.title).trim();
        const info = values.start === "sample" ? await createSampleNotebook(this.store, title) : await createEmptyNotebook(this.store, title);
        await this.openNotebook(info.id);
      },
    });
  }

  private async renameNotebook(): Promise<void> {
    await showDialog({
      title: "Rename notebook",
      fields: [{ name: "title", label: "Name", value: this.session.title, validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      confirm: "Rename",
      submit: async (values) => {
        await this.session.setTitle(String(values.title).trim());
        this.els.notebookButton.replaceChildren(h("span", { class: "notebook-title", text: this.session.title }), h("span", { class: "caret-down", "aria-hidden": "true" }));
      },
    });
  }

  private async deleteNotebook(): Promise<void> {
    const title = this.session.title;
    await showDialog({
      title: "Delete notebook",
      body: [h("p", {}, "Delete ", h("strong", { text: title }), ` and its ${this.session.pageCount} pages from this browser? This can't be undone. Export it first if you may want it back.`)],
      confirm: "Delete notebook",
      danger: true,
      submit: async () => {
        const id = this.session.info.id;
        await this.flush();
        await this.store.deleteNotebook(id);
        const rest = await this.store.listNotebooks();
        const next = rest[0] ?? (await createEmptyNotebook(this.store, "My notebook"));
        await this.openNotebook(next.id);
        this.say(`Deleted the notebook ${title}.`);
      },
    });
  }

  private exportNotebook(): void {
    void this.flush().then(() => {
      const zip = createZip(this.session.exportFiles());
      const slug = this.session.title.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "notebook";
      this.download(`${slug}.zip`, zip, "application/zip");
      this.say(`Exported ${this.session.pageCount} pages as ${slug}.zip. Unzip it and open the folder in Zim, or import it again here.`);
    });
  }

  private downloadPage(): void {
    if (!this.current) return;
    void this.flush().then(() => {
      const entry = this.session.exportPage(this.current?.name ?? "");
      if (!entry) return;
      this.download(entry.path.split("/").pop() ?? "page.txt", entry.bytes, "text/plain;charset=utf-8");
    });
  }

  private download(fileName: string, bytes: Uint8Array, type: string): void {
    const link = h("a", { href: URL.createObjectURL(new Blob([bytes as BlobPart], { type })), download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  // ------------------------------------------------------------------------------------------
  // importing

  private async readPickedFiles(input: HTMLInputElement, kind: "folder" | "zip"): Promise<void> {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (picked.length === 0) return;
    this.say("Reading files…");
    try {
      let files: ImportedFile[];
      let suggested: string;
      if (kind === "zip") {
        const zip = picked[0] as File;
        files = (await readZip(new Uint8Array(await zip.arrayBuffer()))).map((e) => ({ path: e.path, bytes: e.bytes }));
        suggested = zip.name.replace(/\.zip$/i, "");
      } else {
        files = await Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified })));
        suggested = (picked[0]?.webkitRelativePath ?? "").split("/")[0] || "Imported notebook";
      }
      await this.confirmImport(pagesFromFiles(files), suggested);
    } catch (error) {
      this.say("");
      await showMessage("That couldn't be imported", error instanceof Error ? error.message : String(error));
    }
  }

  private async confirmImport(imported: Imported, suggested: string): Promise<void> {
    if (imported.pages.length === 0) {
      this.say("");
      await showMessage("No pages found", "There are no Zim pages (.txt files) in what you chose.", imported.skipped.length ? `${imported.skipped.length} files were skipped, for example ${imported.skipped[0]?.path}: ${imported.skipped[0]?.reason}.` : null);
      return;
    }
    const replacing = imported.pages.filter((p) => this.session.has(p.name)).length;
    const lines: Array<string | HTMLElement> = [`${imported.pages.length} pages`];
    if (imported.attachments) lines.push(`${imported.attachments} other files (images and attachments) are not imported yet`);
    const skipped = h("ul", { class: "skipped" }, ...imported.skipped.slice(0, 6).map((s) => h("li", { text: `${s.path}: ${s.reason}` })));
    if (imported.skipped.length > 6) skipped.append(h("li", { text: `… and ${imported.skipped.length - 6} more` }));
    await showDialog({
      title: "Import notebook",
      body: [h("p", { text: lines.join("; ") + "." }), imported.skipped.length ? h("div", {}, h("p", { text: `${imported.skipped.length} files were skipped:` }), skipped) : null],
      fields: [{ name: "title", label: "Notebook name", value: imported.config.name ?? suggested, validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      choices: [{ name: "into", label: "Import as", value: "new", options: [{ value: "new", label: "A new notebook" }, { value: "here", label: `More pages in ${this.session.title}${replacing ? ` (replaces ${replacing} pages with the same names)` : ""}` }] }],
      confirm: "Import",
      submit: async (values) => {
        await this.flush();
        if (values.into === "here") {
          await this.session.addPages(imported.pages);
          await this.syncCurrentPage();
          this.say(`Imported ${imported.pages.length} pages into ${this.session.title}.`);
          return;
        }
        const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
        const wanted = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
        const info = await this.store.createNotebook({ title: String(values.title).trim(), home: wanted, kind: "open" }, imported.pages);
        await this.openNotebook(info.id);
        this.say(`Imported ${imported.pages.length} pages as ${info.title}.`);
      },
    });
  }

  // ------------------------------------------------------------------------------------------
  // pages

  /**
   * Show a page. One that doesn't exist yet is shown as a new page would start (header and title) and
   * only comes into being when something is typed in it. `anchor` scrolls to a heading or anchor.
   */
  async openPage(name: string, options: { anchor?: string; push?: boolean; replace?: boolean; focus?: boolean; closeSidebar?: boolean } = {}): Promise<void> {
    const ticket = ++this.navigation;
    await this.flush();
    if (ticket !== this.navigation) return;
    let spelled: string;
    try {
      spelled = this.session.spell(name);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
      return;
    }
    const exists = this.session.has(spelled);
    const text = exists ? (this.session.text(spelled) as string) : newPageText(spelled, zimTimestamp());
    this.loading = true;
    this.linkCache.clear();
    this.current = { name: spelled, exists };
    this.editor.setText(text);
    this.loading = false;
    this.dirty = false;
    this.editor.goTo(exists ? 0 : text.length, { scroll: false });
    this.els.page.scrollTop = 0;
    if (options.push && location.hash !== hashFor(spelled)) history.pushState(null, "", hashFor(spelled));
    else if (options.replace) history.replaceState(null, "", hashFor(spelled));

    document.title = `${spelled.split(":").pop()} — ${this.session.title}`;
    this.tree.setCurrent(spelled);
    this.renderBreadcrumb();
    this.renderBacklinks();
    this.renderActions();
    this.renderNotice();
    this.setSaveState("");
    if (options.anchor) this.scrollToAnchor(options.anchor);
    if (options.focus) this.editor.focus();
    if (options.closeSidebar) this.closeSidebarIfNarrow();
    this.say("");
  }

  private renderBreadcrumb(): void {
    clear(this.els.breadcrumb);
    if (!this.current) return;
    const parts = this.current.name.split(":");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join(":");
      if (i > 0) this.els.breadcrumb.append(h("span", { class: "crumb-sep", "aria-hidden": "true", text: "›" }));
      if (i === parts.length - 1) this.els.breadcrumb.append(h("span", { class: "crumb current", "aria-current": "page", text: part }));
      else this.els.breadcrumb.append(h("button", { type: "button", class: "crumb", text: part, on: { click: () => void this.openPage(path, { push: true }) } }));
    });
  }

  private renderActions(): void {
    const exists = !!this.current && this.session.exists(this.current.name);
    this.els.rename.disabled = !exists;
    this.els.remove.disabled = !exists;
    this.els.download.disabled = !this.current?.exists;
    this.els.subpage.disabled = !this.current;
  }

  private renderNotice(): void {
    if (this.current && !this.current.exists) {
      const section = this.session.exists(this.current.name);
      this.showNotice(section ? "This is a section: it has pages below it but no text of its own. Type to give it some." : "This page doesn't exist yet. Type to create it.");
    } else if (this.keptInMemory) {
      this.showNotice("This browser won't keep notebooks for this site, so what you write is lost when the tab closes. Use Export in the notebook menu to keep a copy.");
    } else this.els.notice.hidden = true;
  }

  private showNotice(text: string): void {
    this.els.notice.textContent = text;
    this.els.notice.hidden = false;
  }

  private renderBacklinks(): void {
    clear(this.els.backlinkList);
    const links: Backlink[] = this.current ? this.session.backlinks(this.current.name) : [];
    this.els.backlinkCount.textContent = `(${links.length})`;
    if (links.length === 0) {
      this.els.backlinkList.append(h("li", { class: "none", text: "No other page links here." }));
      return;
    }
    for (const link of links) {
      this.els.backlinkList.append(
        h("li", {}, h("button", { type: "button", class: "link-button", text: link.from, on: { click: () => void this.openPage(link.from, { push: true }) } }), link.count > 1 ? h("span", { class: "count", text: ` ×${link.count}` }) : null, h("div", { class: "context", text: link.context })),
      );
    }
  }

  /** Draws a link's page as existing or missing, from where the open page is. */
  private linkStatus(target: string): LinkStatus {
    const cached = this.linkCache.get(target);
    if (cached) return cached;
    let status: LinkStatus = "other";
    if (this.session && this.current) {
      const resolved = this.session.resolve(this.current.name, target);
      if (resolved.kind === "page") status = resolved.exists || resolved.page.toLowerCase() === this.current.name.toLowerCase() ? "exists" : "missing";
    }
    this.linkCache.set(target, status);
    return status;
  }

  private async followLink(link: LinkInfo): Promise<void> {
    if (!this.current) return;
    switch (link.kind) {
      case "page":
      case "anchor": {
        const resolved = this.session.resolve(this.current.name, link.target);
        if (resolved.kind === "page") await this.openPage(resolved.page, { anchor: resolved.anchor ?? undefined, push: true, focus: true });
        else if (resolved.kind === "anchor") this.scrollToAnchor(resolved.anchor);
        else if (resolved.kind === "invalid") this.say(resolved.reason);
        break;
      }
      case "url": {
        let url: URL | null = null;
        try {
          url = new URL(link.target);
        } catch {
          // not an address
        }
        if (url && OPENABLE_PROTOCOLS.has(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
        else this.say(`Not opening ${link.target}: only http, https and ftp addresses are opened from a page.`);
        break;
      }
      case "email":
        if (/^mailto:/i.test(link.target)) window.location.href = link.target;
        break;
      case "file":
        this.say(`${link.target} is a link to a file, which can't be opened from a browser (yet).`);
        break;
      case "interwiki":
        this.say(`${link.target} is an interwiki link; this notebook has no list of sites for it to use.`);
        break;
      default:
        this.say("That link leads nowhere.");
    }
  }

  private scrollToAnchor(id: string): void {
    const anchors = anchorsIn(this.editor.getText());
    const wanted = id.trim();
    const found = anchors.find((a) => a.id === wanted) ?? anchors.find((a) => a.id.toLowerCase() === wanted.toLowerCase());
    if (found) this.editor.goTo(found.at, { focus: true });
    else this.say(`There is no heading or anchor called #${wanted} on this page.`);
  }

  // ------------------------------------------------------------------------------------------
  // writing

  private onEditorChange(): void {
    if (this.loading || !this.current) return;
    this.dirty = true;
    this.setSaveState("Editing…");
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  private setSaveState(text: string): void {
    this.els.saveState.textContent = text;
  }

  /** Put what is on screen where a page that is closing can still put it, if the notebook doesn't have it yet. */
  private keepDraft(): void {
    if (!this.current || !this.session || !(this.dirty || this.saving > 0 || this.saveFailed)) return;
    const draft: Draft = { notebook: this.session.info.id, name: this.current.name, text: this.editor.getText(), at: Date.now() };
    prefs.set("draft", JSON.stringify(draft));
  }

  /** Put a draft left by a page that closed with typing unsaved into the notebook, unless the notebook already has something newer. */
  private async recoverDraft(draft: Draft): Promise<void> {
    const stored = this.session.text(draft.name);
    const modified = this.session.modified(draft.name);
    if (stored === draft.text || (modified !== undefined && modified > draft.at)) {
      prefs.remove("draft");
      return;
    }
    try {
      await this.session.save(draft.name, draft.text);
    } catch (error) {
      this.say(`Couldn't save what you were typing in ${draft.name} when the page closed (${error instanceof Error ? error.message : String(error)}). It is kept, and will be tried again.`);
      return;
    }
    prefs.remove("draft");
    if (this.current && this.current.name.toLowerCase() === draft.name.toLowerCase()) await this.syncCurrentPage();
    this.say(`Kept what you were typing in ${draft.name} when the page closed.`);
  }

  /** Write what has been typed to the notebook now. Resolves when everything started so far is written (or has failed). */
  flush(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    if (this.dirty && this.current && this.session) {
      const { name } = this.current;
      const text = this.editor.getText();
      this.dirty = false;
      const session = this.session;
      this.saving++;
      this.saveChain = this.saveChain.then(async () => {
        try {
          await session.save(name, text);
          this.saveFailed = false;
          if (this.current && this.current.name === name) {
            const wasNew = !this.current.exists;
            this.current.exists = true;
            if (wasNew) {
              this.renderActions();
              this.renderNotice();
            }
          }
          this.setSaveState("Saved");
        } catch (error) {
          this.saveFailed = true;
          this.dirty = true;
          this.setSaveState("Not saved");
          this.say(`Couldn't save ${name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.saving--;
          if (!this.dirty && this.saving === 0 && !this.saveFailed) prefs.remove("draft");
        }
      });
    }
    return this.saveChain;
  }

  /** Ask for a page name and make the page; `prefix` starts the name in the section it belongs in. */
  async newPage(prefix = ""): Promise<void> {
    const created = await showDialog({
      title: "New page",
      body: ["Use a colon to put the page in a section: Projects:Garden:Plan."],
      fields: [{ name: "name", label: "Page name", value: prefix, validate: (value) => this.checkNewName(value) }],
      confirm: "Create",
      submit: async (values) => {
        await this.flush();
        const name = await this.session.create(String(values.name));
        await this.openPage(name, { push: true });
      },
    });
    // A closing dialog gives the focus back to what had it, but a new page is for writing in.
    if (created) this.editor.goTo(this.editor.getText().length, { focus: true, scroll: false });
  }

  private checkNewName(value: string): string | null {
    if (!value.trim() || value.trim().endsWith(":") || value.trim() === ":") return "Type the name of the page.";
    const parsed = checkPageName(value);
    if ("error" in parsed) return parsed.error;
    return this.session.has(parsed.name) ? `A page called ${this.session.spell(parsed.name)} already exists.` : null;
  }

  async renamePage(): Promise<void> {
    if (!this.current) return;
    await this.flush();
    const from = this.current.name;
    const below = this.session.names().filter((n) => n.toLowerCase().startsWith(`${from.toLowerCase()}:`)).length;
    await showDialog({
      title: "Rename page",
      body: [below > 0 ? `The ${below} page${below === 1 ? "" : "s"} below it move${below === 1 ? "s" : ""} with it.` : "Use a colon to move the page into another section."],
      fields: [{ name: "name", label: "New name", value: from, validate: (value) => { const p = checkPageName(value); return "error" in p ? p.error : null; } }],
      checks: [{ name: "links", label: "Update the links to this page", checked: true }],
      confirm: "Rename",
      submit: async (values) => {
        const report = await this.session.rename(from, String(values.name), Boolean(values.links));
        const moved = report.moved.find(([old]) => old.toLowerCase() === from.toLowerCase());
        const mine = this.current ? report.moved.find(([old]) => old.toLowerCase() === this.current?.name.toLowerCase()) : undefined;
        if (this.current && mine) this.current.name = mine[1];
        // links are judged from the page they are on, and this page has a new name
        this.linkCache.clear();
        this.editor.refreshLinks();
        await this.refreshCurrentText();
        this.tree.setCurrent(this.current?.name ?? null);
        history.replaceState(null, "", hashFor(this.current?.name ?? from));
        this.renderBreadcrumb();
        this.renderBacklinks();
        document.title = `${(this.current?.name ?? from).split(":").pop()} — ${this.session.title}`;
        this.say(`Renamed ${from} to ${moved?.[1] ?? String(values.name)}${report.linksChanged ? `; ${report.linksChanged} link${report.linksChanged === 1 ? "" : "s"} updated on ${report.rewritten.length} page${report.rewritten.length === 1 ? "" : "s"}` : ""}.`);
      },
    });
  }

  /** After pages were put into the notebook from outside (an import): the page shown may be one of them. */
  private async syncCurrentPage(): Promise<void> {
    if (!this.current) return;
    this.current.exists = this.session.has(this.current.name);
    await this.refreshCurrentText();
    this.renderActions();
    this.renderNotice();
  }

  /** The page shown may have been rewritten (a rename changes links on it): show what the notebook has now. */
  private async refreshCurrentText(): Promise<void> {
    if (!this.current || !this.current.exists) return;
    const text = this.session.text(this.current.name);
    if (text === undefined || text === this.editor.getText()) return;
    const caret = this.editor.view.state.selection.main.head;
    this.loading = true;
    this.editor.setText(text);
    this.loading = false;
    this.dirty = false;
    this.editor.goTo(Math.min(caret, text.length), { scroll: false });
  }

  async deletePage(): Promise<void> {
    if (!this.current) return;
    await this.flush();
    const name = this.current.name;
    const below = this.session.names().filter((n) => n.toLowerCase().startsWith(`${name.toLowerCase()}:`)).length;
    await showDialog({
      title: "Delete page",
      body: [h("p", {}, "Delete ", h("strong", { text: name }), below ? ` and the ${below} page${below === 1 ? "" : "s"} below it` : "", "? This can't be undone."), "Links to deleted pages will show as missing."],
      confirm: below ? `Delete ${below + 1} pages` : "Delete page",
      danger: true,
      submit: async () => {
        const removed = await this.session.delete(name);
        const parent = name.includes(":") ? name.slice(0, name.lastIndexOf(":")) : null;
        await this.openPage(parent && this.session.exists(parent) ? parent : this.session.home, { push: true });
        this.say(`Deleted ${removed.length} page${removed.length === 1 ? "" : "s"}.`);
      },
    });
  }

  // ------------------------------------------------------------------------------------------
  // search

  private runSearch(query: string): void {
    const q = query.trim();
    if (!q) return this.closeSearch();
    this.searchHits = this.session.search(q, 20);
    this.searchActive = this.searchHits.length ? 0 : -1;
    const box = this.els.searchResults;
    clear(box);
    if (this.searchHits.length === 0) {
      box.append(h("div", { class: "search-none", text: `No page has all of: ${q}` }));
    }
    this.searchHits.forEach((hit, i) => {
      box.append(
        h("div", { id: `result-${i}`, role: "option", class: `result${i === this.searchActive ? " active" : ""}`, "aria-selected": String(i === this.searchActive), on: { mousedown: (e) => { e.preventDefault(); void this.chooseResult(i); }, mousemove: () => this.setActiveResult(i) } }, h("div", { class: "result-name" }, ...highlighted(hit.page, q)), h("div", { class: "result-snippet" }, ...highlighted(hit.snippet, q))),
      );
    });
    box.hidden = false;
    this.els.search.setAttribute("aria-expanded", "true");
  }

  private setActiveResult(index: number): void {
    this.searchActive = index;
    this.els.searchResults.querySelectorAll(".result").forEach((el, i) => {
      el.classList.toggle("active", i === index);
      el.setAttribute("aria-selected", String(i === index));
    });
    this.els.search.setAttribute("aria-activedescendant", index >= 0 ? `result-${index}` : "");
    this.els.searchResults.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  private onSearchKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (this.els.searchResults.hidden) return;
      event.preventDefault();
      const n = this.searchHits.length;
      if (n) this.setActiveResult((this.searchActive + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (this.searchActive >= 0) void this.chooseResult(this.searchActive);
    } else if (event.key === "Escape") {
      this.els.search.value = "";
      this.closeSearch();
      this.els.search.blur();
    }
  }

  private async chooseResult(index: number): Promise<void> {
    const hit = this.searchHits[index];
    if (!hit) return;
    this.closeSearch();
    await this.openPage(hit.page, { push: true, focus: true, closeSidebar: true });
  }

  private closeSearch(): void {
    this.els.searchResults.hidden = true;
    this.els.search.setAttribute("aria-expanded", "false");
    this.searchHits = [];
    this.searchActive = -1;
  }
}
