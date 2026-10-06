// The contract every notebook store keeps, run against each one. A store that passes this can be put
// under a NotebookSession (the encrypted and folder stores to come will be held to the same tests).
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pageKey } from "../src/notebook-core";
import { IndexedDbStore } from "../src/notebook/idb";
import { MemoryStore } from "../src/notebook/store";
import type { NotebookStore, StoredPage } from "../src/notebook/store";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const page = (name: string, text = "", extra: Partial<StoredPage> = {}): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1, ...extra });
const byName = (pages: StoredPage[]) => [...pages].sort((a, b) => a.name.localeCompare(b.name));
let databases = 0;

function contract(label: string, make: () => Promise<NotebookStore>) {
  describe(`the store contract: ${label}`, () => {
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
    });
  });
}

contract("memory", async () => new MemoryStore(pageKey));
contract("IndexedDB", async () => IndexedDbStore.open(pageKey, `contract-${++databases}`));

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

  it("asks for persistence only where the browser can give it, and never fails", async () => {
    expect(typeof (await IndexedDbStore.requestPersistence())).toBe("boolean");
  });
});
