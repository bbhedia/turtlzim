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
  /** Make a notebook (with its pages, if any); returns it with the id and time it was given. */
  createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages?: StoredPage[]): Promise<NotebookInfo>;
  updateNotebook(info: NotebookInfo): Promise<void>;
  /** Delete a notebook and all its pages. */
  deleteNotebook(id: string): Promise<void>;
  loadPages(id: string): Promise<StoredPage[]>;
  /**
   * Remove the pages named in `remove` and write the pages in `put`, as one change that happens
   * entirely or not at all (a rename moves and rewrites many pages; half of it would lose links).
   */
  replacePages(id: string, change: { remove: string[]; put: StoredPage[] }): Promise<void>;
}

/** Notebooks kept in memory: for tests, and for a browser that won't let a page keep anything. */
export class MemoryStore implements NotebookStore {
  private readonly notebooks = new Map<string, { info: NotebookInfo; pages: Map<string, StoredPage> }>();
  private counter = 0;

  constructor(private readonly keyOf: (name: string) => string) {}

  async listNotebooks(): Promise<NotebookInfo[]> {
    return [...this.notebooks.values()].map((n) => ({ ...n.info })).sort((a, b) => a.created - b.created);
  }

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages: StoredPage[] = []): Promise<NotebookInfo> {
    const created: NotebookInfo = { ...info, id: `memory-${++this.counter}`, created: Date.now() + this.counter };
    const stored = new Map(pages.map((p) => [this.keyOf(p.name), { ...p }]));
    this.notebooks.set(created.id, { info: created, pages: stored });
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

  async replacePages(id: string, change: { remove: string[]; put: StoredPage[] }): Promise<void> {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`no notebook ${id}`);
    for (const name of change.remove) notebook.pages.delete(this.keyOf(name));
    for (const page of change.put) notebook.pages.set(this.keyOf(page.name), { ...page });
  }
}
