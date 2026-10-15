// One NotebookStore over three: the open notebooks (kept in the browser's IndexedDB), the encrypted
// ones (kept by the vault) and, in the desktop program, the folders of Zim files on the computer. The app
// asks for notebooks and pages without caring where they are; an encrypted or a folder notebook's id carries
// a prefix that says so, and while the vault is locked the encrypted notebooks are not listed (nothing is
// known of them but that they exist) and can't be touched.
import { FOLDER_PREFIX, isFolderId } from "./folder-store";
import type { FileInfo, NotebookInfo, NotebookStore, PageChange, StoredFile, StoredPage } from "./store";

/** What an encrypted notebook's id starts with. */
export const ENCRYPTED_PREFIX = "vault:";

export const isEncryptedId = (id: string): boolean => id.startsWith(ENCRYPTED_PREFIX);

export class RoutedStore implements NotebookStore {
  constructor(
    private readonly open: NotebookStore,
    private readonly encrypted: NotebookStore,
    /** Whether the vault is unlocked: only then are its notebooks there. */
    private readonly vaultOpen: () => boolean,
    /** Told when the encrypted notebooks can't be listed: the list is then the open ones, so that the app can still be used (and the vault locked). */
    private readonly onProblem?: (error: Error, which: "encrypted" | "folders") => void,
    /** The notebooks that are folders on the computer, where there is a program to give them. */
    private readonly folders?: NotebookStore,
  ) {}

  async listNotebooks(): Promise<NotebookInfo[]> {
    let open = await this.open.listNotebooks();
    if (this.folders) {
      try {
        open = [...open, ...(await this.folders.listNotebooks()).map((info) => ({ ...info, id: FOLDER_PREFIX + info.id }))];
      } catch (error) {
        this.onProblem?.(error instanceof Error ? error : new Error(String(error)), "folders");
      }
    }
    if (!this.vaultOpen()) return open;
    try {
      const encrypted = (await this.encrypted.listNotebooks()).map((info) => ({ ...info, id: ENCRYPTED_PREFIX + info.id }));
      return [...open, ...encrypted];
    } catch (error) {
      this.onProblem?.(error instanceof Error ? error : new Error(String(error)), "encrypted");
      return open;
    }
  }

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages?: StoredPage[], files?: StoredFile[]): Promise<NotebookInfo> {
    if (info.kind === "folder") {
      if (!this.folders) throw new Error("Notebooks in folders need the desktop program.");
      const made = await this.folders.createNotebook(info, pages, files);
      return { ...made, id: FOLDER_PREFIX + made.id };
    }
    if (info.kind !== "encrypted") return this.open.createNotebook(info, pages, files);
    this.assertOpen();
    const made = await this.encrypted.createNotebook(info, pages, files);
    return { ...made, id: ENCRYPTED_PREFIX + made.id };
  }

  async updateNotebook(info: NotebookInfo): Promise<void> {
    const [store, id] = this.route(info.id);
    return store.updateNotebook({ ...info, id });
  }

  async deleteNotebook(id: string): Promise<void> {
    const [store, inner] = this.route(id);
    return store.deleteNotebook(inner);
  }

  async loadPages(id: string): Promise<StoredPage[]> {
    const [store, inner] = this.route(id);
    return store.loadPages(inner);
  }

  async listFiles(id: string): Promise<FileInfo[]> {
    const [store, inner] = this.route(id);
    return store.listFiles(inner);
  }

  async loadFile(id: string, path: string): Promise<Blob | undefined> {
    const [store, inner] = this.route(id);
    return store.loadFile(inner, path);
  }

  async replacePages(id: string, change: PageChange): Promise<void> {
    const [store, inner] = this.route(id);
    return store.replacePages(inner, change);
  }

  private assertOpen(): void {
    if (!this.vaultOpen()) throw new Error("The encrypted notebooks are locked.");
  }

  private route(id: string): [NotebookStore, string] {
    if (isFolderId(id)) {
      if (!this.folders) throw new Error("Notebooks in folders need the desktop program.");
      return [this.folders, id.slice(FOLDER_PREFIX.length)];
    }
    if (!isEncryptedId(id)) return [this.open, id];
    this.assertOpen();
    return [this.encrypted, id.slice(ENCRYPTED_PREFIX.length)];
  }
}
