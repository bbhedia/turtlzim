// An open notebook: the notebook rules (in wasm) over a store. This is where "rename a page" means
// "rename it in the model, rewrite the links, and write all of it to the store in one go", and where
// a page's file properties (byte-order mark, line endings) are kept so that export writes each page
// back as it was read.
import { NotebookModel, checkPageName, newPageText, pageKey, pageToPath, zimTimestamp } from "../notebook-core";
import type { Backlink, RenameReport, ResolvedLink, SearchHit, TreeNode } from "../notebook-core";
import { encodePage } from "../zim";
import type { LineEnding } from "../zim";
import type { NotebookInfo, NotebookStore, StoredPage } from "./store";
import { notebookConfig } from "./zim-files";
import type { ZipEntry } from "../zip";

export type SessionEvent =
  /** Pages were added, removed or renamed: the tree and every link's meaning may have changed. */
  | { kind: "structure" }
  /** The text of one page changed. */
  | { kind: "page"; name: string };

interface FileProperties {
  bom: boolean;
  lineEnding: LineEnding;
  modified: number;
}

export class NotebookSession {
  model = new NotebookModel();
  private readonly files = new Map<string, FileProperties>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  private constructor(
    readonly store: NotebookStore,
    public info: NotebookInfo,
  ) {}

  static async open(store: NotebookStore, id: string): Promise<NotebookSession> {
    const info = (await store.listNotebooks()).find((n) => n.id === id);
    if (!info) throw new Error("That notebook no longer exists.");
    const session = new NotebookSession(store, info);
    await session.reload();
    return session;
  }

  /** Read every page again from the store (after a failed write, to be sure what is there). */
  async reload(): Promise<void> {
    const pages = await this.store.loadPages(this.info.id);
    this.model.free();
    this.model = new NotebookModel();
    this.files.clear();
    for (const page of pages) {
      this.model.put(page.name, page.text);
      this.files.set(pageKey(page.name), { bom: page.bom, lineEnding: page.lineEnding, modified: page.modified });
    }
    this.emit({ kind: "structure" });
  }

  close(): void {
    this.model.free();
    this.listeners.clear();
  }

  onChange(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ---- reading

  get title(): string {
    return this.info.title;
  }

  /** The home page's name as the notebook spells it, or as written if there is no such page. */
  get home(): string {
    return this.model.find(this.info.home) ?? this.info.home;
  }

  get pageCount(): number {
    return this.model.size;
  }

  has(name: string): boolean {
    return this.model.has(name);
  }

  /** Whether `name` is a page or a section that has pages below it. */
  exists(name: string): boolean {
    return this.model.find(name) !== undefined;
  }

  text(name: string): string | undefined {
    return this.model.get(name);
  }

  /** When a page was last written (ms since the epoch), if there is such a page. */
  modified(name: string): number | undefined {
    return this.files.get(pageKey(name))?.modified;
  }

  names(): string[] {
    return this.model.names();
  }

  tree(): TreeNode[] {
    return this.model.tree();
  }

  resolve(from: string, target: string): ResolvedLink {
    return this.model.resolve(from, target);
  }

  linkTo(from: string, to: string): string {
    return this.model.linkTo(from, to);
  }

  backlinks(name: string): Backlink[] {
    return this.model.backlinks(name);
  }

  search(query: string, limit = 50): SearchHit[] {
    return this.model.search(query, limit);
  }

  /** The name as this notebook would spell it: an existing section or page keeps its spelling. */
  spell(name: string): string {
    const parsed = checkPageName(name);
    if ("error" in parsed) throw new Error(parsed.error);
    const link = this.model.resolve(parsed.name, `:${parsed.name}`);
    return link.kind === "page" ? link.page : parsed.name;
  }

  // ---- writing

  private record(name: string): StoredPage {
    const canonical = this.model.find(name);
    const text = this.model.get(name);
    if (canonical === undefined || text === undefined) throw new Error(`no page ${name}`);
    const file = this.files.get(pageKey(name)) ?? { bom: false, lineEnding: "lf" as const, modified: Date.now() };
    return { name: canonical, text, ...file };
  }

  /**
   * Set a page's text and write it to the store, creating the page if there isn't one. If the
   * write fails the notebook is read back from the store, so what is shown is what is kept.
   */
  async save(name: string, text: string): Promise<void> {
    const existed = this.model.has(name);
    this.model.put(name, text);
    const key = pageKey(name);
    const file = this.files.get(key) ?? { bom: false, lineEnding: "lf" as const, modified: 0 };
    this.files.set(key, { ...file, modified: Date.now() });
    try {
      await this.store.replacePages(this.info.id, { remove: [], put: [this.record(name)] });
    } catch (error) {
      await this.reload();
      throw error;
    }
    this.emit({ kind: "page", name: this.model.find(name) ?? name });
    if (!existed) this.emit({ kind: "structure" });
  }

  /** Make a new page, as Zim starts one (header and title) unless given text. Returns its name. */
  async create(name: string, text?: string): Promise<string> {
    const spelled = this.spell(name);
    if (this.model.has(spelled)) throw new Error(`A page called ${this.model.find(spelled) ?? spelled} already exists.`);
    await this.save(spelled, text ?? newPageText(spelled, zimTimestamp()));
    return this.model.find(spelled) ?? spelled;
  }

  /**
   * Move a page and everything below it. With `updateLinks`, links are rewritten so that every one
   * still leads where it did. Throws, with a message to show, if it can't be done.
   */
  async rename(from: string, to: string, updateLinks = true): Promise<RenameReport> {
    const report = this.model.rename(from, to, updateLinks);
    for (const [oldName, newName] of report.moved) {
      const key = pageKey(oldName);
      const file = this.files.get(key);
      this.files.delete(key);
      if (file) this.files.set(pageKey(newName), file);
    }
    const touched = new Set([...report.moved.map(([, n]) => n), ...report.rewritten]);
    const now = Date.now();
    for (const name of report.rewritten) {
      const file = this.files.get(pageKey(name));
      if (file) this.files.set(pageKey(name), { ...file, modified: now });
    }
    try {
      await this.store.replacePages(this.info.id, { remove: report.moved.map(([old]) => old), put: [...touched].map((n) => this.record(n)) });
    } catch (error) {
      await this.reload();
      throw error;
    }
    // If the home page moved, the notebook's home moves with it.
    const homeKey = this.homeKey();
    const movedHome = homeKey === undefined ? undefined : report.moved.find(([old]) => pageKey(old) === homeKey);
    if (movedHome) await this.setHome(movedHome[1]);
    this.emit({ kind: "structure" });
    return report;
  }

  /** Delete a page and everything below it. The names deleted. */
  async delete(name: string): Promise<string[]> {
    const removed = this.model.removeTree(name);
    for (const gone of removed) this.files.delete(pageKey(gone));
    try {
      await this.store.replacePages(this.info.id, { remove: removed, put: [] });
    } catch (error) {
      await this.reload();
      throw error;
    }
    this.emit({ kind: "structure" });
    return removed;
  }

  /** The key of the home page, if the notebook's home is a valid page name (an imported config may not be). */
  private homeKey(): string | undefined {
    const parsed = checkPageName(this.info.home);
    return "name" in parsed ? pageKey(parsed.name) : undefined;
  }

  async setHome(name: string): Promise<void> {
    this.info = { ...this.info, home: name };
    await this.store.updateNotebook(this.info);
  }

  async setTitle(title: string): Promise<void> {
    this.info = { ...this.info, title };
    await this.store.updateNotebook(this.info);
  }

  /** Add pages (replacing any with the same name, ignoring case): an import. */
  async addPages(pages: StoredPage[]): Promise<void> {
    for (const page of pages) {
      this.model.put(page.name, page.text);
      this.files.set(pageKey(page.name), { bom: page.bom, lineEnding: page.lineEnding, modified: page.modified });
    }
    try {
      await this.store.replacePages(this.info.id, { remove: [], put: pages.map((p) => this.record(p.name)) });
    } catch (error) {
      await this.reload();
      throw error;
    }
    this.emit({ kind: "structure" });
  }

  // ---- leaving

  /** One page as the file it would be (its bytes, with its own byte-order mark and line endings), at the path it has in a notebook folder. */
  exportPage(name: string): ZipEntry | undefined {
    if (!this.model.has(name)) return undefined;
    const page = this.record(name);
    return { path: pageToPath(page.name), bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: new Date(page.modified) };
  }

  /** The notebook as files: every page at its path with its own byte-order mark and line endings, and `notebook.zim`, so that Zim opens the folder. */
  exportFiles(): ZipEntry[] {
    const modified = (name: string) => new Date(this.files.get(pageKey(name))?.modified ?? Date.now());
    const entries: ZipEntry[] = [{ path: "notebook.zim", bytes: new TextEncoder().encode(notebookConfig({ title: this.info.title, home: this.info.home })) }];
    for (const name of this.model.names()) {
      const page = this.record(name);
      entries.push({ path: pageToPath(page.name), bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: modified(name) });
    }
    return entries;
  }
}

/** A notebook with a home page, ready to open. */
export async function createEmptyNotebook(store: NotebookStore, title: string, home = "Home"): Promise<NotebookInfo> {
  const page: StoredPage = {
    name: home,
    text: newPageText(home, zimTimestamp()) + "\nThis notebook is empty. Make a page with New page, or follow a link to a page that doesn't exist yet.\n",
    bom: false,
    lineEnding: "lf",
    modified: Date.now(),
  };
  return store.createNotebook({ title, home, kind: "open" }, [page]);
}
