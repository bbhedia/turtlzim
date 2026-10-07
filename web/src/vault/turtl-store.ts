// Notebooks kept as ciphertext: a NotebookStore over the core, which encrypts everything it saves.
//
//   a notebook          a space (its title is encrypted with the space's own key)
//   its settings        one note of type `zim-notebook` (home page, creation time)
//   a page              a note of type `zim-page`: the page's name is the note's title, the Zim text
//                       its text, and how the file was written (byte-order mark, line endings, time)
//                       its `props`
//   an attachment       a note of type `zim-file`: the path is the title, the bytes the note's file
//
// Names, texts, paths and bytes are all in the encrypted part of what the core keeps. What isn't
// (the core's public fields) is ids, which space a note is in, when it was last saved, and how big
// the ciphertext is: see docs/zim-encrypted-notebooks.md.
//
// Every change is one batch of the core's: all of a rename's moved pages and rewritten links and moved
// files arrive together or not at all, and writing a notebook of thousands of pages is one commit.
import type { CoreClient } from "./core-client";
import { fileKey } from "../notebook/store";
import type { FileChange, FileInfo, NotebookInfo, NotebookStore, PageChange, StoredFile, StoredPage } from "../notebook/store";
import type { LineEnding } from "../zim";

const PAGE = "zim-page";
const FILE = "zim-file";
const META = "zim-notebook";
const NOTEBOOK_COLOR = "#408080";

/** The most one attachment may be in an encrypted notebook: a file goes through the engine whole, as text. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface CoreNote {
  id: string;
  type?: string;
  title?: string;
  text?: string;
  props?: Record<string, unknown>;
  file?: { name?: string; type?: string; size?: number };
  mod?: number;
}

interface CoreSpace {
  id: string;
  title?: string;
}

/** A page as the core keeps it. */
interface PageEntry {
  noteId: string;
  name: string;
}

/** An attachment as the core keeps it: what is known without reading its bytes. */
interface FileEntry {
  noteId: string;
  path: string;
  type: string;
  size: number;
  modified: number;
}

interface NotebookIndex {
  metaId: string;
  pages: Map<string, PageEntry>;
  files: Map<string, FileEntry>;
}

/** A file as a change will leave it: `noteId` is null for one that is new, `blob` is there when its bytes are to be written. */
interface PlannedFile {
  noteId: string | null;
  path: string;
  type: string;
  size: number;
  modified: number;
  blob?: Blob;
  changed: boolean;
}

const LINE_ENDINGS: readonly string[] = ["lf", "crlf", "mixed"];

function pageOf(note: CoreNote): StoredPage {
  const props = note.props ?? {};
  return {
    name: note.title ?? "",
    text: note.text ?? "",
    bom: props.bom === true,
    lineEnding: (typeof props.eol === "string" && LINE_ENDINGS.includes(props.eol) ? props.eol : "lf") as LineEnding,
    modified: typeof props.modified === "number" ? props.modified : (note.mod ?? 0) * 1000,
  };
}

function fileOf(note: CoreNote): FileEntry {
  const props = note.props ?? {};
  return {
    noteId: note.id,
    path: note.title ?? note.file?.name ?? "",
    type: note.file?.type ?? "",
    size: note.file?.size ?? 0,
    modified: typeof props.modified === "number" ? props.modified : (note.mod ?? 0) * 1000,
  };
}

/** When a space was made, as far as its id says (the first twelve hex digits of the long ids are the time in ms). */
function idTime(id: string): number {
  const ms = /^[0-9a-f]{80}$/.test(id) ? parseInt(id.slice(0, 12), 16) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(encoded: string, type: string): Blob {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export class TurtlStore implements NotebookStore {
  private readonly indexes = new Map<string, NotebookIndex>();
  private lastCore: CoreClient | null = null;
  private lastCreated = 0;
  /** Everything the store is asked to do goes through here, one at a time: what the core's batches need, and what the indexes need to stay true. */
  private queue: Promise<unknown> = Promise.resolve();
  private broken: Error | null = null;

  /** `core` is where the vault's engine is found each time the store is used (it is a different one after every unlock). */
  constructor(
    private readonly core: () => CoreClient,
    private readonly keyOf: (name: string) => string,
  ) {}

  // ---- notebooks

  listNotebooks(): Promise<NotebookInfo[]> {
    return this.run(async (core) => {
      const spaces = (await core.request<{ spaces: CoreSpace[] }>("profile:load")).spaces;
      const infos: NotebookInfo[] = [];
      for (const space of spaces) {
        const meta = (await this.find(core, space.id, META))[0];
        const props = meta?.props ?? {};
        infos.push({
          id: space.id,
          title: space.title ?? "",
          home: typeof props.home === "string" ? props.home : "Home",
          created: typeof props.created === "number" ? props.created : idTime(space.id),
          kind: "encrypted",
        });
      }
      return infos.sort((a, b) => a.created - b.created);
    });
  }

  createNotebook(info: Omit<NotebookInfo, "id" | "created">, pages: StoredPage[] = [], files: StoredFile[] = []): Promise<NotebookInfo> {
    return this.run(async (core) => {
      const keptPages = this.lastWins(pages, (page) => this.keyOf(page.name));
      const keptFiles = this.lastWins(files, (file) => fileKey(file.path));
      for (const file of keptFiles) this.checkSize(file.path, file.blob);
      const created = Math.max(Date.now(), this.lastCreated + 1);
      const made = await this.batch(core, async () => {
        const space = await this.save<CoreSpace>(core, "add", "space", { user_id: "0", title: info.title, color: NOTEBOOK_COLOR });
        const meta = await this.save<CoreNote>(core, "add", "note", this.metaNote(space.id, { home: info.home, created }));
        const index: NotebookIndex = { metaId: meta.id, pages: new Map(), files: new Map() };
        for (const page of keptPages) {
          const note = await this.save<CoreNote>(core, "add", "note", this.pageNote(space.id, page));
          index.pages.set(this.keyOf(page.name), { noteId: note.id, name: page.name });
        }
        for (const file of keptFiles) {
          const note = await this.save<CoreNote>(core, "add", "note", await this.fileNote(space.id, file));
          index.files.set(fileKey(file.path), { noteId: note.id, path: file.path, type: file.blob.type, size: file.blob.size, modified: file.modified });
        }
        return { id: space.id, index };
      });
      this.lastCreated = created;
      this.indexes.set(made.id, made.index);
      return { id: made.id, title: info.title, home: info.home, created, kind: "encrypted" };
    });
  }

  updateNotebook(info: NotebookInfo): Promise<void> {
    return this.run(async (core) => {
      const index = await this.indexOf(core, info.id);
      const current = (await core.request<{ spaces: CoreSpace[] }>("profile:load")).spaces.find((space) => space.id === info.id);
      await this.batch(core, async () => {
        if (current?.title !== info.title) await this.save(core, "edit", "space", { id: info.id, user_id: "0", title: info.title, color: NOTEBOOK_COLOR });
        // the settings note: what is in it is all there is to it, so it is written whole
        await this.save(core, "edit", "note", { id: index.metaId, ...this.metaNote(info.id, { home: info.home, created: info.created }) });
      });
    });
  }

  deleteNotebook(id: string): Promise<void> {
    return this.run(async (core) => {
      await this.batch(core, async () => {
        // the core deletes the space's notes and files with it
        await this.save(core, "delete", "space", { id });
      });
      this.indexes.delete(id);
    });
  }

  // ---- pages and files

  loadPages(id: string): Promise<StoredPage[]> {
    return this.run(async (core) => (await this.read(core, id)).pages.map(pageOf).filter((page) => page.name !== ""));
  }

  listFiles(id: string): Promise<FileInfo[]> {
    return this.run(async (core) => {
      const { index } = await this.read(core, id);
      return [...index.files.values()].map(({ path, size, type, modified }) => ({ path, size, type, modified }));
    });
  }

  loadFile(id: string, path: string): Promise<Blob | undefined> {
    return this.run(async (core) => {
      const index = await this.indexOf(core, id);
      const entry = index.files.get(fileKey(path));
      if (!entry) return undefined;
      return fromBase64(await core.request<string>("profile:note:get-file", entry.noteId), entry.type);
    });
  }

  replacePages(id: string, change: PageChange): Promise<void> {
    return this.run(async (core) => {
      const index = await this.indexOf(core, id);
      const pages = this.planPages(index, change);
      const files = change.files ? this.planFiles(index, change.files) : null;
      for (const entry of files?.entries ?? []) if (entry.blob) this.checkSize(entry.path, entry.blob);
      await this.batch(core, async () => {
        for (const noteId of pages.removed) await this.save(core, "delete", "note", { id: noteId });
        for (const page of pages.written) {
          if (page.noteId) await this.save(core, "edit", "note", { id: page.noteId, ...this.pageNote(id, page.page) });
          else page.noteId = (await this.save<CoreNote>(core, "add", "note", this.pageNote(id, page.page))).id;
        }
        if (files) {
          for (const noteId of files.removed) await this.save(core, "delete", "note", { id: noteId });
          for (const entry of files.entries) {
            if (!entry.changed) continue;
            const data = await this.fileNoteOf(id, entry);
            if (entry.noteId) await this.save(core, "edit", "note", { id: entry.noteId, ...data });
            else entry.noteId = (await this.save<CoreNote>(core, "add", "note", data)).id;
          }
        }
      });
      // what the core holds now, as the indexes see it (only after the batch is kept: until then they were true)
      index.pages = new Map(pages.written.map((page) => [this.keyOf(page.page.name), { noteId: page.noteId as string, name: page.page.name }] as const));
      for (const [key, entry] of pages.untouched) index.pages.set(key, entry);
      if (files) {
        index.files = new Map(files.entries.map((entry) => [fileKey(entry.path), { noteId: entry.noteId as string, path: entry.path, type: entry.type, size: entry.size, modified: entry.modified }] as const));
      }
    });
  }

  // ---- what a change comes to

  /** What a change of pages does: the notes to delete, and the pages to write (a page that is already a note is edited, so keeps its id). */
  private planPages(index: NotebookIndex, change: PageChange) {
    const staying = new Map(index.pages);
    for (const name of change.remove) staying.delete(this.keyOf(name));
    const written = new Map<string, { page: StoredPage; noteId: string | null }>();
    for (const page of change.put) {
      const key = this.keyOf(page.name);
      // a page that was there keeps its note, also when it was removed in the same change (a rename of the case alone)
      written.set(key, { page, noteId: index.pages.get(key)?.noteId ?? null });
    }
    const untouched = new Map([...staying].filter(([key]) => !written.has(key)));
    const kept = new Set<string>([...untouched.values()].map((entry) => entry.noteId));
    for (const entry of written.values()) if (entry.noteId) kept.add(entry.noteId);
    const removed = [...index.pages.values()].map((entry) => entry.noteId).filter((noteId) => !kept.has(noteId));
    return { removed, written: [...written.values()], untouched };
  }

  /**
   * What a change of files comes to: the files there will be (by path), which notes go, and which have to be
   * written. Moves are read before anything is written (so files can swap), then removals, then writes, as
   * the store's contract says.
   */
  private planFiles(index: NotebookIndex, change: FileChange) {
    const state = new Map<string, PlannedFile>([...index.files].map(([key, entry]) => [key, { ...entry, changed: false }]));
    const moved: PlannedFile[] = [];
    for (const [from, to] of change.move ?? []) {
      const entry = state.get(fileKey(from));
      if (entry) moved.push({ ...entry, path: to, changed: true });
    }
    for (const [from] of change.move ?? []) state.delete(fileKey(from));
    for (const path of change.remove ?? []) state.delete(fileKey(path));
    for (const entry of moved) state.set(fileKey(entry.path), entry);
    for (const file of change.put ?? []) {
      const key = fileKey(file.path);
      // writing over a file that is there (as the moves and removals have left things) writes over its note too
      const noteId = state.get(key)?.noteId ?? null;
      state.set(key, { noteId, path: file.path, type: file.blob.type, size: file.blob.size, modified: file.modified, blob: file.blob, changed: true });
    }
    const entries = [...state.values()];
    const kept = new Set(entries.map((entry) => entry.noteId).filter((noteId): noteId is string => noteId !== null));
    const removed = [...index.files.values()].map((entry) => entry.noteId).filter((noteId) => !kept.has(noteId));
    return { entries, removed };
  }

  // ---- notes

  private metaNote(spaceId: string, props: { home: string; created: number }) {
    return { space_id: spaceId, user_id: "0", type: META, title: "notebook", props };
  }

  private pageNote(spaceId: string, page: StoredPage) {
    return { space_id: spaceId, user_id: "0", type: PAGE, title: page.name, text: page.text, props: { bom: page.bom, eol: page.lineEnding, modified: page.modified } };
  }

  private async fileNote(spaceId: string, file: StoredFile) {
    return this.fileNoteOf(spaceId, { path: file.path, type: file.blob.type, size: file.blob.size, modified: file.modified, blob: file.blob });
  }

  /** A file's note: its path and kind, and its bytes if they are to be written (a move writes only the path). */
  private async fileNoteOf(spaceId: string, entry: { path: string; type: string; size: number; modified: number; blob?: Blob }) {
    const file: Record<string, unknown> = { name: entry.path, type: entry.type, size: entry.size };
    if (entry.blob) file.filedata = { data: await toBase64(entry.blob) };
    return { space_id: spaceId, user_id: "0", type: FILE, title: entry.path, props: { modified: entry.modified }, file };
  }

  private checkSize(path: string, blob: Blob): void {
    if (blob.size > MAX_FILE_BYTES) {
      throw new Error(`"${path}" is ${Math.ceil(blob.size / 1048576)} MB, more than the ${MAX_FILE_BYTES / 1048576} MB an attachment of an encrypted notebook can be.`);
    }
  }

  private lastWins<T>(items: T[], keyOf: (item: T) => string): T[] {
    const byKey = new Map<string, T>();
    for (const item of items) byKey.set(keyOf(item), item);
    return [...byKey.values()];
  }

  // ---- the core

  /** Run `work` once what was asked of the store before it is done, and nothing after it until it is. */
  private run<T>(work: (core: CoreClient) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      const core = this.core();
      if (core !== this.lastCore) {
        // a different engine than last time (the vault was locked and unlocked): what was known of it is only a
        // guess, and a change that could not be undone in the old one is not a worry about this one
        this.indexes.clear();
        this.broken = null;
        this.lastCore = core;
      }
      if (this.broken) throw this.broken;
      return work(core);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private save<T = unknown>(core: CoreClient, action: "add" | "edit" | "delete", type: "space" | "note", data: unknown): Promise<T> {
    return core.request<T>("profile:sync:model", action, type, data);
  }

  private find(core: CoreClient, spaceId: string, type: string): Promise<CoreNote[]> {
    return core.request<{ notes: CoreNote[] }>("profile:find-notes", { space_id: spaceId, type, per_page: 1_000_000 }).then((found) => found.notes);
  }

  /** Make the changes `work` makes in the core all happen or none: the core keeps them only when `work` has finished. */
  private async batch<T>(core: CoreClient, work: () => Promise<T>): Promise<T> {
    await core.request("profile:batch:begin");
    try {
      const result = await work();
      await core.request("profile:batch:commit");
      return result;
    } catch (error) {
      try {
        await core.request("profile:batch:rollback");
      } catch (rollbackError) {
        // the changes could not be undone: nothing this store knows can be trusted any more
        this.broken = new Error("The encrypted notebooks are in a state this app can't be sure of. Lock them and unlock them again.");
        this.indexes.clear();
        void rollbackError;
      }
      throw error;
    }
  }

  /** What is known of a notebook's pages and files: kept, once read. Throws if there is no such notebook. */
  private async indexOf(core: CoreClient, id: string): Promise<NotebookIndex> {
    return this.indexes.get(id) ?? (await this.read(core, id)).index;
  }

  /** Read a notebook's pages and files from the core (again, if they were read before), and keep what is known of them. */
  private async read(core: CoreClient, id: string): Promise<{ index: NotebookIndex; pages: CoreNote[]; files: CoreNote[] }> {
    const spaces = (await core.request<{ spaces: CoreSpace[] }>("profile:load")).spaces;
    if (!spaces.some((space) => space.id === id)) {
      this.indexes.delete(id);
      throw new Error(`no notebook ${id}`);
    }
    const meta = (await this.find(core, id, META))[0];
    const pages = await this.find(core, id, PAGE);
    const files = await this.find(core, id, FILE);
    const index: NotebookIndex = { metaId: meta?.id ?? "", pages: new Map(), files: new Map() };
    for (const note of pages) {
      const name = note.title ?? "";
      if (name !== "") index.pages.set(this.keyOf(name), { noteId: note.id, name });
    }
    for (const note of files) {
      const entry = fileOf(note);
      if (entry.path !== "") index.files.set(fileKey(entry.path), entry);
    }
    this.indexes.set(id, index);
    return { index, pages, files };
  }
}
