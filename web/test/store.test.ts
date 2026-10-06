// The contract every notebook store keeps, run against each one. A store that passes this can be put
// under a NotebookSession (the encrypted and folder stores to come will be held to the same tests).
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pageKey } from "../src/notebook-core";
import { TurtlStore } from "../src/vault/turtl-store";
import { freshAccount } from "./helpers/direct-core";
import { IndexedDbStore } from "../src/notebook/idb";
import { MemoryStore } from "../src/notebook/store";
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
      const a = await store.createNotebook({ title: "A", home: "Home", kind: "open" }, [page("Home")], [{ path: "Home/pic.png", blob: new Blob([bytes], { type: "image/png" }), modified: 777 }, file("top.txt", "hello", "text/plain")]);
      const b = await store.createNotebook({ title: "B", home: "Home", kind: "open" }, [], [file("Home/pic.png", "B's picture", "image/png")]);
      expect((await store.listFiles(a.id)).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: "Home/pic.png", size: 7, type: "image/png", modified: 777 },
        { path: "top.txt", size: 5, type: "text/plain", modified: 1 },
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
contract("IndexedDB", async () => IndexedDbStore.open(pageKey, `contract-${++databases}`));
// (every test gets an account of its own in the core, whose key takes a second to make; and the notebooks are encrypted as they go in)
contract("encrypted", async () => {
  const core = await freshAccount();
  return new TurtlStore(() => core, pageKey);
}, 240_000);

describe("IndexedDB, beyond the contract", () => {
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
