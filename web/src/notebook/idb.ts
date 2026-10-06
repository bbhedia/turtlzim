import type { NotebookInfo, NotebookStore, StoredPage } from "./store";

const DATABASE = "zim-notebooks";
const VERSION = 1;

/** One page row. The key is [notebook id, page key]: all of a notebook's pages are one key range. */
interface PageRow extends StoredPage {
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

  static async open(keyOf: (name: string) => string, name = DATABASE): Promise<IndexedDbStore> {
    const opening = indexedDB.open(name, VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore("notebooks", { keyPath: "id" });
      db.createObjectStore("pages", { keyPath: ["notebook", "key"] });
    };
    return new IndexedDbStore(await request(opening), keyOf);
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

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages: StoredPage[] = []): Promise<NotebookInfo> {
    const created: NotebookInfo = { ...info, id: crypto.randomUUID(), created: Date.now() };
    await this.write(["notebooks", "pages"], (tx) => {
      tx.objectStore("notebooks").put(created);
      for (const page of pages) tx.objectStore("pages").put(this.row(created.id, page));
    });
    return created;
  }

  async updateNotebook(info: NotebookInfo): Promise<void> {
    await this.write(["notebooks"], (tx) => void tx.objectStore("notebooks").put(info));
  }

  async deleteNotebook(id: string): Promise<void> {
    await this.write(["notebooks", "pages"], (tx) => {
      tx.objectStore("notebooks").delete(id);
      tx.objectStore("pages").delete(IDBKeyRange.bound([id], [id, []]));
    });
  }

  async loadPages(id: string): Promise<StoredPage[]> {
    const tx = this.db.transaction("pages", "readonly");
    const rows = (await request(tx.objectStore("pages").getAll(IDBKeyRange.bound([id], [id, []])))) as PageRow[];
    return rows.map(({ notebook: _notebook, key: _key, ...page }) => page);
  }

  async replacePages(id: string, change: { remove: string[]; put: StoredPage[] }): Promise<void> {
    // What went wrong inside the transaction's callback is kept here and thrown from this function:
    // an exception thrown from an event handler would be reported as an uncaught error instead.
    let missing = false;
    let problem: unknown;
    try {
      await this.write(["notebooks", "pages"], (tx) => {
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

  private row(notebook: string, page: StoredPage): PageRow {
    return { ...page, notebook, key: this.keyOf(page.name) };
  }
}
