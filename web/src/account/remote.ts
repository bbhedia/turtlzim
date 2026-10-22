// Where a notebook's other copy is kept, as the sync sees it: a version, a mark for each of its files, and some calls. The account's own space, a folder of a connected service and a
// *sealed* copy (sealed-remote.ts, which holds its pages as objects it has sealed over one of the others) all look like this.
import type { ZipEntry } from "../zip";
import type { WireFile } from "./client";

export type Version = string | number;

/** What the other copy holds now: its version, and a mark for each of its files (a mark changes when the file's content does). */
export interface Manifest {
  version: Version;
  marks: Record<string, string>;
  /** The generation of the server's data (only the account's own space says it): a server whose data was put back to an older state, restored from a backup, has a new one. */
  epoch?: string;
}

export interface Remote {
  /** In words, for what is said to the person: “the server”, “My Nextcloud”. */
  place: string;
  /** What the copy holds now, or null if it is not there. */
  manifest(): Promise<Manifest | null>;
  /** Some of its files (all of them if no paths are given). */
  read(paths?: string[]): Promise<{ title?: string; files: WireFile[]; version: Version }>;
  /** Write these files and delete those, on top of the version `base` (the first write of a notebook has the base that a new one has: 0, or ""). */
  write(title: string, put: ZipEntry[], remove: string[], base: Version): Promise<{ version: Version }>;
  remove(): Promise<void>;
  /** For a sealed copy: the counter of the index that was last read or written (a device remembers the highest it has seen). */
  counter?: number;
}
