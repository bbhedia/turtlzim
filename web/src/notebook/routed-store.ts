// One NotebookStore over two: the open notebooks (kept in the browser's IndexedDB) and the encrypted
// ones (kept by the vault). The app asks for notebooks and pages without caring where they are; an
// encrypted notebook's id carries a prefix that says so, and while the vault is locked those
// notebooks are not listed (nothing is known of them but that they exist) and can't be touched.
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
    private readonly onProblem?: (error: Error) => void,
  ) {}

  async listNotebooks(): Promise<NotebookInfo[]> {
    const open = await this.open.listNotebooks();
    if (!this.vaultOpen()) return open;
    try {
      const encrypted = (await this.encrypted.listNotebooks()).map((info) => ({ ...info, id: ENCRYPTED_PREFIX + info.id }));
      return [...open, ...encrypted];
    } catch (error) {
      this.onProblem?.(error instanceof Error ? error : new Error(String(error)));
      return open;
    }
  }

  async createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages?: StoredPage[], files?: StoredFile[]): Promise<NotebookInfo> {
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
    if (!isEncryptedId(id)) return [this.open, id];
    this.assertOpen();
    return [this.encrypted, id.slice(ENCRYPTED_PREFIX.length)];
  }
}
