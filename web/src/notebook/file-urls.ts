// Addresses for the pictures of the open notebook. A stored file is a Blob; an <img> needs an address,
// and `URL.createObjectURL` makes one that lives until it is revoked. Making one is asynchronous (the
// bytes come from the store), so a picture is "loading" the first time it is asked for, and the host
// is told when it is ready to ask again.
import { pictureAddress } from "./media";
import type { NotebookSession } from "./session";
import { fileKey } from "./store";

export type PictureState = { status: "ready"; url: string } | { status: "loading" } | { status: "failed" };

interface Loaded {
  path: string;
  url: string;
  release: () => void;
  /** What the file was like when the address was made: if it changes, the address is stale. */
  size: number;
  modified: number;
}

export class FileUrls {
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private closed = false;

  constructor(
    private readonly session: NotebookSession,
    /** Called when a picture that was loading has arrived (or failed to). */
    private readonly onSettled: () => void,
  ) {}

  /** The address of the picture at `path`; if it isn't loaded yet, loading starts and `onSettled` will say when it is. */
  get(path: string): PictureState {
    const info = this.session.fileInfo(path);
    if (!info) return { status: "failed" }; // there is no such file
    const key = fileKey(info.path);
    const ready = this.loaded.get(key);
    if (ready) return { status: "ready", url: ready.url };
    if (this.failed.has(key)) return { status: "failed" };
    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.load(info.path, key);
    }
    return { status: "loading" };
  }

  private async load(path: string, key: string): Promise<void> {
    try {
      const blob = await this.session.fileBlob(path);
      const info = this.session.fileInfo(path);
      const address = blob && info ? await pictureAddress(blob) : null;
      if (this.closed) {
        address?.release();
        return;
      }
      if (address && info) this.loaded.set(key, { path: info.path, ...address, size: info.size, modified: info.modified });
      else this.failed.add(key);
    } catch {
      if (!this.closed) this.failed.add(key);
    } finally {
      this.loading.delete(key);
    }
    if (!this.closed) this.onSettled();
  }

  /** After files were added, removed, moved or replaced: forget the addresses of those that are not as they were. */
  sync(): void {
    for (const [key, entry] of this.loaded) {
      const now = this.session.fileInfo(entry.path);
      if (!now || now.size !== entry.size || now.modified !== entry.modified) {
        entry.release();
        this.loaded.delete(key);
      }
    }
    this.failed.clear();
  }

  /** The notebook was closed: release every address. */
  close(): void {
    this.closed = true;
    for (const entry of this.loaded.values()) entry.release();
    this.loaded.clear();
    this.loading.clear();
    this.failed.clear();
  }
}
