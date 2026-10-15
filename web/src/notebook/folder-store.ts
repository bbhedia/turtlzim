// Notebooks as folders of Zim files on the computer: pages are `.txt` files (`Projects:Garden` is `Projects/Garden.txt`), the folder named like a
// page holds its attachments, and `notebook.zim` marks the folder as a notebook, so Zim opens it as it is and so does git. This is a NotebookStore
// over the file system that a shell (the desktop program) gives through `window.__zimShell.folders`; the web app in a browser has none.
//
// A folder is the person's: what is listed is read, what a change touches is written (a page that is not valid UTF-8, a file whose name can't be a
// page or an attachment, a hidden file: not read, not changed), and deleting a notebook here only stops listing it. Files are read when the notebook
// is opened; what another program changes meanwhile is seen the next time it is.
import type { FolderEntry, FolderHooks } from "../app/shell";
import { pageToPath, pathToPage } from "../notebook-core";
import { encodePage } from "../zim";
import { mediaTypeFor, typed } from "./media";
import { fileKey } from "./store";
import type { FileInfo, NotebookInfo, NotebookStore, PageChange, StoredFile, StoredPage } from "./store";
import { notebookConfig, pagesFromFiles, parseNotebookConfig } from "./zim-files";

/** What a folder notebook's id starts with (the part after it is the shell's id of the folder). */
export const FOLDER_PREFIX = "folder:";

export const isFolderId = (id: string): boolean => id.startsWith(FOLDER_PREFIX);

const CONFIG = "notebook.zim";

/** What is known of an open folder: where each page and file is, spelled as it is on the disk. */
interface Opened {
  entries: Map<string, FolderEntry>;
  /** Page key to the path of its file. */
  pagePaths: Map<string, string>;
  /** The attachments that were taken in, by key. */
  files: Map<string, FolderEntry>;
}

/** The page that a file holds, or undefined if its name is not a page's. */
function nameOf(path: string): string | undefined {
  try {
    return pathToPage(path);
  } catch {
    return undefined;
  }
}

/** How many files are read at once. */
const READING = 12;

export class FolderStore implements NotebookStore {
  private readonly opened = new Map<string, Opened>();

  constructor(
    private readonly hooks: () => FolderHooks | undefined,
    private readonly keyOf: (name: string) => string,
  ) {}

  private shell(): FolderHooks {
    const hooks = this.hooks();
    if (!hooks) throw new Error("Notebooks in folders need the desktop program.");
    return hooks;
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const hooks = this.hooks();
    if (!hooks) return [];
    const roots = await hooks.roots();
    return Promise.all(roots.map(async (root, index): Promise<NotebookInfo> => {
      const config = root.exists ? await this.config(root.id) : {};
      return { id: root.id, title: config.name ?? (root.exists ? root.name : `${root.name} (not there)`), home: config.home ?? "Home", created: index, kind: "folder", location: root.id };
    }));
  }

  /**
   * Make a folder a notebook. With no pages, a folder that is already one (or holds Zim pages) is taken as it is, and nothing in it is written. With
   * pages (a new notebook) the pages and attachments are written, and `notebook.zim` if the folder has none.
   */
  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages?: StoredPage[], files: StoredFile[] = []): Promise<NotebookInfo> {
    const id = info.location;
    if (!id) throw new Error("A notebook in a folder needs the folder that was chosen.");
    const hooks = this.shell();
    const existing = await this.config(id);
    if (pages === undefined) {
      return { id, title: existing.name ?? info.title, home: existing.home ?? info.home, created: 0, kind: "folder", location: id };
    }
    const entries = await hooks.list(id);
    const writes: Array<{ path: string; bytes: Uint8Array; modified?: number }> = [];
    if (!entries.some((e) => e.path === CONFIG)) writes.push({ path: CONFIG, bytes: new TextEncoder().encode(notebookConfig(info)) });
    for (const page of pages) writes.push({ path: pageToPath(page.name), bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: page.modified });
    for (const file of files) writes.push({ path: file.path, bytes: new Uint8Array(await file.blob.arrayBuffer()), modified: file.modified });
    const taken = new Set(entries.map((e) => e.path.toLowerCase()));
    const clash = writes.find((w) => w.path !== CONFIG && taken.has(w.path.toLowerCase()));
    if (clash) throw new Error(`The folder already has a file named ${clash.path}: choose an empty folder for a new notebook.`);
    await hooks.apply(id, { writes, deletes: [], moves: [] });
    this.opened.delete(id);
    return { id, title: existing.name ?? info.title, home: existing.home ?? info.home, created: 0, kind: "folder", location: id };
  }

  /** The name and the home page are written into `notebook.zim`, where Zim keeps them; the rest of the file is kept as it is. */
  async updateNotebook(info: NotebookInfo): Promise<void> {
    const hooks = this.shell();
    const id = info.id;
    let text: string;
    try {
      text = new TextDecoder().decode(await hooks.read(id, CONFIG));
    } catch {
      text = notebookConfig(info);
    }
    const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
    const set = (source: string, key: string, value: string): string => {
      const lines = source.split("\n");
      let inNotebook = false;
      let found = false;
      const done = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) inNotebook = trimmed === "[Notebook]";
        else if (inNotebook && trimmed.startsWith(`${key}=`)) {
          found = true;
          return `${key}=${clean(value)}`;
        }
        return line;
      });
      if (found) return done.join("\n");
      const at = done.findIndex((line) => line.trim() === "[Notebook]");
      if (at < 0) return notebookConfig({ title: info.title, home: info.home });
      done.splice(at + 1, 0, `${key}=${clean(value)}`);
      return done.join("\n");
    };
    text = set(set(text, "name", info.title), "home", info.home);
    await hooks.apply(id, { writes: [{ path: CONFIG, bytes: new TextEncoder().encode(text) }], deletes: [], moves: [] });
  }

  /** The notebook is no longer listed. Its folder and everything in it stay where they are. */
  async deleteNotebook(id: string): Promise<void> {
    this.opened.delete(id);
    await this.shell().forget(id);
  }

  async loadPages(id: string): Promise<StoredPage[]> {
    const hooks = this.shell();
    const entries = await hooks.list(id);
    const toRead = entries.filter((e) => e.path.endsWith(".txt") || e.path === CONFIG);
    const read: Array<{ path: string; bytes: Uint8Array; modified: number }> = [];
    for (let at = 0; at < toRead.length; at += READING) {
      read.push(...(await Promise.all(toRead.slice(at, at + READING).map(async (e) => ({ path: e.path, bytes: await hooks.read(id, e.path), modified: e.modified })))));
    }
    // (a folder that has no notebook.zim is read as it is: the folder itself is the notebook, not the one folder that holds everything)
    if (!read.some((f) => f.path === CONFIG)) read.push({ path: CONFIG, bytes: new Uint8Array(), modified: 0 });
    const attachments = entries.filter((e) => !e.path.endsWith(".txt") && e.path !== CONFIG).map((e) => ({ path: e.path, modified: e.modified }));
    const imported = pagesFromFiles([...read, ...attachments]);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const opened: Opened = { entries: byPath, pagePaths: new Map(), files: new Map() };
    // (which file holds each page that was taken in: the importer took the first of the files that read as the same name)
    const taken = new Set(imported.pages.map((page) => this.keyOf(page.name)));
    for (const file of read) {
      if (!file.path.endsWith(".txt")) continue;
      let key: string;
      try {
        key = this.keyOf(pathToPage(file.path));
      } catch {
        continue;
      }
      if (taken.has(key) && !opened.pagePaths.has(key)) opened.pagePaths.set(key, file.path);
    }
    for (const file of imported.files) {
      const entry = byPath.get(file.path);
      if (entry) opened.files.set(fileKey(file.path), entry);
    }
    this.opened.set(id, opened);
    return imported.pages;
  }

  async listFiles(id: string): Promise<FileInfo[]> {
    const opened = this.opened.get(id) ?? (await this.load(id));
    return [...opened.files.values()].map((e) => ({ path: e.path, size: e.size, type: mediaTypeFor(e.path), modified: e.modified }));
  }

  async loadFile(id: string, path: string): Promise<Blob | undefined> {
    const opened = this.opened.get(id) ?? (await this.load(id));
    const entry = opened.files.get(fileKey(path));
    if (!entry) return undefined;
    return typed(new Blob([await this.shell().read(id, entry.path) as BlobPart]), entry.path);
  }

  async replacePages(id: string, change: PageChange): Promise<void> {
    const hooks = this.shell();
    const opened = this.opened.get(id) ?? (await this.load(id));
    const placeOf = (path: string) => opened.files.get(fileKey(path))?.path ?? path;
    const onDisk = (path: string) => opened.entries.has(path);

    const moves: Array<[string, string]> = (change.files?.move ?? []).filter(([from]) => opened.files.has(fileKey(from))).map(([from, to]) => [placeOf(from), to]);
    const deletes = new Set<string>();
    const forget = (path: string | undefined) => path !== undefined && onDisk(path) && deletes.add(path);
    for (const name of change.remove) forget(opened.pagePaths.get(this.keyOf(name)));
    for (const path of change.files?.remove ?? []) forget(opened.files.get(fileKey(path))?.path);
    // (a file that is moved onto a path, or written at one, takes the place of the file that has it, spelled as that file is: names ignore case, a disk may not)
    for (const [, to] of moves) {
      const there = opened.files.get(fileKey(to))?.path;
      if (there !== to) forget(there);
    }

    const writes: Array<{ path: string; bytes: Uint8Array; modified?: number }> = [];
    const written = new Map<string, string>();
    for (const page of change.put) {
      const key = this.keyOf(page.name);
      const existing = opened.pagePaths.get(key);
      // A page that has a file is written to it, spelled as the file is (Zim's own files may say `My Note.txt` where it would write `My_Note.txt`); a page
      // that is new, or whose name is spelled another way (only the case can differ), is written where its name says, and the file it had goes.
      let path = existing;
      if (existing === undefined || nameOf(existing) !== page.name) {
        path = pageToPath(page.name);
        if (existing !== undefined && existing !== path) forget(existing);
      }
      writes.push({ path: path as string, bytes: encodePage({ text: page.text, bom: page.bom, lineEnding: page.lineEnding }), modified: page.modified });
      written.set(key, path as string);
    }
    for (const file of change.files?.put ?? []) {
      const there = opened.files.get(fileKey(file.path))?.path;
      if (there !== file.path) forget(there);
      writes.push({ path: file.path, bytes: new Uint8Array(await file.blob.arrayBuffer()), modified: file.modified });
    }
    await hooks.apply(id, { writes, deletes: [...deletes], moves });

    // what is known of the folder after the change
    for (const name of change.remove) opened.pagePaths.delete(this.keyOf(name));
    for (const [key, path] of written) opened.pagePaths.set(key, path);
    const moved = new Map<string, FolderEntry>();
    for (const [from, to] of moves) {
      const was = opened.files.get(fileKey(from));
      if (was) moved.set(fileKey(to), { ...was, path: to });
    }
    for (const [from] of moves) opened.files.delete(fileKey(from));
    for (const path of change.files?.remove ?? []) opened.files.delete(fileKey(path));
    for (const [key, entry] of moved) opened.files.set(key, entry);
    for (const file of change.files?.put ?? []) opened.files.set(fileKey(file.path), { path: file.path, size: file.blob.size, modified: file.modified });
    opened.entries = new Map((await hooks.list(id)).map((e) => [e.path, e]));
  }

  private async load(id: string): Promise<Opened> {
    await this.loadPages(id);
    return this.opened.get(id) as Opened;
  }

  /** The name and home page `notebook.zim` of a folder gives, if it has one. */
  private async config(id: string): Promise<{ name?: string; home?: string }> {
    try {
      return parseNotebookConfig(new TextDecoder().decode(await this.shell().read(id, CONFIG)));
    } catch {
      return {};
    }
  }
}
