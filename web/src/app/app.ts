// The notebook app: a page tree, the editor, search, backlinks, and everything that changes a notebook
// (new page, rename, delete, import, export), over a NotebookSession. The notebook's rules are the
// Rust ones in wasm; the pages live in a store; this file is only the interface between a person and
// those.
import { createZimEditor } from "../editor";
import type { ImageSource, LinkInfo, LinkStatus, ZimEditor } from "../editor";
import { anchorsIn, checkPageName, classifyLink, newPageText, pageKey, zimTimestamp } from "../notebook-core";
import type { Backlink, SearchHit } from "../notebook-core";
import { FileUrls } from "../notebook/file-urls";
import { IndexedDbStore } from "../notebook/idb";
import { attachmentName, formatSize, isImageType, pictureAddress } from "../notebook/media";
import { RoutedStore, isEncryptedId } from "../notebook/routed-store";
import { createSampleNotebook } from "../notebook/sample";
import { NotebookSession, createEmptyNotebook } from "../notebook/session";
import type { SessionEvent } from "../notebook/session";
import { MemoryStore } from "../notebook/store";
import type { FileInfo, NotebookInfo, NotebookStore } from "../notebook/store";
import { isReadToImport, pagesFromFiles } from "../notebook/zim-files";
import type { Imported, ImportedFile } from "../notebook/zim-files";
import { NoVaultError, Vault, VaultBusyError, VaultExistsError, VaultUnavailableError, WrongPassphraseError, checkPassphrase, vaultSupport } from "../vault";
import type { VaultEvent } from "../vault";
import { TurtlStore } from "../vault/turtl-store";
import { createZip, readZip } from "../zip";
import { closeAllDialogs, showDialog, showMessage } from "./dialogs";
import type { Phase, Pwa } from "../pwa/register";
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
/** An encrypted notebook has no draft kept anywhere outside the vault for a closing page to rescue, so what is typed goes in sooner. */
const PRIVATE_SAVE_DELAY_MS = 250;

/** How long an unlocked vault is left without anyone touching the app before it locks itself. */
const AUTO_LOCK_MS = 30 * 60_000;

/** How long locking waits for what was typed to be saved (ms). */
const SETTLE_MS = 3000;

/** What the tab and the address say while an encrypted notebook is open: nothing that is in it (they are kept in the browser's history). */
const PRIVATE_TITLE = "Encrypted notebook";
const PRIVATE_ADDRESS = "#/";

/** "1 page", "2 pages". */
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The start of a version's id, as much as is shown beside a name. */
const shortId = (id: string): string => id.slice(0, 8);

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

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
  private readonly vault: Vault;
  private readonly keptInMemory: boolean;
  /** The pages visited in an encrypted notebook, by the number the browser's history holds for each: names stay in memory, never in the address. */
  private readonly trail = new Map<number, { notebook: string; name: string }>();
  private trailCounter = 0;
  /** The vault is being locked (or was lost) and the screen is being changed for it: nothing more is to be done about a second lock, or a second loss. */
  private locking = false;
  /** The page was left with the vault unlocked (and may be shown again as it was, by the browser's cache). */
  private leftUnlocked = false;
  /** The person has been asked whether to lock and lose what could not be saved, and has not answered. */
  private askingToLose = false;
  /** What the service worker says (see pwa/): which version runs, and whether another waits to be approved. */
  private pwa: Pwa | null = null;
  private pwaPhase: Phase | null = null;
  /** The new version that the person said "Not now" to, so that it is not offered again on this page. */
  private updateDismissedFor: string | null = null;
  private toldReplaced = false;
  /** How long the vault may be left alone (ms). A field so that a test can shorten it. */
  autoLockMs = AUTO_LOCK_MS;
  private autoLockTimer: number | undefined;
  private readonly tree: TreeView;
  private readonly linkCache = new Map<string, LinkStatus>();
  /** Addresses for the pictures of the open notebook. */
  private urls: FileUrls | null = null;
  private stopListening: (() => void) | null = null;
  private warning: string | null = null;
  /** Something wrong with the encrypted notebooks, said until they are locked (what it says is no use to the next time they are unlocked). */
  private vaultWarning: string | null = null;
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
    lock: HTMLButtonElement;
    search: HTMLInputElement;
    searchResults: HTMLElement;
    markup: HTMLInputElement;
    breadcrumb: HTMLElement;
    notice: HTMLElement;
    updateBanner: HTMLElement;
    updateText: HTMLElement;
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
    attach: HTMLButtonElement;
    attachInput: HTMLInputElement;
    attachments: HTMLDetailsElement;
    attachmentCount: HTMLElement;
    attachmentList: HTMLElement;
    folderInput: HTMLInputElement;
    zipInput: HTMLInputElement;
  };

  private constructor(root: HTMLElement, store: NotebookStore, keptInMemory: boolean, vault: Vault) {
    this.store = store;
    this.vault = vault;
    this.keptInMemory = keptInMemory;
    this.tree = new TreeView({
      onOpen: (name) => void this.openPage(name, { push: true, closeSidebar: true }),
      // (which sections are folded is the names of pages: an encrypted notebook's are not kept outside it)
      onFoldChange: (folded) => !this.isPrivate && prefs.set(`folded:${this.session?.info.id}`, JSON.stringify([...folded])),
    });
    this.els = this.build(root);
    vault.onChange((event) => this.onVaultChange(event));
    // anything a person does counts as using the app, and the vault locks itself when nobody has for a while
    for (const type of ["keydown", "pointerdown", "wheel", "touchstart"]) document.addEventListener(type, () => this.restartAutoLock(), { capture: true, passive: true });
  }

  /** Open the notebook storage, build the interface, and open the last notebook (the sample one the first time). */
  static async start(root: HTMLElement): Promise<App> {
    let store: NotebookStore;
    let keptInMemory = false;
    let app: App | undefined;
    const vault = new Vault();
    try {
      store = await IndexedDbStore.open(pageKey, undefined, {
        // an older version of this app, open in another tab, holds the database and must let go before it can be upgraded
        onBlocked: () => root.replaceChildren(h("p", { class: "loading", text: "This app is open in another tab, in an older version. Close that tab, or reload it, and this one will go on." })),
        // and the other way round: another tab wants a newer version of the database
        onVersionChange: () => app?.warn("This app was updated in another tab. Reload this page to go on (what you typed is kept)."),
      });
      void IndexedDbStore.requestPersistence();
    } catch {
      store = new MemoryStore(pageKey);
      keptInMemory = true;
    }
    // the encrypted notebooks are another store, in the vault, which is there to be unlocked
    const sealed = new TurtlStore(() => vault.core, pageKey);
    vault.onChange((event) => event.kind !== "unlocked" && sealed.reset());
    store = new RoutedStore(store, sealed, () => vault.unlocked, (error) => app?.warnAboutVault(`The encrypted notebooks can't be read at the moment (${error.message}). Lock them and unlock them again.`));
    app = new App(root, store, keptInMemory, vault);
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
    const lock = h("button", { type: "button", class: "lock-button", hidden: true, text: "Lock", title: "Lock the encrypted notebooks: the passphrase is needed to open them again", on: { click: () => void this.lockVault() } });
    const search = h("input", { id: "search", type: "search", class: "search-input", placeholder: "Search pages   ( / )", "aria-label": "Search pages", role: "combobox", "aria-expanded": "false", "aria-controls": "search-results", "aria-autocomplete": "list", autocomplete: "off", spellcheck: "false" });
    const searchResults = h("div", { id: "search-results", class: "search-results", role: "listbox", hidden: true, "aria-label": "Search results" });
    const markup = h("input", { id: "markup", type: "checkbox", on: { change: () => { this.editor.setShowMarkup(markup.checked); prefs.set("markup", markup.checked ? "1" : "0"); } } });
    const folderInput = h("input", { type: "file", hidden: true, multiple: true, webkitdirectory: true, "aria-label": "Choose a notebook folder" });
    const zipInput = h("input", { type: "file", hidden: true, accept: ".zip,application/zip", "aria-label": "Choose a zip file" });

    const breadcrumb = h("nav", { class: "breadcrumb", "aria-label": "Page path" });
    const rename = h("button", { type: "button", text: "Rename", on: { click: () => void this.renamePage() } });
    const subpage = h("button", { type: "button", text: "New sub-page", on: { click: () => void this.newPage(this.current ? `${this.current.name}:` : "") } });
    const attachInput = h("input", { type: "file", hidden: true, multiple: true, "aria-label": "Choose files to attach to this page", on: { change: () => { const files = [...(attachInput.files ?? [])]; attachInput.value = ""; if (files.length) void this.attachFiles(files); } } });
    const attach = h("button", { type: "button", text: "Attach…", title: "Attach files or pictures to this page (you can also drop them on the page, or paste a picture)", on: { click: () => attachInput.click() } });
    const download = h("button", { type: "button", text: "Download", title: "Download this page as a .txt file", on: { click: () => this.downloadPage() } });
    const remove = h("button", { type: "button", class: "danger-text", text: "Delete", on: { click: () => void this.deletePage() } });
    const notice = h("div", { class: "notice", role: "status", hidden: true });
    const updateText = h("span", { class: "update-text" });
    const updateBanner = h(
      "div",
      { class: "update-banner", role: "status", hidden: true },
      updateText,
      h("button", { type: "button", class: "primary", text: "Update…", on: { click: () => void this.updateDialog() } }),
      h("button", { type: "button", text: "Not now", on: { click: () => this.dismissUpdate() } }),
    );
    const editorHost = h("div", { id: "editor", class: "editor-host" });
    const attachmentCount = h("span", { class: "count" });
    const attachmentList = h("ul", { class: "attachment-list" });
    const attachments = h("details", { class: "attachments", open: true, hidden: true }, h("summary", {}, "Attachments ", attachmentCount), attachmentList);
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
    const page = h("main", { class: "page" }, h("div", { class: "pagebar" }, breadcrumb, h("div", { class: "page-actions" }, rename, subpage, attach, download, remove)), updateBanner, notice, editorHost, attachments, backlinks);

    root.append(
      h(
        "div",
        { class: "app", "data-sidebar": window.matchMedia("(max-width: 48rem)").matches ? "closed" : prefs.get("sidebar") === "closed" ? "closed" : "open" },
        h("header", { class: "topbar" }, sidebarToggle, h("div", { class: "notebook-menu" }, notebookButton, notebookMenu), lock, h("div", { class: "search" }, search, searchResults), button("New page", { class: "primary", on: { click: () => void this.newPage(this.current?.name.includes(":") ? `${this.current.name.slice(0, this.current.name.lastIndexOf(":") + 1)}` : "") } }), h("label", { class: "check", for: "markup" }, markup, " Show markup")),
        sidebar,
        page,
        h("footer", { class: "statusbar" }, status, saveState),
        folderInput,
        zipInput,
        attachInput,
      ),
    );

    markup.checked = prefs.get("markup") === "1";
    this.editor = createZimEditor(editorHost, "", {
      showMarkup: markup.checked,
      linkStatus: (target) => this.linkStatus(target),
      imageSource: (path) => this.imageSource(path),
      onFiles: (files, at) => void this.attachFiles(files, at),
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
    window.addEventListener("pagehide", (event) => {
      leaving();
      // The browser may keep this page just as it is (`persisted`), to show it again when someone comes back to
      // it (what Back does): unlocked, with the notebook on the screen. What is on the screen is hidden until
      // then, and the vault is locked when the page is shown. (A page that is closed for good needs nothing.)
      if (event.persisted && this.vault.unlocked) {
        this.leftUnlocked = true;
        this.setLocking(true);
      }
    });
    window.addEventListener("pageshow", (event) => {
      if (!this.leftUnlocked) return;
      this.leftUnlocked = false;
      if (event.persisted) void this.lockVault("away");
      else this.setLocking(false);
    });
    window.addEventListener("beforeunload", (e) => {
      // Typing that is on its way to the store is safe (see keepDraft); typing the store refused is not.
      if (this.saveFailed) e.preventDefault();
    });
    window.addEventListener("popstate", (event: PopStateEvent) => {
      const traced = (event.state as { trail?: unknown } | null)?.trail;
      let name: string | null;
      if (typeof traced === "number") {
        // an encrypted notebook's page: only its number is in the history, and only this notebook can say whose
        const step = this.trail.get(traced);
        name = step && step.notebook === this.session?.info.id ? step.name : null;
      } else name = this.isPrivate ? null : pageFromHash();
      if (name && (!this.current || name !== this.current.name)) void this.openPage(name, { push: false });
    });

    // Files dropped on the page are attached to it (the editor takes those dropped on the text, and says
    // where); and a file dropped anywhere must never make the browser leave the app to show it.
    const filesDragged = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    let dragDepth = 0;
    const stopDropping = () => {
      dragDepth = 0;
      page.classList.remove("dropping");
    };
    page.addEventListener("dragenter", (e) => {
      if (!filesDragged(e)) return;
      dragDepth++;
      page.classList.add("dropping");
    });
    page.addEventListener("dragleave", (e) => {
      if (filesDragged(e) && --dragDepth <= 0) stopDropping();
    });
    page.addEventListener("dragover", (e) => {
      if (!filesDragged(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    page.addEventListener("drop", (e) => {
      stopDropping();
      if (!e.defaultPrevented && filesDragged(e)) {
        e.preventDefault();
        void this.attachFiles([...(e.dataTransfer?.files ?? [])], "end");
      }
    });
    window.addEventListener("dragover", (e) => filesDragged(e) && e.preventDefault());
    window.addEventListener("drop", (e) => filesDragged(e) && e.preventDefault());

    folderInput.addEventListener("change", () => void this.readPickedFiles(folderInput, "folder"));
    zipInput.addEventListener("change", () => void this.readPickedFiles(zipInput, "zip"));

    return { root, page, sidebarToggle, notebookButton, notebookMenu, lock, search, searchResults, markup, breadcrumb, notice, updateBanner, updateText, editorHost, backlinks, backlinkCount, backlinkList, status, saveState, rename, subpage, download, remove, attach, attachInput, attachments, attachmentCount, attachmentList, folderInput, zipInput };
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
    const previous = this.session;
    this.stopListening?.();
    this.urls?.close();
    this.session = session;
    this.urls = new FileUrls(session, () => {
      this.editor?.refreshLinks();
      this.renderAttachments();
    });
    this.current = null;
    this.stopListening = session.onChange((event) => this.onSessionEvent(event));
    // The notebook that was open finishes whatever it was writing (a file being attached, say), then lets go.
    void previous?.close();
    prefs.set("notebook", id);
    // (an id and nothing else: what to open when the vault is unlocked again)
    if (isEncryptedId(id)) prefs.set("vault-notebook", id);
    this.trail.clear();
    this.renderNotebookButton();
    this.els.notebookButton.title = "Notebooks";
    // sections start folded, until the person has chosen otherwise
    this.tree.setNodes(session.tree());
    this.tree.setFolded(this.savedFolds(id));
    await this.openPage(pageName && session.exists(pageName) ? pageName : session.home, { push: false, replace: true });
  }

  /** Whether the open notebook is an encrypted one: nothing in it may be put anywhere outside the vault (the address, the tab's title, the browser's own storage). */
  private get isPrivate(): boolean {
    return this.session?.info.kind === "encrypted";
  }

  private renderNotebookButton(): void {
    // (a browser that offers to translate the page sends it to a service on the internet; the editor itself is never offered: CodeMirror marks it so)
    document.documentElement.translate = !this.isPrivate;
    const children: Node[] = [h("span", { class: "notebook-title", text: this.session.title })];
    if (this.isPrivate) children.push(h("span", { class: "badge", text: "encrypted" }));
    children.push(h("span", { class: "caret-down", "aria-hidden": "true" }));
    this.els.notebookButton.replaceChildren(...children);
  }

  /**
   * Show which page is open, in the address (so that Back and a bookmark work) and the tab's title. An
   * encrypted notebook's pages are in neither, since both are kept by the browser: the history holds a
   * number, and the title says nothing.
   */
  private locate(name: string, how: "push" | "replace" | "none"): void {
    if (this.isPrivate) {
      document.title = PRIVATE_TITLE;
      if (how === "none") return;
      const number = ++this.trailCounter;
      this.trail.set(number, { notebook: this.session.info.id, name });
      if (how === "push") history.pushState({ trail: number }, "", PRIVATE_ADDRESS);
      else history.replaceState({ trail: number }, "", PRIVATE_ADDRESS);
      return;
    }
    document.title = `${name.split(":").pop()} — ${this.session.title}`;
    if (how === "push" && location.hash !== hashFor(name)) history.pushState(null, "", hashFor(name));
    else if (how === "replace") history.replaceState(null, "", hashFor(name));
  }

  /** The sections this person left folded in a notebook, or null if they have never chosen. */
  private savedFolds(id: string): string[] | null {
    if (isEncryptedId(id)) return null;
    try {
      const saved: unknown = JSON.parse(prefs.get(`folded:${id}`) ?? "null");
      return Array.isArray(saved) && saved.every((k) => typeof k === "string") ? (saved as string[]) : null;
    } catch {
      return null;
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.kind === "files") {
      // pictures and file links may lead somewhere else, or nowhere, now
      this.urls?.sync();
      this.linkCache.clear();
      this.editor?.refreshLinks();
      this.renderAttachments();
      return;
    }
    if (event.kind !== "structure") return;
    this.linkCache.clear();
    this.tree.setNodes(this.session.tree());
    this.editor?.refreshLinks();
    if (this.current) {
      this.renderBreadcrumb();
      this.renderBacklinks();
      this.renderAttachments();
      this.renderActions();
    }
  }

  private toggleNotebookMenu(): void {
    const open = this.els.notebookMenu.hidden;
    if (!open) return this.closeNotebookMenu();
    this.store.listNotebooks().then((notebooks) => {
      const item = (text: string, onClick: () => void, extra: Record<string, unknown> = {}, badge?: string) =>
        h("button", { type: "button", role: "menuitem", class: "menu-item", on: { click: () => { this.closeNotebookMenu(); onClick(); } }, ...extra }, h("span", { text }), badge ? h("span", { class: "badge", text: badge }) : null);
      clear(this.els.notebookMenu);
      for (const notebook of notebooks) {
        this.els.notebookMenu.append(item(notebook.title, () => void this.openNotebook(notebook.id).catch((error: unknown) => this.say(`Couldn't open ${notebook.title}: ${error instanceof Error ? error.message : String(error)}`)), { role: "menuitemradio", "aria-checked": String(notebook.id === this.session.info.id) }, notebook.kind === "encrypted" ? "encrypted" : undefined));
      }
      if (this.vault.unlocked) this.els.notebookMenu.append(h("hr", {}), item("Lock encrypted notebooks", () => void this.lockVault()));
      else if (this.vaultKnown()) this.els.notebookMenu.append(h("hr", {}), item("Unlock encrypted notebooks…", () => void this.unlockFromMenu()));
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
      const pwa = this.pwa;
      if (pwa) {
        this.els.notebookMenu.append(h("hr", {}));
        if (pwa.state.offer) this.els.notebookMenu.append(item(`Update the app (${shortId(pwa.state.offer.id)})…`, () => void this.updateDialog()));
        if (pwa.canInstall) this.els.notebookMenu.append(item("Install the app…", () => void pwa.install()));
        this.els.notebookMenu.append(item("About this version…", () => void this.aboutDialog()));
      }
      this.els.notebookMenu.hidden = false;
      this.els.notebookButton.setAttribute("aria-expanded", "true");
      (this.els.notebookMenu.querySelector("button") as HTMLElement | null)?.focus();
    }).catch((error: unknown) => this.say(`The notebooks can't be listed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private closeNotebookMenu(): void {
    this.els.notebookMenu.hidden = true;
    this.els.notebookButton.setAttribute("aria-expanded", "false");
  }

  private async newNotebook(): Promise<void> {
    await showDialog({
      title: "New notebook",
      fields: [{ name: "title", label: "Name", value: "My notebook", validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      choices: [
        { name: "kind", label: "Kind", value: "open", options: [{ value: "open", label: "Open: plain pages, kept in this browser" }, { value: "encrypted", label: "Encrypted: needs a passphrase to open" }] },
        { name: "start", label: "Start with", value: "empty", options: [{ value: "empty", label: "An empty notebook" }, { value: "sample", label: "The sample notebook" }] },
      ],
      confirm: "Create",
      working: "Creating…",
      submit: async (values) => {
        const title = String(values.title).trim();
        const kind = values.kind === "encrypted" ? "encrypted" : "open";
        if (kind === "encrypted") {
          const problem = await this.prepareVault();
          if (problem) return problem;
        }
        const info = values.start === "sample" ? await createSampleNotebook(this.store, title, kind) : await createEmptyNotebook(this.store, title, "Home", kind);
        await this.openNotebook(info.id);
        if (kind === "encrypted") void this.warnIfNotKept();
      },
    });
  }

  /**
   * Once: the browser has not promised to keep the encrypted notebooks, so they are only as safe as the room on
   * this disk. (It is told when the browser has answered, which may be after a question to the person.)
   */
  private async warnIfNotKept(): Promise<void> {
    if ((await this.vault.kept) !== false || prefs.get("not-kept-told") === "1") return;
    prefs.set("not-kept-told", "1");
    await showMessage(
      "Keep a copy of encrypted notebooks",
      "This browser has not promised to keep what encrypted notebooks hold if the disk runs low on room, and an encrypted notebook that is deleted can't be got back. Export a copy now and then (Export notebook in the menu), and keep it somewhere safe.",
    );
  }

  /**
   * For a dialog that is confirmed some time after it was opened: it was about one notebook, and if that is no
   * longer the open one (the vault was locked, the engine died, another was chosen) it must not act on the one
   * that is. Gives the message to show, or nothing if all is well.
   */
  private stale(session: NotebookSession): string | undefined {
    return this.session === session ? undefined : "That notebook is not open any more: nothing was changed.";
  }

  private async renameNotebook(): Promise<void> {
    const session = this.session;
    await showDialog({
      title: "Rename notebook",
      fields: [{ name: "title", label: "Name", value: session.title, validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      confirm: "Rename",
      submit: async (values) => {
        const stale = this.stale(session);
        if (stale) return stale;
        await session.setTitle(String(values.title).trim());
        this.renderNotebookButton();
      },
    });
  }

  private async deleteNotebook(): Promise<void> {
    const session = this.session;
    const title = session.title;
    await showDialog({
      title: "Delete notebook",
      body: [h("p", {}, "Delete ", h("strong", { text: title }), ` and its ${session.pageCount} pages from this browser? This can't be undone. Export it first if you may want it back.`)],
      confirm: "Delete notebook",
      danger: true,
      submit: async () => {
        const stale = this.stale(session);
        if (stale) return stale;
        const id = session.info.id;
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
    const session = this.session;
    void this.flush().then(async () => {
      if (session.info.kind === "encrypted") {
        const go = await showDialog({
          title: "Export without encryption",
          body: ["The zip file holds this notebook's pages and attachments as ordinary files, and anyone who gets the file can read them. Keep it somewhere safe."],
          confirm: "Export a plain copy",
        });
        if (!go) return;
      }
      try {
        const zip = createZip(await session.exportFiles());
        const slug = session.title.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "notebook";
        this.download(`${slug}.zip`, zip, "application/zip");
        const files = session.fileCount;
        this.say(`Exported ${count(session.pageCount, "page")}${files ? ` and ${count(files, "attachment")}` : ""} as ${slug}.zip. Unzip it and open the folder in Zim, or import it again here.`);
      } catch (error) {
        this.say(`Couldn't export: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    this.downloadBlob(fileName, new Blob([bytes as BlobPart], { type }));
  }

  private downloadBlob(fileName: string, blob: Blob): void {
    // (a file saved from an encrypted notebook is a plain one: the person is told, and an export says more)
    if (this.isPrivate) this.say("Downloaded. That copy is not encrypted: keep it somewhere safe.");
    const link = h("a", { href: URL.createObjectURL(blob), download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  // ------------------------------------------------------------------------------------------
  // encrypted notebooks (the vault)

  /** Whether the vault was made in this browser, as far as is remembered (a hint: asking the vault itself means starting its engine). */
  private vaultKnown(): boolean {
    return prefs.get("vault") === "1";
  }

  private onVaultChange(event: VaultEvent): void {
    this.els.lock.hidden = !this.vault.unlocked;
    this.restartAutoLock();
    if (event.kind === "lost" && !this.locking) void this.vaultLost(event.reason);
  }

  private restartAutoLock(): void {
    window.clearTimeout(this.autoLockTimer);
    if (this.vault.unlocked) this.autoLockTimer = window.setTimeout(() => void this.autoLock(), this.autoLockMs);
  }

  private async autoLock(): Promise<void> {
    await this.lockVault("idle");
  }

  /** The engine that keeps the encrypted notebooks died: they are locked, and what was in flight to them is gone. */
  private async vaultLost(reason: string): Promise<void> {
    // (nobody has locked them: the engine is gone, and the notebook that is shown has nowhere to save to)
    this.locking = true;
    this.setLocking(true);
    let restarting = false;
    try {
      restarting = !(await this.clearLockedScreen());
    } finally {
      this.locking = false;
      if (!restarting) this.setLocking(false);
    }
    if (restarting) return;
    await showMessage("The encrypted notebooks were locked", `Their engine stopped (${reason}), so they are locked. What you typed in the last moments may not have been saved. Unlock them again to go on.`);
  }

  /**
   * Take what is left of the encrypted notebooks off the screen (see `showLockedScreen`). If that can't be done (the
   * notebooks that are not encrypted can't be got, say) the page is started again, which shows nothing of what was
   * open; the answer is whether the screen was changed, and if not, nothing is to be done but wait for that.
   */
  private async clearLockedScreen(): Promise<boolean> {
    try {
      await this.showLockedScreen();
      return true;
    } catch {
      location.reload();
      return false;
    }
  }

  /**
   * After the encrypted notebooks were locked (or lost): nothing of them stays on the screen. A dialog that was open
   * about them is closed, and an encrypted notebook that was open gives way to one that is not (made, if there is
   * none). What was typed in it and had not reached the vault is let go: there is nowhere to save it now.
   */
  private async showLockedScreen(): Promise<void> {
    closeAllDialogs();
    this.closeNotebookMenu();
    // (the pages the history has numbers for were pages of notebooks that are not there any more)
    this.trail.clear();
    this.vaultWarning = null;
    this.renderNotice();
    if (!this.isPrivate) return;
    this.closeSearch();
    this.els.search.value = "";
    // (saves that were in flight fail at once, the engine being gone: they are waited for, so that none comes back to say it failed
    // after the status line was cleared, as opening the next page does, with the name of the page in it)
    this.discardUnsaved();
    await this.saveChain;
    this.discardUnsaved();
    const open = (await this.store.listNotebooks()).filter((n) => n.kind === "open");
    const next = open[0] ?? (await createSampleNotebook(this.store));
    await this.openNotebook(next.id);
  }

  /** Let go of what was typed in the page that is shown and has not been saved. */
  private discardUnsaved(): void {
    window.clearTimeout(this.saveTimer);
    this.dirty = false;
    this.saveFailed = false;
  }

  /** Hide the app while the encrypted notebooks are being locked, so that nothing decrypted is on the screen at the moment they are not there. */
  private setLocking(on: boolean): void {
    this.els.root.querySelector(".app")?.classList.toggle("locking", on);
  }

  /**
   * Get the vault unlocked (or made, the first time) for what is about to be made in it, asking for the
   * passphrase. Null if it is unlocked now, otherwise what to tell the person.
   */
  private async prepareVault(): Promise<string | null> {
    const support = vaultSupport();
    if (!support.ok) return support.reason;
    if (this.vault.unlocked) return null;
    if (this.vaultKnown()) await this.unlockDialog();
    else await this.createDialog();
    return this.vault.unlocked ? null : "Encrypted notebooks need their passphrase.";
  }

  private vaultProblem(error: unknown): string {
    if (error instanceof WrongPassphraseError || error instanceof VaultBusyError || error instanceof VaultUnavailableError || error instanceof NoVaultError) return error.message;
    return `The encrypted notebooks couldn't be opened: ${error instanceof Error ? error.message : String(error)}`;
  }

  /** The first time: choose the passphrase that every encrypted notebook of this browser will be locked with. */
  private createDialog(): Promise<boolean> {
    return showDialog({
      title: "Encrypted notebooks",
      body: [
        "An encrypted notebook is kept scrambled in this browser, and unscrambled only while it is unlocked. The key is made from a passphrase that you choose now, and one passphrase protects every encrypted notebook here.",
        h("p", {}, h("strong", { text: "Nobody can recover this passphrase for you. " }), "If you forget it, the encrypted notebooks are lost for good (the people who made this app can't open them either), so keep it somewhere safe."),
      ],
      fields: [
        { name: "passphrase", label: "Passphrase", type: "password", autocomplete: "new-password", hint: "At least 10 characters. A few unrelated words make a good one.", validate: (v) => (v ? checkPassphrase(v) : "Choose a passphrase.") },
        { name: "again", label: "Passphrase again", type: "password", autocomplete: "new-password", validate: (v, all) => (v === all.passphrase ? null : "The two passphrases are not the same.") },
      ],
      checks: [{ name: "understood", label: "I understand that a forgotten passphrase can't be recovered." }],
      confirm: "Create encrypted notebooks",
      working: "Creating…",
      submit: async (values) => {
        if (!values.understood) return "Tick the box to say you understand that the passphrase can't be recovered.";
        try {
          await this.vault.create(String(values.passphrase));
        } catch (error) {
          if (error instanceof VaultExistsError) {
            // the browser has them already (what remembers that was cleared): that is the vault to unlock
            prefs.set("vault", "1");
            return (await this.unlockDialog()) ? undefined : "The encrypted notebooks that are here need their own passphrase.";
          }
          return this.vaultProblem(error);
        }
        prefs.set("vault", "1");
      },
    });
  }

  /** Ask for the passphrase and unlock the vault. */
  private unlockDialog(): Promise<boolean> {
    return showDialog({
      title: "Unlock encrypted notebooks",
      body: ["Type the passphrase of your encrypted notebooks."],
      fields: [{ name: "passphrase", label: "Passphrase", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Type the passphrase.") }],
      actions: [{ label: "I forgot it…", run: (close) => { close(); void this.eraseDialog(); } }],
      confirm: "Unlock",
      working: "Unlocking…",
      submit: async (values) => {
        try {
          await this.vault.unlock(String(values.passphrase));
        } catch (error) {
          if (error instanceof NoVaultError) prefs.remove("vault");
          return this.vaultProblem(error);
        }
        prefs.set("vault", "1");
      },
    });
  }

  /** For a passphrase that is lost: the only way out is to erase what it protected and start again. */
  private async eraseDialog(): Promise<void> {
    const erased = await showDialog({
      title: "Erase encrypted notebooks",
      body: [
        "Without the passphrase the encrypted notebooks can't be opened, by anyone. The only way to use encrypted notebooks again is to erase these.",
        h("p", {}, h("strong", { text: "This deletes every encrypted notebook in this browser, with its pages and attachments, for good." }), " If you have a copy of them somewhere (an export, or another browser where they are unlocked), they are not touched."),
      ],
      confirm: "Erase encrypted notebooks",
      danger: true,
      working: "Erasing…",
      submit: async () => {
        try {
          await this.vault.erase();
        } catch (error) {
          return this.vaultProblem(error);
        }
        prefs.remove("vault");
      },
    });
    if (erased) this.say("Erased the encrypted notebooks.");
  }

  /** From the notebook menu: unlock, and go back to the encrypted notebook that was open last. */
  private async unlockFromMenu(): Promise<void> {
    if (!(await this.unlockDialog())) return;
    const last = prefs.get("vault-notebook");
    const notebooks = await this.store.listNotebooks();
    const back = notebooks.find((n) => n.id === last && n.kind === "encrypted");
    if (back) await this.openNotebook(back.id);
    else this.say("Unlocked the encrypted notebooks.");
  }

  /**
   * Lock the vault. The keys go first: the engine is ended, so that nothing decrypted or secret is left in
   * memory, and only then is the screen changed to a notebook that is not encrypted. Locking depends on nothing
   * else working (a store that fails, a save that never finishes, a dialog that is open), and the app is hidden
   * while it happens.
   *
   * `why`: "asked" (the person pressed Lock: if what they typed can't be saved first, they are asked), "idle"
   * (nobody used the app for a while) or "away" (the page was left, and the browser showed it again).
   */
  private async lockVault(why: "asked" | "idle" | "away" = "asked"): Promise<void> {
    if (!this.vault.unlocked || this.locking) return;
    // What was typed goes to the vault first, if it can, but not for long: locking is not to wait for a stuck save.
    const kept = this.isPrivate ? await this.settle() : true;
    if (!kept && why === "asked") {
      // (one question is enough, whoever pressed Lock twice; a lock that nobody asked for closes it, and goes ahead)
      if (this.askingToLose) return;
      this.askingToLose = true;
      const goOn = await this.confirmLosing("Lock without saving?", "What you typed last has not reached the encrypted notebook: it could not be saved just now. If you lock the encrypted notebooks now, it is lost.", "Lock, and lose it").finally(() => (this.askingToLose = false));
      if (!goOn) return;
    }
    // (all that took time: the vault may be locked by now, or be locking)
    if (!this.vault.unlocked || this.locking) return;
    this.locking = true;
    this.setLocking(true);
    let restarting = false;
    try {
      closeAllDialogs();
      await this.vault.lock();
      // (if the screen can't be changed to another notebook it must not go on showing this one: the page starts again)
      restarting = !(await this.clearLockedScreen());
    } finally {
      this.locking = false;
      if (!restarting) this.setLocking(false);
    }
    if (restarting) return;
    if (!kept && why !== "asked") {
      // (nobody was there to be asked: they are told that what they typed last was lost)
      await showMessage("The encrypted notebooks were locked", "What you typed last had not reached the encrypted notebook, and was not saved.");
    } else {
      this.say(why === "idle" ? "Locked the encrypted notebooks, as nobody had used the app for a while." : why === "away" ? "Locked the encrypted notebooks while you were away." : "Locked the encrypted notebooks.");
    }
  }

  /** Get what was typed into the notebook that is open saved, for no more than a few seconds: whether it all got there. */
  private async settle(): Promise<boolean> {
    let timer: number | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, SETTLE_MS);
    });
    await Promise.race([this.flush(), gaveUp]);
    window.clearTimeout(timer);
    return !(this.dirty || this.saving > 0 || this.saveFailed);
  }

  private confirmLosing(title: string, body: string, confirm: string): Promise<boolean> {
    return showDialog({ title, body: [body], confirm, danger: true });
  }

  // ------------------------------------------------------------------------------------------
  // the app on the device (the service worker: pwa/, web/pwa/sw.js)

  /** Show what the service worker does: a banner when a new version waits, and items in the notebook menu. */
  usePwa(pwa: Pwa): void {
    this.pwa = pwa;
    // (a page that has to start again for another version saves what was typed first, and asks if that can't be)
    pwa.restart = () => this.restartForUpdate();
    pwa.onChange(() => this.renderPwa());
    this.renderPwa();
  }

  private renderPwa(): void {
    const pwa = this.pwa;
    if (!pwa) return;
    const { phase, offer, replaced, running } = pwa.state;
    this.els.updateBanner.hidden = !offer || this.updateDismissedFor === offer.id;
    if (offer) this.els.updateText.textContent = `A new version of the app is ready (${shortId(offer.id)}). Nothing changes until you update.`;
    if (this.pwaPhase === "installing" && phase === "ready") this.say("The app is saved on this device: it works without the network.");
    this.pwaPhase = phase;
    if (replaced && !this.toldReplaced) {
      this.toldReplaced = true;
      this.warn(`The version of the app that you had (${shortId(replaced)}) could not be restored on this device, and the server no longer has it: this one (${shortId(running ?? "")}) runs instead.`);
    }
  }

  private dismissUpdate(): void {
    this.updateDismissedFor = this.pwa?.state.offer?.id ?? null;
    this.renderPwa();
  }

  /** Start the page again, for a version that was approved (here or in another tab): what was typed is saved first. */
  private async restartForUpdate(): Promise<boolean> {
    if (!(await this.settle()) && !(await this.confirmLosing("Start again without saving?", "What you typed last has not reached the notebook: it could not be saved just now. If the app starts again now, it is lost.", "Start again, and lose it"))) return false;
    location.reload();
    return true;
  }

  /** What the new version is, and the question whether to run it from now on. */
  private async updateDialog(): Promise<void> {
    const pwa = this.pwa;
    const offer = pwa?.state.offer;
    if (!pwa || !offer) return;
    const shown = offer.changed.slice(0, 8);
    await showDialog({
      title: "Update the app",
      body: [
        h("p", {}, "This version: ", h("code", { text: pwa.state.running ?? "unknown" }), " ", h("br"), "New version: ", h("code", { text: offer.id })),
        `The new version is ${count(offer.files, "file")} (${megabytes(offer.bytes)}) and ${count(offer.changed.length, "file")} of them differ from this one:`,
        h("ul", { class: "changed-files" }, ...shown.map((name) => h("li", { text: name })), offer.changed.length > shown.length ? h("li", { text: `… and ${offer.changed.length - shown.length} more` }) : null),
        h("p", {}, "Each file was checked against the list the new version was built with, so they are the files it names. To be sure that it is the version you expect, compare its id with the one that was published, or check what the server serves with ", h("code", { text: "node scripts/pwa.mjs --remote ADDRESS" }), "."),
        this.vault.unlocked ? "Updating starts the app again, which locks the encrypted notebooks. What you typed is saved first." : "Updating starts the app again. What you typed is saved first.",
      ],
      confirm: "Update and start again",
      working: "Updating…",
      submit: async () => {
        try {
          await pwa.approve();
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
  }

  /** Which version this is, whether it is saved on the device, and a way to look for a new one. */
  private async aboutDialog(): Promise<void> {
    const pwa = this.pwa;
    if (!pwa) return;
    const { phase, reason, running, files, bytes, offer, replaced, refused } = pwa.state;
    const lines: Array<string | HTMLElement> = [];
    if (phase === "ready" && running) {
      lines.push(h("p", {}, "Version ", h("code", { text: running })));
      lines.push(`This app is saved on this device (${count(files, "file")}, ${megabytes(bytes)}): it starts without the network, and its code changes only when you approve an update.`);
    } else if (phase === "installing" || phase === "starting") lines.push("The app is being saved on this device…");
    else lines.push(reason ?? "This copy of the app is not saved on this device.");
    if (offer) lines.push(`A new version (${offer.id}) is ready: choose “Update the app” in the notebook menu to see what changes.`);
    if (refused) lines.push("A new version was found, but its files were not what it says it is made of, so it was not installed.");
    if (replaced) lines.push(`The version that you had (${replaced}) could not be restored on this device, and the server no longer had it, so the one that runs now took its place.`);
    lines.push(h("p", {}, "The version is a fingerprint of every file of the app and of the code that keeps it as it is: two copies that show the same one are the same app. (A server that wanted to cheat could show any version: to check what it serves, without this page in the way, run ", h("code", { text: "node scripts/pwa.mjs --remote ADDRESS" }), " from the web folder.)"));
    await showDialog({
      title: "About this version",
      body: lines,
      confirm: "Close",
      noCancel: true,
      actions: phase === "ready" ? [{ label: "Look for a new version", run: (close) => (close(), void this.lookForUpdate()) }] : [],
    });
  }

  private async lookForUpdate(): Promise<void> {
    const pwa = this.pwa;
    if (!pwa) return;
    this.say("Looking for a new version…");
    try {
      await pwa.update();
    } catch (error) {
      this.say(`Couldn't look for a new version: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const { offer, refused } = pwa.state;
    if (offer) {
      this.updateDismissedFor = null;
      this.renderPwa();
      this.say(`A new version is ready (${shortId(offer.id)}): see the notebook menu.`);
    } else if (refused) this.say("A new version was found, but its files could not be checked, so it was not installed.");
    else this.say("This is the newest version.");
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
        // Pages and notebook.zim are read to be understood; attachments stay as the files they are until they are stored.
        files = await Promise.all(
          picked.map(async (f): Promise<ImportedFile> => {
            const path = f.webkitRelativePath || f.name;
            return isReadToImport(path) ? { path, bytes: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified } : { path, blob: f, modified: f.lastModified };
          }),
        );
        suggested = (picked[0]?.webkitRelativePath ?? "").split("/")[0] || "Imported notebook";
      }
      await this.confirmImport(pagesFromFiles(files), suggested);
    } catch (error) {
      this.say("");
      await showMessage("That couldn't be imported", error instanceof Error ? error.message : String(error));
    }
  }

  private async confirmImport(imported: Imported, suggested: string): Promise<void> {
    const session = this.session;
    if (imported.pages.length === 0) {
      this.say("");
      await showMessage("No pages found", "There are no Zim pages (.txt files) in what you chose.", imported.skipped.length ? `${imported.skipped.length} files were skipped, for example ${imported.skipped[0]?.path}: ${imported.skipped[0]?.reason}.` : null);
      return;
    }
    const replacingPages = imported.pages.filter((p) => this.session.has(p.name)).length;
    const replacingFiles = imported.files.filter((f) => this.session.fileInfo(f.path)).length;
    const replacing = [replacingPages ? count(replacingPages, "page") : "", replacingFiles ? count(replacingFiles, "file") : ""].filter(Boolean).join(" and ");
    const counted = `${count(imported.pages.length, "page")}${imported.files.length ? ` and ${count(imported.files.length, "attachment")}` : ""}`;
    const lines: Array<string | HTMLElement> = [imported.files.length ? `${counted} (the files that go with pages: images and others)` : counted];
    const skipped = h("ul", { class: "skipped" }, ...imported.skipped.slice(0, 6).map((s) => h("li", { text: `${s.path}: ${s.reason}` })));
    if (imported.skipped.length > 6) skipped.append(h("li", { text: `… and ${imported.skipped.length - 6} more` }));
    await showDialog({
      title: "Import notebook",
      body: [h("p", { text: lines.join("; ") + "." }), imported.skipped.length ? h("div", {}, h("p", { text: `${imported.skipped.length} files were skipped:` }), skipped) : null],
      fields: [{ name: "title", label: "Notebook name", value: imported.config.name ?? suggested, validate: (v) => (v.trim() ? null : "Give the notebook a name.") }],
      choices: [{ name: "into", label: "Import as", value: "new", options: [{ value: "new", label: "A new notebook" }, { value: "encrypted", label: "A new encrypted notebook" }, { value: "here", label: `More pages in ${this.session.title}${replacing ? ` (replaces ${replacing} with the same names)` : ""}` }] }],
      confirm: "Import",
      working: "Importing…",
      submit: async (values) => {
        await this.flush();
        if (values.into === "encrypted") {
          const problem = await this.prepareVault();
          if (problem) return problem;
        }
        if (values.into === "here") {
          const stale = this.stale(session);
          if (stale) return stale;
          await session.addPages(imported.pages, imported.files);
          await this.syncCurrentPage();
          this.say(`Imported ${counted} into ${this.session.title}.`);
          return;
        }
        const names = new Set(imported.pages.map((p) => p.name.toLowerCase()));
        const wanted = imported.config.home && names.has(imported.config.home.toLowerCase()) ? imported.config.home : names.has("home") ? "Home" : (imported.pages[0] as { name: string }).name;
        const info = await this.store.createNotebook({ title: String(values.title).trim(), home: wanted, kind: values.into === "encrypted" ? "encrypted" : "open" }, imported.pages, imported.files);
        await this.openNotebook(info.id);
        this.say(`Imported ${counted} as ${info.title}.`);
        if (info.kind === "encrypted") void this.warnIfNotKept();
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
    const previous = this.current;
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
    this.locate(spelled, options.push && !(this.isPrivate && previous?.name === spelled) ? "push" : options.replace ? "replace" : "none");
    this.tree.setCurrent(spelled);
    this.renderBreadcrumb();
    this.renderBacklinks();
    this.renderAttachments();
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
    this.els.attach.disabled = !this.current;
  }

  private renderNotice(): void {
    const warning = this.warning ?? this.vaultWarning;
    if (warning) {
      this.showNotice(warning);
    } else if (this.current && !this.current.exists) {
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

  /** Something the person needs to know for as long as this page is open: it stays above every page. */
  warn(text: string): void {
    this.warning = text;
    this.renderNotice();
  }

  /** Something wrong with the encrypted notebooks: it stays above every page until they are locked. */
  warnAboutVault(text: string): void {
    this.vaultWarning = text;
    this.renderNotice();
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
      else if (resolved.kind === "file") {
        const file = this.session.resolveFile(this.current.name, target);
        if (file.kind === "notebook") status = file.exists ? "exists" : "missing";
      }
    }
    this.linkCache.set(target, status);
    return status;
  }

  /** What to draw for `{{path}}` on the open page: the picture, or why there isn't one. */
  private imageSource(path: string): ImageSource {
    if (!this.session || !this.current) return { status: "outside" };
    const resolved = this.session.resolveFile(this.current.name, path);
    if (resolved.kind === "outside") return { status: "outside" };
    const info = resolved.exists ? this.session.fileInfo(resolved.path) : undefined;
    if (!info) return { status: "missing" };
    if (!isImageType(info.type)) return { status: "unsupported" };
    const picture = this.urls?.get(info.path) ?? { status: "failed" as const };
    return picture.status === "ready" ? { status: "ready", url: picture.url } : { status: picture.status };
  }

  /** Open the file a reference on the open page leads to: a picture is shown, anything else is downloaded. */
  private async openFileReference(target: string): Promise<void> {
    if (!this.current) return;
    const resolved = this.session.resolveFile(this.current.name, target);
    if (resolved.kind === "outside") return this.say(`${target} is a path outside this notebook, which a browser can't open.`);
    if (!resolved.exists) return this.say(`There is no file ${resolved.path} in this notebook.`);
    await this.openAttachment(resolved.path);
  }

  /** Show an attachment: a picture large, anything else as a download. */
  private async openAttachment(path: string): Promise<void> {
    const info = this.session.fileInfo(path);
    const blob = await this.session.fileBlob(path);
    if (!info || !blob) return this.say(`${path} couldn't be read from this browser's storage.`);
    const name = info.path.slice(info.path.lastIndexOf("/") + 1);
    if (isImageType(blob.type)) await this.showPicture(name, blob);
    else this.downloadBlob(name, blob);
  }

  // ------------------------------------------------------------------------------------------
  // attachments

  /** The text that refers to an attachment of the open page: a picture, or a link with the file's name. */
  private referenceTo(path: string): string {
    const link = this.session.fileLink(this.current?.name ?? "", path);
    // (the name is shown as the link's text: brackets and bars in it would end the link early)
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/[[\]|]/g, "_");
    return isImageType(this.session.fileInfo(path)?.type ?? "") ? `{{${link}}}` : `[[${link}|${name}]]`;
  }

  /** Attach files to the open page and put what refers to them in the text: where they were dropped, or at the caret. */
  private async attachFiles(files: File[], at?: number | "end"): Promise<void> {
    if (!this.current) return;
    // The files belong to the page and the notebook they were given to, even if the person moves on while they are stored.
    const session = this.session;
    const page = this.current.name;
    let attached: string[];
    try {
      // one write for all of them: they are attached together or not at all
      attached = await session.addFiles(page, files.map((file) => ({ content: file, wanted: attachmentName(file) })));
    } catch (error) {
      this.say("");
      await showMessage("The files could not be attached", h("p", { text: error instanceof Error ? error.message : String(error) }));
      return;
    }
    // (if the page or the notebook was left meanwhile, the files are attached, but nothing is inserted anywhere else)
    if (this.session === session && this.current?.name === page) this.editor.insert(attached.map((path) => this.referenceTo(path)).join("\n"), at);
    const first = attached[0] as string;
    this.say(`Attached ${attached.length === 1 ? first.slice(first.lastIndexOf("/") + 1) : count(attached.length, "file")} to ${page}.`);
  }

  private renderAttachments(): void {
    clear(this.els.attachmentList);
    const files: FileInfo[] = this.current ? this.session.attachments(this.current.name) : [];
    this.els.attachments.hidden = files.length === 0;
    this.els.attachmentCount.textContent = `(${files.length})`;
    for (const file of files) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const picture = isImageType(file.type) ? this.urls?.get(file.path) : undefined;
      const dot = name.lastIndexOf(".");
      const thumb = h("span", { class: "thumb", "aria-hidden": "true" }, picture?.status === "ready" ? h("img", { src: picture.url, alt: "" }) : dot > 0 ? name.slice(dot + 1, dot + 5).toLowerCase() : "file");
      this.els.attachmentList.append(
        h(
          "li",
          {},
          thumb,
          h("div", {}, h("button", { type: "button", class: "link-button name", text: name, title: "Open", on: { click: () => void this.openAttachment(file.path) } }), h("div", { class: "meta", text: `${formatSize(file.size)} · ${file.type || "unknown type"}` })),
          h(
            "div",
            { class: "actions" },
            h("button", { type: "button", text: "Insert", title: "Put a reference to it in the page at the caret", on: { click: () => this.editor.insert(this.referenceTo(file.path)) } }),
            h("button", { type: "button", text: "Download", on: { click: () => void this.session.fileBlob(file.path).then((blob) => blob && this.downloadBlob(name, blob)) } }),
            h("button", { type: "button", class: "danger-text", text: "Delete", on: { click: () => void this.removeAttachment(file.path) } }),
          ),
        ),
      );
    }
  }

  private async removeAttachment(path: string): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    await showDialog({
      title: "Delete attachment",
      body: [h("p", {}, "Delete ", h("strong", { text: name }), " from this notebook? This can't be undone."), "Pages that show it will show a missing picture."],
      confirm: "Delete attachment",
      danger: true,
      submit: async () => {
        await this.session.removeFile(path);
        this.say(`Deleted ${name}.`);
      },
    });
  }

  /** A picture, large, in a dialog. It is an <img> and nothing else, so that nothing in it can run, whatever the file. */
  private async showPicture(name: string, blob: Blob): Promise<void> {
    const { url, release } = await pictureAddress(blob);
    try {
      await showDialog({
        title: name,
        body: [h("div", { class: "viewer" }, h("img", { class: "viewer-image", src: url, alt: name })), h("div", { class: "viewer-actions" }, h("button", { type: "button", class: "secondary", text: "Download", on: { click: () => this.downloadBlob(name, blob) } }))],
        confirm: "Close",
        noCancel: true,
      });
    } finally {
      release();
    }
  }

  private async followLink(link: LinkInfo): Promise<void> {
    if (!this.current) return;
    switch (link.kind) {
      case "image":
        // a picture with an href goes where that says; otherwise it is shown large
        if (link.href) await this.followLink({ ...link, kind: classifyLink(link.href), target: link.href });
        else await this.openFileReference(link.target);
        break;
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
        await this.openFileReference(link.target);
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
    this.saveTimer = window.setTimeout(() => void this.flush(), this.isPrivate ? PRIVATE_SAVE_DELAY_MS : SAVE_DELAY_MS);
  }

  private setSaveState(text: string): void {
    this.els.saveState.textContent = text;
  }

  /** Put what is on screen where a page that is closing can still put it, if the notebook doesn't have it yet. */
  private keepDraft(): void {
    // (an encrypted notebook's typing is not put in localStorage, where anyone could read it: the vault is its only place)
    if (!this.current || !this.session || this.isPrivate || !(this.dirty || this.saving > 0 || this.saveFailed)) return;
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
          // (a save that fails after its notebook was left, a lock say, is not news for the notebook that is shown)
          if (session !== this.session) return;
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
    const session = this.session;
    const created = await showDialog({
      title: "New page",
      body: ["Use a colon to put the page in a section: Projects:Garden:Plan."],
      fields: [{ name: "name", label: "Page name", value: prefix, validate: (value) => this.checkNewName(value) }],
      confirm: "Create",
      submit: async (values) => {
        const stale = this.stale(session);
        if (stale) return stale;
        await this.flush();
        const name = await session.create(String(values.name));
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
    const session = this.session;
    const from = this.current.name;
    const below = this.session.names().filter((n) => n.toLowerCase().startsWith(`${from.toLowerCase()}:`)).length;
    const files = this.session.filesBelow(from);
    const goesWith = [below > 0 ? `the ${below} page${below === 1 ? "" : "s"} below it` : "", files > 0 ? `its ${files} attachment${files === 1 ? "" : "s"}` : ""].filter(Boolean);
    const several = goesWith.length > 1 || below > 1 || files > 1;
    await showDialog({
      title: "Rename page",
      body: [goesWith.length > 0 ? `${goesWith.join(" and ").replace(/^./, (c) => c.toUpperCase())} ${several ? "move" : "moves"} with it.` : "Use a colon to move the page into another section."],
      fields: [{ name: "name", label: "New name", value: from, validate: (value) => { const p = checkPageName(value); return "error" in p ? p.error : null; } }],
      checks: [{ name: "links", label: "Update the links to this page", checked: true }],
      confirm: "Rename",
      submit: async (values) => {
        const stale = this.stale(session);
        if (stale) return stale;
        const report = await session.rename(from, String(values.name), Boolean(values.links));
        const moved = report.moved.find(([old]) => old.toLowerCase() === from.toLowerCase());
        const mine = this.current ? report.moved.find(([old]) => old.toLowerCase() === this.current?.name.toLowerCase()) : undefined;
        if (this.current && mine) this.current.name = mine[1];
        // links are judged from the page they are on, and this page has a new name; so are its attachments
        this.linkCache.clear();
        this.editor.refreshLinks();
        this.renderAttachments();
        await this.refreshCurrentText();
        this.tree.setCurrent(this.current?.name ?? null);
        this.locate(this.current?.name ?? from, "replace");
        this.renderBreadcrumb();
        this.renderBacklinks();
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
    const session = this.session;
    const name = this.current.name;
    const below = this.session.names().filter((n) => n.toLowerCase().startsWith(`${name.toLowerCase()}:`)).length;
    const files = this.session.filesBelow(name);
    await showDialog({
      title: "Delete page",
      body: [h("p", {}, "Delete ", h("strong", { text: name }), below ? ` and the ${below} page${below === 1 ? "" : "s"} below it` : "", files ? `${below ? ", and" : " and"} ${below ? "their" : "its"} ${files} attachment${files === 1 ? "" : "s"}` : "", "? This can't be undone."), "Links to deleted pages will show as missing."],
      confirm: below ? `Delete ${below + 1} pages` : "Delete page",
      danger: true,
      submit: async () => {
        const stale = this.stale(session);
        if (stale) return stale;
        const removed = await session.delete(name);
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
    clear(this.els.searchResults);
    this.els.search.setAttribute("aria-expanded", "false");
    this.searchHits = [];
    this.searchActive = -1;
  }
}
