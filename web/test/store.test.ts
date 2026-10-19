// The contract every notebook store keeps, run against each one. A store that passes this can be put
// under a NotebookSession (the encrypted and folder stores to come will be held to the same tests).
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pageKey } from "../src/notebook-core";
import { TurtlStore } from "../src/vault/turtl-store";
import { freshAccount } from "./helpers/direct-core";
import type { FolderChange, FolderEntry, FolderHooks, FolderRoot } from "../src/app/shell";
import { FolderStore } from "../src/notebook/folder-store";
import { IndexedDbStore, newId } from "../src/notebook/idb";
import { MemoryStore, fileKey } from "../src/notebook/store";
import type { NotebookStore, StoredFile, StoredPage } from "../src/notebook/store";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const page = (name: string, text = "", extra: Partial<StoredPage> = {}): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1, ...extra });
const byName = (pages: StoredPage[]) => [...pages].sort((a, b) => a.name.localeCompare(b.name));
const file = (path: string, content = path, type = "application/octet-stream", modified = 1): StoredFile => ({ path, blob: new Blob([content], { type }), modified });
const paths = async (store: NotebookStore, id: string) => (await store.listFiles(id)).map((f) => f.path).sort();
const text = async (store: NotebookStore, id: string, path: string) => (await store.loadFile(id, path))?.text();
let databases = 0;

/**
 * The program's file system in memory, with the program's rules (desktop/src-tauri/src/folders.rs): a path is relative and has nothing hidden in it,
 * a change is read against the files as they were (what is moved is read first, then what is deleted goes, then what is moved arrives, and what is
 * written is last), and a path is spelled as it was written (this one tells `Foo` from `foo`, as Linux does).
 */
function fakeFolders() {
  interface Held {
    path: string;
    bytes: Uint8Array;
    modified: number;
  }
  const roots: Array<{ id: string; name: string; files: Map<string, Held>; listed: boolean }> = [];
  const applied: FolderChange[] = [];
  /** The folder, for what the program is asked (only a folder that is listed), or, for the test, wherever it is. */
  const find = (id: string, asked = true) => {
    const root = roots.find((r) => r.id === id);
    if (!root || (asked && !root.listed)) throw new Error("that folder is not one of the notebooks");
    return root;
  };
  const check = (path: string) => {
    if (!path || path.includes("\\") || path.split("/").some((part) => !part || part.startsWith("."))) throw new Error(`${JSON.stringify(path)} is not a path inside a notebook folder`);
  };
  const key = (path: string) => path.toLowerCase();
  const hooks: FolderHooks = {
    async roots(): Promise<FolderRoot[]> {
      return roots.filter((r) => r.listed).map((r) => ({ id: r.id, name: r.name, exists: true }));
    },
    async pick(): Promise<FolderRoot | null> {
      const root = { id: `root${roots.length + 1}-${Math.random().toString(36).slice(2, 8)}`, name: `Folder ${roots.length + 1}`, files: new Map<string, Held>(), listed: true };
      roots.push(root);
      return { id: root.id, name: root.name, exists: true };
    },
    async forget(id: string) {
      // (the folder and its files stay where they are: it is only no longer listed)
      const root = roots.find((r) => r.id === id);
      if (root) root.listed = false;
    },
    async list(id: string): Promise<FolderEntry[]> {
      return [...find(id).files.values()]
        .filter((f) => f.path.split("/").every((part) => !part.startsWith(".")))
        .map((f) => ({ path: f.path, size: f.bytes.length, modified: f.modified }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(id: string, path: string): Promise<Uint8Array> {
      check(path);
      const held = find(id).files.get(path);
      if (!held) throw new Error(`could not read ${path}`);
      return held.bytes.slice();
    },
    async apply(id: string, change: FolderChange) {
      const files = find(id).files;
      for (const path of [...change.writes.map((w) => w.path), ...change.deletes, ...change.moves.flat()]) check(path);
      // (every spelling the change names: this disk tells `Foo` from `foo`)
      const affected = new Set([...change.moves.flat(), ...change.deletes, ...change.writes.map((w) => w.path)]);
      const before = new Map<string, Held>();
      for (const path of affected) {
        const held = files.get(path);
        if (held) before.set(key(path), held);
      }
      const result = new Map<string, Held>(before);
      for (const [from] of change.moves) result.delete(key(from));
      for (const path of change.deletes) result.delete(key(path));
      for (const [from, to] of change.moves) {
        const source = before.get(key(from));
        if (source) result.set(key(to), { ...source, path: to });
      }
      for (const write of change.writes) result.set(key(write.path), { path: write.path, bytes: write.bytes.slice(), modified: write.modified ?? Date.now() });
      for (const path of affected) files.delete(path);
      for (const held of result.values()) files.set(held.path, held);
      applied.push(change);
    },
  };
  /** A file as another program would leave it. */
  const put = (id: string, path: string, content: string | Uint8Array, modified = 1000) => {
    find(id, false).files.set(path, { path, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content, modified });
  };
  const text = (id: string, path: string) => {
    const held = find(id, false).files.get(path);
    return held ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(held.bytes) : undefined;
  };
  const paths = (id: string) => [...find(id, false).files.keys()].sort();
  return { hooks, applied, put, text, paths, roots };
}

/** A FolderStore the way the contract makes notebooks: each one in a folder of its own, chosen for it. */
function folderStoreForContract(): NotebookStore {
  const fake = fakeFolders();
  const inner = new FolderStore(() => fake.hooks, pageKey);
  const store: NotebookStore = {
    listNotebooks: () => inner.listNotebooks(),
    async createNotebook(info, pages, files) {
      const root = (await fake.hooks.pick()) as FolderRoot;
      return inner.createNotebook({ ...info, kind: "folder", location: root.id }, pages ?? [], files);
    },
    updateNotebook: (info) => inner.updateNotebook(info),
    deleteNotebook: (id) => inner.deleteNotebook(id),
    loadPages: (id) => inner.loadPages(id),
    listFiles: (id) => inner.listFiles(id),
    loadFile: (id, path) => inner.loadFile(id, path),
    replacePages: (id, change) => inner.replacePages(id, change),
  };
  return store;
}

function contract(label: string, make: () => Promise<NotebookStore>, timeout = 5000) {
  describe(`the store contract: ${label}`, { timeout }, () => {
    it("lists, updates and deletes notebooks", async () => {
      const store = await make();
      expect(await store.listNotebooks()).toEqual([]);
      const a = await store.createNotebook({ title: "A", home: "Home", kind: "open" });
      const b = await store.createNotebook({ title: "B", home: "Start", kind: "open" });
      expect(a.id).not.toBe(b.id);
      expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["A", "B"]);
      await store.updateNotebook({ ...a, title: "A renamed", home: "Front" });
      expect((await store.listNotebooks())[0]).toMatchObject({ title: "A renamed", home: "Front", id: a.id });
      await store.deleteNotebook(a.id);
      expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["B"]);
    });

    // (a fast machine makes two notebooks within one millisecond: they were listed in the order of their random ids, so the order that they were made in was only usually kept)
    it("lists notebooks that were made within the same millisecond in the order they were made", async () => {
      const store = await make();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const made: string[] = [];
        for (let i = 0; i < 24; i++) made.push((await store.createNotebook({ title: `Notebook ${String(i).padStart(2, "0")}`, home: "Home", kind: "open" })).title);
        expect((await store.listNotebooks()).map((n) => n.title)).toEqual(made);
      } finally {
        clock.mockRestore();
      }
    });

    it("keeps each notebook's pages to itself, and deleting a notebook deletes its pages", async () => {
      const store = await make();
      const a = await store.createNotebook({ title: "A", home: "Home", kind: "open" }, [page("Home", "in A"), page("Shared", "a")]);
      const b = await store.createNotebook({ title: "B", home: "Home", kind: "open" }, [page("Home", "in B"), page("Shared", "b"), page("Only B", "x")]);
      expect(byName(await store.loadPages(a.id)).map((p) => [p.name, p.text])).toEqual([["Home", "in A"], ["Shared", "a"]]);
      expect(byName(await store.loadPages(b.id)).map((p) => p.name)).toEqual(["Home", "Only B", "Shared"]);
      await store.deleteNotebook(a.id);
      expect(await store.loadPages(b.id)).toHaveLength(3);
    });

    it("keeps what a page is: text, byte-order mark, line endings, time", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("日本語:ページ", "é\n😀", { bom: true, lineEnding: "crlf", modified: 12345 })]);
      expect(await store.loadPages(n.id)).toEqual([page("日本語:ページ", "é\n😀", { bom: true, lineEnding: "crlf", modified: 12345 })]);
    });

    it("treats names that differ only in case as one page", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("Help:Links", "one")]);
      await store.replacePages(n.id, { remove: [], put: [page("HELP:LINKS", "two")] });
      expect((await store.loadPages(n.id)).map((p) => [p.name, p.text])).toEqual([["HELP:LINKS", "two"]]);
      await store.replacePages(n.id, { remove: ["help:links"], put: [] });
      expect(await store.loadPages(n.id)).toEqual([]);
    });

    it("moves pages in one step: what is removed and what is put arrive together", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("A", "a"), page("A:B", "b"), page("Other", "see [[A]]")]);
      await store.replacePages(n.id, { remove: ["A", "A:B"], put: [page("Z", "a"), page("Z:B", "b"), page("Other", "see [[Z]]")] });
      expect(byName(await store.loadPages(n.id)).map((p) => [p.name, p.text])).toEqual([["Other", "see [[Z]]"], ["Z", "a"], ["Z:B", "b"]]);
      // renaming only the case: the same key is removed and put back in one change
      await store.replacePages(n.id, { remove: ["z"], put: [page("z", "a")] });
      expect(byName(await store.loadPages(n.id)).map((p) => p.name)).toEqual(["Other", "z", "Z:B"]);
    });

    it("holds thousands of pages", async () => {
      const store = await make();
      const pages = Array.from({ length: 3000 }, (_, i) => page(`Section ${i % 30}:Page ${i}`, `text ${i}`));
      const n = await store.createNotebook({ title: "Big", home: "Home", kind: "open" }, pages);
      expect(await store.loadPages(n.id)).toHaveLength(3000);
    });

    it("says so when a notebook isn't there", async () => {
      const store = await make();
      await expect(store.replacePages("missing", { remove: [], put: [page("A")] })).rejects.toThrow();
      await expect(store.replacePages("missing", { remove: [], put: [], files: { put: [file("a.png")] } })).rejects.toThrow();
    });

    it("keeps a notebook's files, with their bytes, type and time, and no one else's", async () => {
      const store = await make();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
      const a = await store.createNotebook({ title: "A", home: "Home", kind: "open" }, [page("Home")], [{ path: "Home/pic.png", blob: new Blob([bytes], { type: "image/png" }), modified: 777 }, file("top.csv", "hello", "text/csv")]);
      const b = await store.createNotebook({ title: "B", home: "Home", kind: "open" }, [], [file("Home/pic.png", "B's picture", "image/png")]);
      expect((await store.listFiles(a.id)).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: "Home/pic.png", size: 7, type: "image/png", modified: 777 },
        { path: "top.csv", size: 5, type: "text/csv", modified: 1 },
      ]);
      expect(new Uint8Array(await (await store.loadFile(a.id, "Home/pic.png"))!.arrayBuffer())).toEqual(bytes);
      expect(await text(store, b.id, "Home/pic.png")).toBe("B's picture");
      expect(await store.loadFile(a.id, "nope.png")).toBeUndefined();
      await store.deleteNotebook(a.id);
      expect(await paths(store, b.id)).toEqual(["Home/pic.png"]);
      expect(await text(store, b.id, "Home/pic.png")).toBe("B's picture");
    });

    it("treats paths that differ only in case as one file, and keeps the spelling it was given", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [], [file("Foo/a.png", "one")]);
      expect(await text(store, n.id, "FOO/A.PNG")).toBe("one");
      await store.replacePages(n.id, { remove: [], put: [], files: { put: [file("FOO/A.png", "two")] } });
      expect(await store.listFiles(n.id)).toHaveLength(1);
      expect(await text(store, n.id, "foo/a.png")).toBe("two");
      await store.replacePages(n.id, { remove: [], put: [], files: { remove: ["foo/A.PNG"] } });
      expect(await store.listFiles(n.id)).toEqual([]);
    });

    it("changes files together with pages: moves keep the bytes, then removals, then writes", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home" , kind: "open" }, [page("Foo", "{{./a.png}}"), page("Other", "{{../Foo/a.png}}")], [file("Foo/a.png", "A"), file("Foo/Sub/b.png", "B"), file("Keep/c.png", "C"), file("Gone/d.png", "D")]);
      await store.replacePages(n.id, {
        remove: ["Foo"],
        put: [page("Bar", "{{./a.png}}"), page("Other", "{{../Bar/a.png}}")],
        files: { move: [["Foo/a.png", "Bar/a.png"], ["Foo/Sub/b.png", "Bar/Sub/b.png"]], remove: ["Gone/d.png"], put: [file("New/e.png", "E")] },
      });
      expect(byName(await store.loadPages(n.id)).map((p) => p.name)).toEqual(["Bar", "Other"]);
      expect(await paths(store, n.id)).toEqual(["Bar/Sub/b.png", "Bar/a.png", "Keep/c.png", "New/e.png"]);
      expect(await text(store, n.id, "Bar/a.png")).toBe("A");
      expect(await text(store, n.id, "Bar/Sub/b.png")).toBe("B");
      expect(await store.loadFile(n.id, "Foo/a.png")).toBeUndefined();
      // moving a file that isn't there moves nothing; moving onto a name that is taken takes its place
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["nothing.png", "Z.png"], ["Keep/c.png", "Bar/a.png"]] } });
      expect(await paths(store, n.id)).toEqual(["Bar/Sub/b.png", "Bar/a.png", "New/e.png"]);
      expect(await text(store, n.id, "Bar/a.png")).toBe("C");
    });

    it("lets files swap places, and change only the case of their path", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [], [file("x.png", "X"), file("y.png", "Y"), file("Case/a.png", "A")]);
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["x.png", "y.png"], ["y.png", "x.png"], ["Case/a.png", "case/A.png"]] } });
      expect(await text(store, n.id, "x.png")).toBe("Y");
      expect(await text(store, n.id, "y.png")).toBe("X");
      expect(await paths(store, n.id)).toEqual(["case/A.png", "x.png", "y.png"]);
    });

    it("lets a file be moved away and another be written where it was, in one change", async () => {
      const store = await make();
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [], [file("a.png", "old A"), file("b.png", "old B")]);
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["a.png", "moved.png"]], put: [file("a.png", "new A")] } });
      expect(await paths(store, n.id)).toEqual(["a.png", "b.png", "moved.png"]);
      expect(await text(store, n.id, "a.png")).toBe("new A");
      expect(await text(store, n.id, "moved.png")).toBe("old A");
      expect(await text(store, n.id, "b.png")).toBe("old B");
      // writing is last: what is written where a file was moved to is what is left there
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["b.png", "c.png"]], put: [file("C.PNG", "written over the moved one")] } });
      expect(await paths(store, n.id)).toEqual(["C.PNG", "a.png", "moved.png"]);
      expect(await text(store, n.id, "c.png")).toBe("written over the moved one");
      // and a file moved onto a path takes the place of what is there
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["moved.png", "a.png"]] } });
      expect(await paths(store, n.id)).toEqual(["C.PNG", "a.png"]);
      expect(await text(store, n.id, "a.png")).toBe("old A");
    });

    it("holds hundreds of files", async () => {
      const store = await make();
      const files = Array.from({ length: 600 }, (_, i) => file(`Section ${i % 20}/file ${i}.bin`, `content ${i}`));
      const n = await store.createNotebook({ title: "Big", home: "Home", kind: "open" }, [], files);
      expect(await store.listFiles(n.id)).toHaveLength(600);
      expect(await text(store, n.id, "Section 7/file 507.bin")).toBe("content 507");
    });
  });
}

contract("memory", async () => new MemoryStore(pageKey));
contract("folder", async () => folderStoreForContract());
contract("IndexedDB", async () => IndexedDbStore.open(pageKey, `contract-${++databases}`));
// (every test gets an account of its own in the core, whose key takes a second to make; and the notebooks are encrypted as they go in)
contract("encrypted", async () => {
  const core = await freshAccount();
  return new TurtlStore(() => core, pageKey);
}, 240_000);

describe("a notebook in a folder, beyond the contract", () => {
  const open = () => {
    const fake = fakeFolders();
    return { fake, store: new FolderStore(() => fake.hooks, pageKey) };
  };
  const config = "[Notebook]\nversion=0.4\nname=Field notes\nhome=Start\nicon=\nshared=True\n";
  const attach = async (store: FolderStore, fake: ReturnType<typeof fakeFolders>) => {
    const root = (await fake.hooks.pick()) as FolderRoot;
    return { root, info: await store.createNotebook({ title: "ignored", home: "Home", kind: "folder", location: root.id }) };
  };

  it("takes a folder of Zim files as it is, reads its name and home from notebook.zim, and writes nothing", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "notebook.zim", config);
    fake.put(root.id, "Start.txt", "Content-Type: text/x-zim-wiki\n\n====== Start ======\nsee [[Projects:My Note]]\n");
    fake.put(root.id, "Projects/My Note.txt", "\ufeffcrlf page\r\nsecond\r\n", 5000);
    fake.put(root.id, "Projects/My Note/pic.png", new Uint8Array([1, 2, 3]));
    fake.put(root.id, ".git/config", "[core]");
    fake.put(root.id, "Broken.txt", new Uint8Array([0xff, 0xfe, 0xfd]));
    const info = await store.createNotebook({ title: "ignored", home: "Home", kind: "folder", location: root.id });
    expect(info).toMatchObject({ title: "Field notes", home: "Start", kind: "folder", location: root.id });
    expect((await store.listNotebooks()).map((n) => [n.id, n.title, n.home])).toEqual([[root.id, "Field notes", "Start"]]);
    const pages = byName(await store.loadPages(info.id));
    expect(pages.map((p) => p.name)).toEqual(["Projects:My Note", "Start"]);
    expect(pages[0]).toMatchObject({ bom: true, lineEnding: "crlf", modified: 5000, text: "crlf page\nsecond\n" });
    expect((await store.listFiles(info.id)).map((f) => [f.path, f.size, f.type])).toEqual([["Projects/My Note/pic.png", 3, "image/png"]]);
    expect(fake.applied).toEqual([]);
  });

  it("takes a folder with no notebook.zim as a notebook, whatever folders it holds", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "Only/Page.txt", "one");
    fake.put(root.id, "Only/Other.txt", "two");
    const info = await store.createNotebook({ title: "Named by the person", home: "Home", kind: "folder", location: root.id });
    expect(info.title).toBe("Named by the person");
    expect(byName(await store.loadPages(info.id)).map((p) => p.name)).toEqual(["Only:Other", "Only:Page"]);
  });

  it("writes a page that was edited to the file it has, spelled as that file is, and leaves every other file as it was", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "notebook.zim", config);
    fake.put(root.id, "My Note.txt", "\ufeffold\r\ntext\r\n", 7000);
    fake.put(root.id, "Untouched.txt", "same bytes", 8000);
    fake.put(root.id, "Broken.txt", new Uint8Array([0xff, 0xfe]));
    const info = await store.createNotebook({ title: "x", home: "Home", kind: "folder", location: root.id });
    const [mine] = (await store.loadPages(info.id)).filter((p) => p.name === "My Note");
    await store.replacePages(info.id, { remove: [], put: [{ ...mine!, text: "new\ntext\n", modified: 9000 }] });
    expect(fake.paths(root.id)).toEqual(["Broken.txt", "My Note.txt", "Untouched.txt", "notebook.zim"]);
    expect(fake.text(root.id, "My Note.txt")).toBe("\ufeffnew\r\ntext\r\n");
    expect(fake.text(root.id, "Untouched.txt")).toBe("same bytes");
    expect(fake.applied.at(-1)?.writes.map((w) => w.path)).toEqual(["My Note.txt"]);
    expect(fake.applied.at(-1)?.writes[0]?.modified).toBe(9000);
    expect((await store.loadPages(info.id)).find((p) => p.name === "My Note")?.modified).toBe(9000);
  });

  it("writes a new page at the place its name gives, and a rename moves the file and the folder that holds its attachments", async () => {
    const { fake, store } = open();
    const { root, info } = await attach(store, fake);
    await store.replacePages(info.id, { remove: [], put: [page("Help:Auto Formatting", "text")], files: { put: [file("Help/Auto Formatting/pic.png", "P", "image/png")] } });
    expect(fake.paths(root.id)).toEqual(["Help/Auto Formatting/pic.png", "Help/Auto_Formatting.txt"]);
    await store.replacePages(info.id, { remove: ["Help:Auto Formatting"], put: [page("Docs:Formatting", "text")], files: { move: [["Help/Auto Formatting/pic.png", "Docs/Formatting/pic.png"]] } });
    expect(fake.paths(root.id)).toEqual(["Docs/Formatting.txt", "Docs/Formatting/pic.png"]);
    expect(await text(store, info.id, "Docs/Formatting/pic.png")).toBe("P");
  });

  it("replaces on the disk a file that has the same name but for the case, where it is written over or moved onto", async () => {
    const { fake, store } = open();
    const { root, info } = await attach(store, fake);
    await store.replacePages(info.id, { remove: [], put: [], files: { put: [file("Foo/a.png", "one"), file("Bar/b.png", "B")] } });
    await store.replacePages(info.id, { remove: [], put: [], files: { put: [file("FOO/A.png", "two")] } });
    expect(fake.paths(root.id).filter((p) => p.toLowerCase() === "foo/a.png")).toEqual(["FOO/A.png"]);
    expect(fake.text(root.id, "FOO/A.png")).toBe("two");
    await store.replacePages(info.id, { remove: [], put: [], files: { move: [["Bar/b.png", "foo/a.PNG"]] } });
    expect(fake.paths(root.id).filter((p) => p.toLowerCase() === "foo/a.png")).toEqual(["foo/a.PNG"]);
    expect(fake.text(root.id, "foo/a.PNG")).toBe("B");
  });

  it("gives a page the spelling of its new name when only the case changed, and leaves no second file", async () => {
    const { fake, store } = open();
    const { root, info } = await attach(store, fake);
    await store.replacePages(info.id, { remove: [], put: [page("Garden", "g")] });
    await store.replacePages(info.id, { remove: [], put: [page("GARDEN", "g2")] });
    expect(fake.paths(root.id)).toEqual(["GARDEN.txt"]);
    expect((await store.loadPages(info.id)).map((p) => [p.name, p.text])).toEqual([["GARDEN", "g2"]]);
  });

  it("makes a new notebook in an empty folder with notebook.zim, and refuses a folder that already has a file of the same name", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    const info = await store.createNotebook({ title: "Fresh", home: "Home", kind: "folder", location: root.id }, [page("Home", "h")]);
    expect(fake.paths(root.id)).toEqual(["Home.txt", "notebook.zim"]);
    expect(fake.text(root.id, "notebook.zim")).toMatch(/\[Notebook\][\s\S]*name=Fresh[\s\S]*home=Home/);
    expect(info.title).toBe("Fresh");
    // a folder with a page of that name is not written over
    const other = (await fake.hooks.pick()) as FolderRoot;
    fake.put(other.id, "Home.txt", "somebody's page");
    await expect(store.createNotebook({ title: "Clash", home: "Home", kind: "folder", location: other.id }, [page("Home", "h")])).rejects.toThrow(/already has a file named Home\.txt/);
    expect(fake.text(other.id, "Home.txt")).toBe("somebody's page");
    // and a notebook needs a folder
    await expect(store.createNotebook({ title: "None", home: "Home", kind: "folder" }, [])).rejects.toThrow(/folder/);
  });

  it("changes the name and the home in notebook.zim and keeps the rest of the file", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "notebook.zim", config + "[Another]\nname=untouched\n");
    const info = await store.createNotebook({ title: "x", home: "Home", kind: "folder", location: root.id });
    await store.updateNotebook({ ...info, title: "Renamed", home: "Front" });
    expect(fake.text(root.id, "notebook.zim")).toBe("[Notebook]\nversion=0.4\nname=Renamed\nhome=Front\nicon=\nshared=True\n[Another]\nname=untouched\n");
    // a folder that had none gets one
    const bare = (await fake.hooks.pick()) as FolderRoot;
    const second = await store.createNotebook({ title: "Bare", home: "Home", kind: "folder", location: bare.id });
    await store.updateNotebook({ ...second, title: "Now named" });
    expect(fake.text(bare.id, "notebook.zim")).toMatch(/name=Now named/);
  });

  it("only stops listing a notebook when it is deleted: its folder and its files stay", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "Home.txt", "keep me");
    fake.put(root.id, "Home/pic.png", "keep me too");
    const info = await store.createNotebook({ title: "x", home: "Home", kind: "folder", location: root.id });
    await store.deleteNotebook(info.id);
    expect(await store.listNotebooks()).toEqual([]);
    expect(fake.text(root.id, "Home.txt")).toBe("keep me");
    expect(fake.paths(root.id)).toEqual(["Home.txt", "Home/pic.png"]);
  });

  it("sees what another program changed in the folder the next time the notebook is opened", async () => {
    const { fake, store } = open();
    const root = (await fake.hooks.pick()) as FolderRoot;
    fake.put(root.id, "Home.txt", "one");
    const info = await store.createNotebook({ title: "x", home: "Home", kind: "folder", location: root.id });
    expect((await store.loadPages(info.id)).map((p) => p.text)).toEqual(["one"]);
    fake.put(root.id, "Home.txt", "edited in another editor");
    fake.put(root.id, "New.txt", "made by git");
    expect(byName(await store.loadPages(info.id)).map((p) => [p.name, p.text])).toEqual([["Home", "edited in another editor"], ["New", "made by git"]]);
  });

  it("says that it needs the program when there is none", async () => {
    const store = new FolderStore(() => undefined, pageKey);
    expect(await store.listNotebooks()).toEqual([]);
    await expect(store.loadPages("x")).rejects.toThrow(/desktop program/);
  });
});

describe("IndexedDB, beyond the contract", () => {
  it("makes notebook ids without crypto.randomUUID, which a page that is not secure doesn't have", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 500 }, () => newId()));
      expect(ids.size).toBe(500);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("keeps notebooks between one opening of the database and the next", async () => {
    const name = `reopen-${++databases}`;
    const first = await IndexedDbStore.open(pageKey, name);
    const n = await first.createNotebook({ title: "Kept", home: "Home", kind: "open" }, [page("Home", "still here")]);
    first.close();
    const second = await IndexedDbStore.open(pageKey, name);
    expect((await second.listNotebooks()).map((x) => x.title)).toEqual(["Kept"]);
    expect((await second.loadPages(n.id))[0]?.text).toBe("still here");
  });

  it("changes nothing when part of a change can't be written", async () => {
    const store = await IndexedDbStore.open(pageKey, `atomic-${++databases}`);
    const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("A", "a"), page("B", "b")]);
    // a function can't be stored, so this put fails after the removal has been queued
    const unstorable = { ...page("C", "c"), text: (() => "x") as unknown as string };
    // (and it is that error the caller gets, not a generic "transaction aborted")
    await expect(store.replacePages(n.id, { remove: ["A"], put: [page("D", "d"), unstorable] })).rejects.toThrow(/clone/i);
    expect(byName(await store.loadPages(n.id)).map((p) => p.name)).toEqual(["A", "B"]);
  });

  it("changes nothing when part of a change of files can't be written", async () => {
    const store = await IndexedDbStore.open(pageKey, `atomic-files-${++databases}`);
    const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("A", "a")], [file("a.png", "A"), file("b.png", "B")]);
    const unstorable = { path: "c.png", blob: (() => "x") as unknown as Blob, modified: 1 };
    await expect(
      store.replacePages(n.id, { remove: ["A"], put: [page("D", "d")], files: { move: [["a.png", "moved.png"]], remove: ["b.png"], put: [file("e.png"), unstorable] } }),
    ).rejects.toThrow(/clone/i);
    expect(byName(await store.loadPages(n.id)).map((p) => p.name)).toEqual(["A"]);
    expect(await paths(store, n.id)).toEqual(["a.png", "b.png"]);
  });

  describe("a file that is moved with its page", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is written from bytes of its own, not from the Blob that the database handed out (WebKit failed to draw one picture in ten that was)", async () => {
      const store = await IndexedDbStore.open(pageKey, `own-bytes-${++databases}`);
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [], [file("Foo/a.png", "A", "image/png", 7), file("Foo/b.csv", "B", "text/csv", 8)]);
      const handedOut: unknown[] = [];
      const written: Array<{ path: string; blob: unknown }> = [];
      const get = IDBObjectStore.prototype.get;
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
        const asked = get.call(this, query);
        asked.addEventListener("success", () => handedOut.push((asked.result as { blob?: unknown } | undefined)?.blob));
        return asked;
      });
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === "files") written.push({ path: (value as StoredFile).path, blob: (value as StoredFile).blob });
        return put.call(this, value, key);
      });
      await store.replacePages(n.id, { remove: [], put: [], files: { move: [["Foo/a.png", "Bar/a.png"], ["Foo/b.csv", "Bar/b.csv"]] } });
      vi.restoreAllMocks();
      expect(written.map((w) => w.path).sort()).toEqual(["Bar/a.png", "Bar/b.csv"]);
      expect(handedOut.filter((blob) => blob instanceof Blob).length).toBeGreaterThanOrEqual(2); // (the spy saw what the database gave)
      for (const w of written) expect(handedOut).not.toContain(w.blob);
      // and nothing of the file is lost on the way: its bytes, its type, its time
      const moved = await store.loadFile(n.id, "Bar/a.png");
      expect(moved?.type).toBe("image/png");
      expect(await moved?.text()).toBe("A");
      expect((await store.loadFile(n.id, "Bar/b.csv"))?.type).toBe("text/csv");
      expect((await store.listFiles(n.id)).map((f) => [f.path, f.modified]).sort()).toEqual([["Bar/a.png", 7], ["Bar/b.csv", 8]]);
    });

    it("is moved as it is when its bytes can't be read, so that a page with a damaged picture can still be renamed", async () => {
      const store = await IndexedDbStore.open(pageKey, `unreadable-${++databases}`);
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [page("Foo", "x")], [file("Foo/a.png", "A", "image/png"), file("Foo/b.png", "B", "image/png")]);
      vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValueOnce(new DOMException("The object can not be found here.", "NotFoundError"));
      await store.replacePages(n.id, { remove: ["Foo"], put: [page("Bar", "x")], files: { move: [["Foo/a.png", "Bar/a.png"], ["Foo/b.png", "Bar/b.png"]] } });
      vi.restoreAllMocks();
      expect(await paths(store, n.id)).toEqual(["Bar/a.png", "Bar/b.png"]);
      expect(await text(store, n.id, "Bar/a.png")).toBe("A");
      expect(await text(store, n.id, "Bar/b.png")).toBe("B");
      expect(byName(await store.loadPages(n.id)).map((p) => p.name)).toEqual(["Bar"]);
    });

    it("is written from the file as it is when it changed after its bytes were read (another tab wrote it again)", async () => {
      const store = await IndexedDbStore.open(pageKey, `changed-${++databases}`);
      const now = (path: string) => file(path, "NOW", "image/png", 5);
      const names = ["size", "time", "type"];
      const n = await store.createNotebook({ title: "N", home: "Home", kind: "open" }, [], names.map((name) => now(`Foo/${name}.png`)));
      // (what was read a moment ago, and is not what is stored now: in size only, in time only, in type only)
      const read = (name: string, content: string, modified: number, type: string) => [fileKey(`Foo/${name}.png`), { path: `Foo/${name}.png`, modified, blob: new Blob([content], { type }) }] as const;
      const copies = new Map([read("size", "OLD VERSION", 5, "image/png"), read("time", "OLD", 4, "image/png"), read("type", "OLD", 5, "image/jpeg")]);
      vi.spyOn(store as unknown as { copiesOfFiles(): Promise<typeof copies> }, "copiesOfFiles").mockResolvedValue(copies);
      await store.replacePages(n.id, { remove: [], put: [], files: { move: names.map((name) => [`Foo/${name}.png`, `Bar/${name}.png`] as [string, string]) } });
      vi.restoreAllMocks();
      for (const name of names) expect(await text(store, n.id, `Bar/${name}.png`)).toBe("NOW");
    });
  });

  it("opens a database made before files existed, keeps what is in it, and can then hold files", async () => {
    const name = `version-1-${++databases}`;
    // the database as the first version of the app made it: notebooks and pages only
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("notebooks", { keyPath: "id" });
        opening.result.createObjectStore("pages", { keyPath: ["notebook", "key"] });
      };
      opening.onsuccess = () => {
        const tx = opening.result.transaction(["notebooks", "pages"], "readwrite");
        tx.objectStore("notebooks").put({ id: "old", title: "Old", home: "Home", created: 1, kind: "open" });
        tx.objectStore("pages").put({ notebook: "old", key: "home", name: "Home", text: "from version 1", bom: false, lineEnding: "lf", modified: 1 });
        tx.oncomplete = () => {
          opening.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      opening.onerror = () => reject(opening.error);
    });
    const store = await IndexedDbStore.open(pageKey, name);
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Old"]);
    expect((await store.loadPages("old"))[0]?.text).toBe("from version 1");
    expect(await store.listFiles("old")).toEqual([]);
    await store.replacePages("old", { remove: [], put: [], files: { put: [file("Home/a.png", "now with files")] } });
    expect(await text(store, "old", "Home/a.png")).toBe("now with files");
  });

  it("says when an upgrade is kept waiting by another tab, and goes on when that tab lets go", async () => {
    const name = `blocked-${++databases}`;
    // an older version of the app, in another tab, with the database open (and not letting go of it)
    const older = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("notebooks", { keyPath: "id" });
        opening.result.createObjectStore("pages", { keyPath: ["notebook", "key"] });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    let blocked = 0;
    const opening = IndexedDbStore.open(pageKey, name, { onBlocked: () => blocked++ });
    let opened = false;
    void opening.then(() => (opened = true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(blocked).toBe(1);
    expect(opened).toBe(false);
    older.close(); // the other tab closes
    const store = await opening;
    expect(await store.listNotebooks()).toEqual([]);
  });

  it("lets go of the database when another tab wants a newer one, and says so", async () => {
    const name = `versionchange-${++databases}`;
    let changed = 0;
    const store = await IndexedDbStore.open(pageKey, name, { onVersionChange: () => changed++ });
    await new Promise<void>((resolve, reject) => {
      const newer = indexedDB.open(name, 3);
      newer.onblocked = () => reject(new Error("the store did not let go"));
      newer.onsuccess = () => {
        newer.result.close();
        resolve();
      };
      newer.onerror = () => reject(newer.error);
    });
    expect(changed).toBe(1);
    await expect(store.listNotebooks()).rejects.toThrow(); // closed: this tab has to be reloaded
  });

  it("asks for persistence only where the browser can give it, and never fails", async () => {
    expect(typeof (await IndexedDbStore.requestPersistence())).toBe("boolean");
  });
});
