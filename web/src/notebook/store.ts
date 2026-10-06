// Where a notebook's pages are kept. The notebook rules (core/zim-notebook) never touch storage; a
// store holds what a session gives it and hands it back, so the same session logic runs over the
// browser's IndexedDB, over memory (tests, or a browser that won't let a page keep data), and,
// later, over a folder of `.txt` files or encrypted records.
import type { LineEnding } from "../zim";

/** A page as stored: its text, and the properties of the file it came from, so a saved file is
 *  written back as it was read (see `PageFile`). */
export interface StoredPage {
  /** The page's name, spelled as the notebook spells it. */
  name: string;
  text: string;
  bom: boolean;
  lineEnding: LineEnding;
  /** When the text was last changed (ms since the epoch). */
  modified: number;
}

/**
 * A file (an attachment) as stored: its path in the notebook folder, spelled as the notebook spells
 * it (`Usage/GTD_flowchart.png`), and what it holds. A `Blob` is how a browser keeps bytes without
 * holding them in memory, and its `type` is the file's media type.
 */
export interface StoredFile {
  path: string;
  blob: Blob;
  /** When the file was last written (ms since the epoch). */
  modified: number;
}

/** What is known about a stored file without reading it. */
export interface FileInfo {
  path: string;
  size: number;
  type: string;
  modified: number;
}

/** What a store compares file paths by: the path in lower case, as the notebook rules do. */
export const fileKey = (path: string): string => path.toLowerCase();

/** A change to a notebook's files, made together with a change to its pages. */
export interface FileChange {
  /** Files to move, as [from, to]: the bytes go with them. Applied first. */
  move?: Array<[from: string, to: string]>;
  /** Paths of files to forget. */
  remove?: string[];
  /** Files to write, replacing any at the same path. Applied last. */
  put?: StoredFile[];
}

/** A change to a notebook's pages, and optionally its files, that happens entirely or not at all. */
export interface PageChange {
  remove: string[];
  put: StoredPage[];
  files?: FileChange;
}

export interface NotebookInfo {
  id: string;
  title: string;
  /** The page shown when the notebook is opened. */
  home: string;
  created: number;
  /** "open": plain pages. (Encrypted notebooks come later and are another kind of store.) */
  kind: "open";
}

export interface NotebookStore {
  listNotebooks(): Promise<NotebookInfo[]>;
  /** Make a notebook (with its pages and files, if any); returns it with the id and time it was given. */
  createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages?: StoredPage[], files?: StoredFile[]): Promise<NotebookInfo>;
  updateNotebook(info: NotebookInfo): Promise<void>;
  /** Delete a notebook and all its pages and files. */
  deleteNotebook(id: string): Promise<void>;
  loadPages(id: string): Promise<StoredPage[]>;
  /** The files of a notebook, without their bytes. */
  listFiles(id: string): Promise<FileInfo[]>;
  /** The bytes of one file, if the notebook has it. */
  loadFile(id: string, path: string): Promise<Blob | undefined>;
  /**
   * Remove the pages named in `remove` and write the pages in `put`, and change files as `files`
   * says (moves first, then removals, then writes), as one change that happens entirely or not at
   * all (a rename moves and rewrites many pages and moves their files; half of it would lose links).
   */
  replacePages(id: string, change: PageChange): Promise<void>;
}

/** Notebooks kept in memory: for tests, and for a browser that won't let a page keep anything. */
export class MemoryStore implements NotebookStore {
  private readonly notebooks = new Map<string, { info: NotebookInfo; pages: Map<string, StoredPage>; files: Map<string, StoredFile> }>();
  private counter = 0;

  constructor(private readonly keyOf: (name: string) => string) {}

  async listNotebooks(): Promise<NotebookInfo[]> {
    return [...this.notebooks.values()].map((n) => ({ ...n.info })).sort((a, b) => a.created - b.created);
  }

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages: StoredPage[] = [], files: StoredFile[] = []): Promise<NotebookInfo> {
    const created: NotebookInfo = { ...info, id: `memory-${++this.counter}`, created: Date.now() + this.counter };
    const stored = new Map(pages.map((p) => [this.keyOf(p.name), { ...p }]));
    this.notebooks.set(created.id, { info: created, pages: stored, files: new Map(files.map((f) => [fileKey(f.path), { ...f }])) });
    return { ...created };
  }

  async updateNotebook(info: NotebookInfo): Promise<void> {
    const notebook = this.notebooks.get(info.id);
    if (!notebook) throw new Error(`no notebook ${info.id}`);
    notebook.info = { ...info };
  }

  async deleteNotebook(id: string): Promise<void> {
    this.notebooks.delete(id);
  }

  async loadPages(id: string): Promise<StoredPage[]> {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`no notebook ${id}`);
    return [...notebook.pages.values()].map((p) => ({ ...p }));
  }

  async listFiles(id: string): Promise<FileInfo[]> {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`no notebook ${id}`);
    return [...notebook.files.values()].map((f) => ({ path: f.path, size: f.blob.size, type: f.blob.type, modified: f.modified }));
  }

  async loadFile(id: string, path: string): Promise<Blob | undefined> {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`no notebook ${id}`);
    return notebook.files.get(fileKey(path))?.blob;
  }

  async replacePages(id: string, change: PageChange): Promise<void> {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`no notebook ${id}`);
    for (const name of change.remove) notebook.pages.delete(this.keyOf(name));
    for (const page of change.put) notebook.pages.set(this.keyOf(page.name), { ...page });
    const files = change.files;
    if (files) {
      // every moved file is read before any is written, so that moves can swap places
      const moved = (files.move ?? []).flatMap(([from, to]) => {
        const file = notebook.files.get(fileKey(from));
        return file ? [{ ...file, path: to }] : [];
      });
      for (const [from] of files.move ?? []) notebook.files.delete(fileKey(from));
      for (const path of files.remove ?? []) notebook.files.delete(fileKey(path));
      for (const file of [...moved, ...(files.put ?? [])]) notebook.files.set(fileKey(file.path), { ...file });
    }
  }
}
