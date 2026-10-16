// A notebook that is encrypted, kept somewhere that must not be able to read it. Over any other remote (the account's space, a folder of a connected service) it keeps **objects**: one for each page
// and attachment, sealed by the engine (core/turtl-core-rs/src/seal.rs) under a name that says nothing, and one sealed index that holds the notebook's title and says which object is which file.
// To the sync it looks like any other remote, in the notebook's own file names: its marks are the SHA-256 of what each file says (which is what the sync makes of its own files, so two files that
// are the same show it), and its version is the other remote's. What the other remote sees is that objects exist, how big they are and when they change.
//
// An index is opened with the key, so it is known whose it is and that it was not changed; each page is checked against the sum the index gives; the index's counter is compared with the highest
// this device has seen, so that a whole old copy put back is noticed. What is written is written in an order that does not leave a reader with an index that lists what is not there: the objects first
// and the index last, and what is deleted after (the connected services do their changes in the order they are given; the account's space and git do them all at once).
import type { VaultSeal } from "../vault/seal";
import type { SealedFile, SealedIndex } from "../vault/seal";
import { base64ToBytes, bytesToBase64 } from "../vault/base64";
import type { ZipEntry } from "../zip";
import type { WireFile } from "./client";
import type { Manifest, Remote, Version } from "./remote";

/** The object that holds a notebook's index. */
export const INDEX_OBJECT = "index.zseal";
/** What a sealed notebook is called wherever it is kept (an id that says it is one, and nothing of what it holds). */
export const SEALED_PREFIX = "zsl-";
/** What the place that keeps the objects is told that the notebook is called. */
export const GENERIC_TITLE = "Encrypted notebook";

/** The engine seals and opens a bounded number of objects, and bytes, in one call: a notebook with many pages, or with big attachments, goes through in groups that are well inside what it accepts. */
export const GROUP_ITEMS = 1000;
export const GROUP_BYTES = 16 << 20;

/** Cut a list into groups of at most `GROUP_ITEMS` and about `GROUP_BYTES` (an item that is bigger than that alone is a group of its own), keeping the order. */
function inGroups<T>(items: T[], weight: (item: T) => number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const w = weight(item);
    if (current.length > 0 && (current.length >= GROUP_ITEMS || bytes + w > GROUP_BYTES)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += w;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The sealed copy can't be used as it is: it is damaged, it is another key's, it is older than one that was seen, or it is being written. The message says which, for the person. */
export class SealedCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedCopyError";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SealedRemote implements Remote {
  readonly place: string;
  counter: number | undefined;
  /** The index as it was read in this run (what a write builds on), and the version of the objects it was read with. */
  private index: SealedIndex | null = null;
  private objectsVersion: Version | null = null;

  /**
   * @param inner where the objects are kept
   * @param seal the vault's engine, for the keys
   * @param notebook the id the notebook's keys are made from (the same on every device)
   * @param seen the highest index counter that this device has seen of this notebook
   * @param title the notebook's name as it is now (it goes in the sealed index, nowhere else)
   */
  constructor(
    private readonly inner: Remote,
    private readonly seal: VaultSeal,
    private readonly notebook: string,
    private readonly seen: number,
    private readonly title: () => string,
  ) {
    this.place = inner.place;
  }

  private async readIndex(version: Version): Promise<SealedIndex> {
    const got = await this.inner.read([INDEX_OBJECT]);
    const file = got.files.find((f) => f.path === INDEX_OBJECT);
    if (!file) throw new SealedCopyError(`The sealed copy on ${this.place} has no index, so it can't be read.`);
    let index: SealedIndex;
    try {
      index = await this.seal.openIndex(this.notebook, base64ToBytes(file.base64));
    } catch {
      throw new SealedCopyError(`The sealed copy on ${this.place} can't be opened: it was sealed with another key, or it was changed.`);
    }
    if (index.counter < this.seen) {
      throw new SealedCopyError(`The copy on ${this.place} is older than one this device has seen (it is at version ${index.counter}, and this device saw ${this.seen}): it may have been put back. Stop keeping this notebook there, and keep it again, to start a new copy.`);
    }
    this.index = index;
    this.objectsVersion = version;
    this.counter = index.counter;
    return index;
  }

  async manifest(): Promise<Manifest | null> {
    const inner = await this.inner.manifest();
    if (!inner) {
      this.index = null;
      this.objectsVersion = null;
      return null;
    }
    const index = await this.readIndex(inner.version);
    // (an index lists only objects that were written before it: one that is missing is a copy that is being written, or that was damaged)
    for (const file of index.files) {
      if (inner.marks[file.name] === undefined) throw new SealedCopyError(`The sealed copy on ${this.place} is missing a page (it may be being written: try again in a moment).`);
    }
    return { version: inner.version, marks: Object.fromEntries(index.files.map((f) => [f.path, f.sha256])) };
  }

  async read(paths?: string[]): Promise<{ title?: string; files: WireFile[]; version: Version }> {
    const index = this.index ?? (await this.manifest(), this.index);
    if (!index) throw new SealedCopyError(`The sealed copy on ${this.place} is not there.`);
    const wanted = paths ? index.files.filter((f) => paths.includes(f.path)) : index.files;
    const got = wanted.length ? await this.inner.read(wanted.map((f) => f.name)) : { files: [] as WireFile[], version: this.objectsVersion ?? "" };
    const byName = new Map(got.files.map((f) => [f.path, f.base64]));
    const objects = wanted.map((f) => {
      const sealed = byName.get(f.name);
      if (sealed === undefined) throw new SealedCopyError(`The sealed copy on ${this.place} is missing a page (it may be being written: try again in a moment).`);
      return { name: f.name, sealed: base64ToBytes(sealed) };
    });
    const opened: Array<{ name: string; bytes: Uint8Array }> = [];
    try {
      for (const group of inGroups(objects, (o) => o.sealed.length)) opened.push(...(await this.seal.open(this.notebook, group)));
    } catch {
      throw new SealedCopyError(`A page of the sealed copy on ${this.place} can't be opened: the copy was changed, or it was being written. Try again in a moment.`);
    }
    const files: WireFile[] = [];
    for (const [i, entry] of wanted.entries()) {
      const bytes = (opened[i] as { bytes: Uint8Array }).bytes;
      // (an object that is not the one the index lists: a page that was replaced while the index was read, or an old object put back)
      if ((await sha256Hex(bytes)) !== entry.sha256) throw new SealedCopyError(`A page of the sealed copy on ${this.place} is not the one its index lists: the copy was being written. Try again in a moment.`);
      files.push({ path: entry.path, base64: bytesToBase64(bytes) });
    }
    return { title: index.title, files, version: this.objectsVersion ?? got.version };
  }

  async write(_title: string, put: ZipEntry[], remove: string[], base: Version): Promise<{ version: Version }> {
    const current: SealedIndex = this.index ?? { counter: 0, title: "", files: [] };
    const sealed: SealedFile[] = [];
    for (const group of inGroups(put, (f) => f.bytes.length)) sealed.push(...(await this.seal.seal(this.notebook, group.map((f) => ({ path: f.path, bytes: f.bytes })))));
    const removed = new Set(remove);
    const written = new Set(put.map((f) => f.path));
    const kept = current.files.filter((f) => !removed.has(f.path) && !written.has(f.path));
    const dropped = current.files.filter((f) => removed.has(f.path) && !written.has(f.path)).map((f) => f.name);
    const next: SealedIndex = {
      counter: Math.max(current.counter, this.seen) + 1,
      title: this.title(),
      files: [...kept, ...sealed.map((s) => ({ path: s.path, name: s.name, size: s.size, sha256: s.sha256 }))],
    };
    const sealedIndex = await this.seal.sealIndex(this.notebook, next);
    // the objects first and the index last, then what is gone (a change of the account's space or of git is made all at once, and in an order of no importance)
    const objects: ZipEntry[] = [...sealed.map((s) => ({ path: s.name, bytes: s.sealed })), { path: INDEX_OBJECT, bytes: sealedIndex }];
    const result = await this.inner.write(GENERIC_TITLE, objects, dropped, base);
    this.index = next;
    this.objectsVersion = result.version;
    this.counter = next.counter;
    return result;
  }

  remove(): Promise<void> {
    return this.inner.remove();
  }
}
