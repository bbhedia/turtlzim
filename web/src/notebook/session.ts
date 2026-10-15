// An open notebook: the notebook rules (in wasm) over a store. This is where "rename a page" means
// "rename it in the model, rewrite the links, and write all of it to the store in one go", and where
// a page's file properties (byte-order mark, line endings) are kept so that export writes each page
// back as it was read.
import { NotebookModel, checkPageName, newPageText, pageKey, pageToPath, startingText, zimTimestamp } from "../notebook-core";
import type { Backlink, LinkSuggestion, RenameReport, ResolvedFile, ResolvedLink, SearchHit, TagInfo, TreeNode } from "../notebook-core";
import { encodePage } from "../zim";
import type { LineEnding } from "../zim";
import { typed } from "./media";
import { fileKey } from "./store";
import type { FileInfo, NotebookInfo, NotebookStore, StoredFile, StoredPage } from "./store";
import { notebookConfig } from "./zim-files";
import type { ZipEntry } from "../zip";

export type SessionEvent =
  /** Pages were added, removed or renamed: the tree and every link's meaning may have changed. */
  | { kind: "structure" }
  /** The text of one page changed. */
  | { kind: "page"; name: string }
  /** Files were added, removed or moved (a move also announces `structure`): what refers to them may look different. */
  | { kind: "files" };

interface FileProperties {
  bom: boolean;
  lineEnding: LineEnding;
  modified: number;
}

export class NotebookSession {
  model = new NotebookModel();
  private readonly files = new Map<string, FileProperties>();
  /** What is known of each attachment (by `fileKey`): the bytes stay in the store. */
  private readonly fileInfos = new Map<string, FileInfo>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  /** The end of what has been asked of the session so far: each change waits for the one before it. */
  private lock: Promise<unknown> = Promise.resolve();
  private closing = false;

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
    const [pages, stored] = await Promise.all([this.store.loadPages(this.info.id), this.store.listFiles(this.info.id)]);
    this.model.free();
    this.model = new NotebookModel();
    this.files.clear();
    this.fileInfos.clear();
    for (const page of pages) {
      this.model.put(page.name, page.text);
      this.files.set(pageKey(page.name), { bom: page.bom, lineEnding: page.lineEnding, modified: page.modified });
    }
    for (const file of stored) {
      try {
        this.model.putFile(file.path);
        this.fileInfos.set(fileKey(file.path), file);
      } catch {
        // a stored path the rules refuse can't be shown or exported (the app never writes one)
      }
    }
    this.emit({ kind: "structure" });
    if (this.fileInfos.size > 0) this.emit({ kind: "files" });
  }

  /**
   * Run `work` once everything asked of the session before it has finished, and nothing after it
   * until it has. A change decides things (a free name for a file, which pages a rename moves) and
   * then waits for the store; if another change got in between, what was decided would no longer
   * be true.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("This notebook was closed."));
    const run = this.lock.then(work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Close the session once what it is doing has finished; changes asked for after this are refused. */
  async close(): Promise<void> {
    if (this.closing) {
      await this.lock;
      return;
    }
    this.closing = true;
    await this.lock;
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

  /** The attachments of a page: the files in the folder named like it. */
  attachments(page: string): FileInfo[] {
    return this.model.filesOf(page).flatMap((path) => this.fileInfos.get(fileKey(path)) ?? []);
  }

  /** What is known of the file at `path` (a notebook path), if the notebook has it. */
  fileInfo(path: string): FileInfo | undefined {
    return this.fileInfos.get(fileKey(path));
  }

  get fileCount(): number {
    return this.model.fileCount;
  }

  /** How many attachments there are in the folder of a page and the folders below it. */
  filesBelow(page: string): number {
    return this.model.filesBelow(page).length;
  }

  /** Where a file reference (an image's path, a `[[./file]]` link) written on page `from` leads. */
  resolveFile(from: string, target: string): ResolvedFile {
    return this.model.resolveFile(from, target);
  }

  /** The text that, written on `from` as a file reference, leads to the file at `path`. */
  fileLink(from: string, path: string): string {
    return this.model.fileLink(from, path);
  }

  /** The bytes of an attachment, from the store. */
  fileBlob(path: string): Promise<Blob | undefined> {
    return this.store.loadFile(this.info.id, path);
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

  /** The days of a month that have a journal page with text, as day numbers in order. */
  journalDays(year: number, month: number): number[] {
    return this.model.journalDays(year, month);
  }

  /** Every `@tag` of the notebook with the pages that write it, by name. */
  tags(): TagInfo[] {
    return this.model.tags();
  }

  /** The pages that write a tag (named with or without the `@`), in name order. */
  pagesWithTag(tag: string): string[] {
    return this.model.pagesWithTag(tag);
  }

  search(query: string, limit = 50): SearchHit[] {
    return this.model.search(query, limit);
  }

  /** The pages a link being typed on page `from` can be completed to, best first, with what to write for each. */
  completeLink(from: string, typed: string, limit = 20): LinkSuggestion[] {
    return this.model.completeLink(from, typed, limit);
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
  save(name: string, text: string): Promise<void> {
    return this.exclusive(() => this.saveNow(name, text));
  }

  private async saveNow(name: string, text: string): Promise<void> {
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
  create(name: string, text?: string): Promise<string> {
    return this.exclusive(async () => {
      const spelled = this.spell(name);
      if (this.model.has(spelled)) throw new Error(`A page called ${this.model.find(spelled) ?? spelled} already exists.`);
      await this.saveNow(spelled, text ?? startingText(spelled, zimTimestamp()));
      return this.model.find(spelled) ?? spelled;
    });
  }

  /**
   * Move a page and everything below it. With `updateLinks`, links are rewritten so that every one
   * still leads where it did. Throws, with a message to show, if it can't be done.
   */
  rename(from: string, to: string, updateLinks = true): Promise<RenameReport> {
    return this.exclusive(() => this.renameNow(from, to, updateLinks));
  }

  private async renameNow(from: string, to: string, updateLinks: boolean): Promise<RenameReport> {
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
    // The files went with their pages; what is known of each goes with it.
    const movedInfos = report.filesMoved.map(([from, to]) => [to, this.fileInfos.get(fileKey(from))] as const);
    for (const [from] of report.filesMoved) this.fileInfos.delete(fileKey(from));
    for (const [to, info] of movedInfos) if (info) this.fileInfos.set(fileKey(to), { ...info, path: to });
    try {
      await this.store.replacePages(this.info.id, {
        remove: report.moved.map(([old]) => old),
        put: [...touched].map((n) => this.record(n)),
        ...(report.filesMoved.length > 0 ? { files: { move: report.filesMoved } } : {}),
      });
    } catch (error) {
      await this.reload();
      throw error;
    }
    // If the home page moved, the notebook's home moves with it.
    const homeKey = this.homeKey();
    const movedHome = homeKey === undefined ? undefined : report.moved.find(([old]) => pageKey(old) === homeKey);
    if (movedHome) await this.setHomeNow(movedHome[1]);
    this.emit({ kind: "structure" });
    if (report.filesMoved.length > 0) this.emit({ kind: "files" });
    return report;
  }

  /** Delete a page and everything below it, and the attachments in their folders. The names deleted. */
  delete(name: string): Promise<string[]> {
    return this.exclusive(() => this.deleteNow(name));
  }

  private async deleteNow(name: string): Promise<string[]> {
    const removed = this.model.removeTree(name);
    const removedFiles = this.model.removeFilesBelow(name);
    for (const gone of removed) this.files.delete(pageKey(gone));
    for (const gone of removedFiles) this.fileInfos.delete(fileKey(gone));
    try {
      await this.store.replacePages(this.info.id, { remove: removed, put: [], ...(removedFiles.length > 0 ? { files: { remove: removedFiles } } : {}) });
    } catch (error) {
      await this.reload();
      throw error;
    }
    this.emit({ kind: "structure" });
    if (removedFiles.length > 0) this.emit({ kind: "files" });
    return removed;
  }

  /**
   * Attach a file to a page: it is stored in the folder named like the page, under a safe name that
   * is not in use (`wanted` is what people call it). Returns the path it was stored at; the text
   * that refers to it from the page is `fileLink`.
   */
  async addFile(page: string, content: Blob, wanted: string): Promise<string> {
    return (await this.addFiles(page, [{ content, wanted }]))[0] as string;
  }

  /**
   * Attach several files to a page in one go: each gets a name of its own in the page's folder, and
   * all are stored in one write, which happens entirely or not at all. Returns their paths, in order.
   */
  addFiles(page: string, files: Array<{ content: Blob; wanted: string }>): Promise<string[]> {
    return this.exclusive(() => this.addFilesNow(page, files));
  }

  private async addFilesNow(page: string, files: Array<{ content: Blob; wanted: string }>): Promise<string[]> {
    const modified = Date.now();
    const added: StoredFile[] = [];
    try {
      for (const { content, wanted } of files) {
        const path = this.model.attachmentPath(page, wanted);
        this.model.putFile(path); // taken from here on, so that the next file gets a name of its own
        added.push({ path, blob: typed(content, path), modified });
      }
    } catch (error) {
      for (const { path } of added) this.model.removeFile(path);
      throw error;
    }
    try {
      await this.store.replacePages(this.info.id, { remove: [], put: [], files: { put: added } });
    } catch (error) {
      await this.reload();
      throw error;
    }
    for (const file of added) this.fileInfos.set(fileKey(file.path), { path: file.path, size: file.blob.size, type: file.blob.type, modified });
    this.emit({ kind: "files" });
    return added.map((file) => file.path);
  }

  /** Delete an attachment. Whether there was one. */
  removeFile(path: string): Promise<boolean> {
    return this.exclusive(() => this.removeFileNow(path));
  }

  private async removeFileNow(path: string): Promise<boolean> {
    const known = this.model.filePath(path);
    if (known === undefined) return false;
    try {
      await this.store.replacePages(this.info.id, { remove: [], put: [], files: { remove: [known] } });
    } catch (error) {
      await this.reload();
      throw error;
    }
    this.model.removeFile(known);
    this.fileInfos.delete(fileKey(known));
    this.emit({ kind: "files" });
    return true;
  }

  /** The key of the home page, if the notebook's home is a valid page name (an imported config may not be). */
  private homeKey(): string | undefined {
    const parsed = checkPageName(this.info.home);
    return "name" in parsed ? pageKey(parsed.name) : undefined;
  }

  setHome(name: string): Promise<void> {
    return this.exclusive(() => this.setHomeNow(name));
  }

  private async setHomeNow(name: string): Promise<void> {
    this.info = { ...this.info, home: name };
    await this.store.updateNotebook(this.info);
  }

  setTitle(title: string): Promise<void> {
    return this.exclusive(async () => {
      this.info = { ...this.info, title };
      await this.store.updateNotebook(this.info);
    });
  }

  /**
   * Add pages and attachments (replacing any with the same name or path, ignoring case): an import.
   * A file that replaces one keeps the spelling of the path it replaces.
   */
  addPages(pages: StoredPage[], files: StoredFile[] = []): Promise<void> {
    return this.exclusive(() => this.addPagesNow(pages, files));
  }

  private async addPagesNow(pages: StoredPage[], files: StoredFile[]): Promise<void> {
    for (const page of pages) {
      this.model.put(page.name, page.text);
      this.files.set(pageKey(page.name), { bom: page.bom, lineEnding: page.lineEnding, modified: page.modified });
    }
    const added = files.map((file) => ({ ...file, path: this.model.filePath(file.path) ?? file.path }));
    for (const file of added) this.model.putFile(file.path);
    try {
      await this.store.replacePages(this.info.id, { remove: [], put: pages.map((p) => this.record(p.name)), ...(added.length > 0 ? { files: { put: added } } : {}) });
    } catch (error) {
      await this.reload();
      throw error;
    }
    for (const file of added) this.fileInfos.set(fileKey(file.path), { path: file.path, size: file.blob.size, type: file.blob.type, modified: file.modified });
    this.emit({ kind: "structure" });
    if (added.length > 0) this.emit({ kind: "files" });
  }

  // ---- leaving

  /** One page as the file it would be (its bytes, with its own byte-order mark and line endings), at the path it has in a notebook folder. */
  exportPage(name: string): ZipEntry | undefined {
    if (!this.model.has(name)) return undefined;
    const page = this.record(name);
    return { path: pageToPath(page.name), bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: new Date(page.modified) };
  }

  /** The notebook as files: every page at its path with its own byte-order mark and line endings, every attachment at its path, and `notebook.zim`, so that Zim opens the folder. */
  exportFiles(): Promise<ZipEntry[]> {
    return this.exclusive(() => this.exportFilesNow());
  }

  private async exportFilesNow(): Promise<ZipEntry[]> {
    const modified = (name: string) => new Date(this.files.get(pageKey(name))?.modified ?? Date.now());
    const entries: ZipEntry[] = [{ path: "notebook.zim", bytes: new TextEncoder().encode(notebookConfig({ title: this.info.title, home: this.info.home })) }];
    for (const name of this.model.names()) {
      const page = this.record(name);
      entries.push({ path: pageToPath(page.name), bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: modified(name) });
    }
    for (const path of this.model.files()) {
      const blob = await this.store.loadFile(this.info.id, path);
      if (!blob) throw new Error(`The file ${path} is in the notebook but the store doesn't have it, so the export would be missing it.`);
      entries.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()), modified: new Date(this.fileInfos.get(fileKey(path))?.modified ?? Date.now()) });
    }
    return entries;
  }
}

/** A notebook with a home page, ready to open. */
export async function createEmptyNotebook(store: NotebookStore, title: string, home = "Home", kind: NotebookInfo["kind"] = "open", location?: string): Promise<NotebookInfo> {
  const page: StoredPage = {
    name: home,
    text: newPageText(home, zimTimestamp()) + "\nThis notebook is empty. Make a page with New page, or follow a link to a page that doesn't exist yet.\n",
    bom: false,
    lineEnding: "lf",
    modified: Date.now(),
  };
  return store.createNotebook({ title, home, kind, ...(location ? { location } : {}) }, [page]);
}
