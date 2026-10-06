import { fileKey } from "./store";
import type { FileChange, FileInfo, NotebookInfo, NotebookStore, PageChange, StoredFile, StoredPage } from "./store";

const DATABASE = "zim-notebooks";
/** 1: notebooks and pages. 2: files (attachments). */
const VERSION = 2;

/** One page row. The key is [notebook id, page key]: all of a notebook's pages are one key range. */
interface PageRow extends StoredPage {
  notebook: string;
  key: string;
}

/** One file row, keyed like a page row: all of a notebook's files are one key range. */
interface FileRow extends StoredFile {
  notebook: string;
  key: string;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Notebooks kept in the browser's IndexedDB, as plain pages (an "open" notebook). It survives
 * reloads and restarts but belongs to this browser profile and can be cleared by the user or, on a
 * browser under storage pressure, by the browser: `requestPersistence()` asks it not to, where it
 * can, and export (a zip of `.txt` files) is the way to get a notebook out.
 */
export class IndexedDbStore implements NotebookStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly keyOf: (name: string) => string,
  ) {}

  /**
   * Open the database, upgrading it if it is older. An upgrade has to wait for every other tab that has the
   * database open to let go of it, so `onBlocked` says when this one is being kept waiting (and the
   * open goes on when they do), and a connection made here lets go as soon as another tab asks to
   * upgrade, saying so through `onVersionChange`: after that this store can't be used any more.
   */
  static async open(
    keyOf: (name: string) => string,
    name = DATABASE,
    events: { onBlocked?: () => void; onVersionChange?: () => void } = {},
  ): Promise<IndexedDbStore> {
    const opening = indexedDB.open(name, VERSION);
    opening.onupgradeneeded = (event) => {
      const db = opening.result;
      if (event.oldVersion < 1) {
        db.createObjectStore("notebooks", { keyPath: "id" });
        db.createObjectStore("pages", { keyPath: ["notebook", "key"] });
      }
      if (event.oldVersion < 2) db.createObjectStore("files", { keyPath: ["notebook", "key"] });
    };
    opening.onblocked = () => events.onBlocked?.();
    const db = await request(opening);
    db.onversionchange = () => {
      db.close();
      events.onVersionChange?.();
    };
    return new IndexedDbStore(db, keyOf);
  }

  /** Ask the browser to keep this site's data until the user says otherwise (a secure origin only). */
  static async requestPersistence(): Promise<boolean> {
    try {
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const tx = this.db.transaction("notebooks", "readonly");
    const all = (await request(tx.objectStore("notebooks").getAll())) as NotebookInfo[];
    return all.sort((a, b) => a.created - b.created);
  }

  /**
   * Run `queue` (which only *queues* requests) in a read-write transaction over `stores`, and wait
   * for it to commit. If queuing throws, the transaction is aborted, so that nothing it queued
   * before the throw is kept: a change is written entirely or not at all.
   */
  private async write(stores: string[], queue: (tx: IDBTransaction) => void): Promise<void> {
    const tx = this.db.transaction(stores, "readwrite");
    try {
      queue(tx);
    } catch (error) {
      tx.abort();
      throw error;
    }
    await finished(tx);
  }

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages: StoredPage[] = [], files: StoredFile[] = []): Promise<NotebookInfo> {
    const created: NotebookInfo = { ...info, id: crypto.randomUUID(), created: Date.now() };
    await this.write(["notebooks", "pages", "files"], (tx) => {
      tx.objectStore("notebooks").put(created);
      for (const page of pages) tx.objectStore("pages").put(this.row(created.id, page));
      for (const file of files) tx.objectStore("files").put(this.fileRow(created.id, file));
    });
    return created;
  }

  async updateNotebook(info: NotebookInfo): Promise<void> {
    await this.write(["notebooks"], (tx) => void tx.objectStore("notebooks").put(info));
  }

  async deleteNotebook(id: string): Promise<void> {
    await this.write(["notebooks", "pages", "files"], (tx) => {
      tx.objectStore("notebooks").delete(id);
      tx.objectStore("pages").delete(IDBKeyRange.bound([id], [id, []]));
      tx.objectStore("files").delete(IDBKeyRange.bound([id], [id, []]));
    });
  }

  async loadPages(id: string): Promise<StoredPage[]> {
    const tx = this.db.transaction("pages", "readonly");
    const rows = (await request(tx.objectStore("pages").getAll(IDBKeyRange.bound([id], [id, []])))) as PageRow[];
    return rows.map(({ notebook: _notebook, key: _key, ...page }) => page);
  }

  async listFiles(id: string): Promise<FileInfo[]> {
    const tx = this.db.transaction("files", "readonly");
    const rows = (await request(tx.objectStore("files").getAll(IDBKeyRange.bound([id], [id, []])))) as FileRow[];
    return rows.map((r) => ({ path: r.path, size: r.blob.size, type: r.blob.type, modified: r.modified }));
  }

  async loadFile(id: string, path: string): Promise<Blob | undefined> {
    const tx = this.db.transaction("files", "readonly");
    const row = (await request(tx.objectStore("files").get([id, fileKey(path)]))) as FileRow | undefined;
    return row?.blob;
  }

  async replacePages(id: string, change: PageChange): Promise<void> {
    // What went wrong inside the transaction's callback is kept here and thrown from this function:
    // an exception thrown from an event handler would be reported as an uncaught error instead.
    let missing = false;
    let problem: unknown;
    const fail = (error: unknown) => {
      problem = error;
    };
    try {
      await this.write(change.files ? ["notebooks", "pages", "files"] : ["notebooks", "pages"], (tx) => {
        // The notebook has to exist (it may have been deleted from another tab): the check and the
        // writes are one transaction, so nothing is written for a notebook that is gone.
        const exists = tx.objectStore("notebooks").getKey(id);
        exists.onsuccess = () => {
          if (exists.result === undefined) {
            missing = true;
            tx.abort();
            return;
          }
          try {
            const pages = tx.objectStore("pages");
            for (const name of change.remove) pages.delete([id, this.keyOf(name)]);
            for (const page of change.put) pages.put(this.row(id, page));
            if (change.files) this.queueFiles(tx, id, change.files, (error) => {
              fail(error);
              tx.abort();
            });
          } catch (error) {
            problem = error;
            tx.abort();
          }
        };
      });
    } catch (error) {
      if (missing) throw new Error("That notebook no longer exists.");
      throw problem ?? error;
    }
  }

  /**
   * Queue a change of files in `tx`: moved files are read first (the bytes stay with the file),
   * then everything that goes is deleted and everything that comes is written. A moved file that
   * isn't stored is skipped.
   */
  private queueFiles(tx: IDBTransaction, id: string, change: FileChange, fail: (error: unknown) => void): void {
    const store = tx.objectStore("files");
    const moves = change.move ?? [];
    const apply = (moved: FileRow[]) => {
      for (const [from] of moves) store.delete([id, fileKey(from)]);
      for (const path of change.remove ?? []) store.delete([id, fileKey(path)]);
      for (const row of moved) store.put(row);
      for (const file of change.put ?? []) store.put(this.fileRow(id, file));
    };
    if (moves.length === 0) return apply([]);
    const moved: FileRow[] = [];
    let waiting = moves.length;
    for (const [from, to] of moves) {
      const read = store.get([id, fileKey(from)]);
      read.onsuccess = () => {
        try {
          const row = read.result as FileRow | undefined;
          if (row) moved.push({ ...row, path: to, key: fileKey(to) });
          if (--waiting === 0) apply(moved);
        } catch (error) {
          fail(error);
        }
      };
    }
  }

  private row(notebook: string, page: StoredPage): PageRow {
    return { ...page, notebook, key: this.keyOf(page.name) };
  }

  private fileRow(notebook: string, file: StoredFile): FileRow {
    return { ...file, notebook, key: fileKey(file.path) };
  }
}
