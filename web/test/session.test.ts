import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linksIn, pageKey } from "../src/notebook-core";
import { NotebookSession, createEmptyNotebook } from "../src/notebook/session";
import { SAMPLE_PAGES, createSampleNotebook } from "../src/notebook/sample";
import { MemoryStore } from "../src/notebook/store";
import type { NotebookStore, PageChange, StoredPage } from "../src/notebook/store";
import { notebookConfig, pagesFromFiles, parseNotebookConfig } from "../src/notebook/zim-files";
import { decodePage, initZimSync } from "../src/zim";
import { createZip, crc32, readZip } from "../src/zip";
import { attachmentName, isImageType, mediaTypeFor, pictureAddress, typed } from "../src/notebook/media";
import { notebookRoots } from "./support";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const page = (name: string, text: string, extra: Partial<StoredPage> = {}): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1, ...extra });

async function open(pages: StoredPage[], store: NotebookStore = new MemoryStore(pageKey)): Promise<NotebookSession> {
  const info = await store.createNotebook({ title: "Test", home: "Home", kind: "open" }, pages);
  return NotebookSession.open(store, info.id);
}

/** What the store holds, as {name: text}. */
async function stored(session: NotebookSession): Promise<Record<string, string>> {
  const pages = await session.store.loadPages(session.info.id);
  return Object.fromEntries(pages.map((p) => [p.name, p.text]).sort());
}

describe("a notebook session", () => {
  it("opens the pages of a notebook and answers questions about them", async () => {
    const s = await open([page("Home", "[[Help:Links]]"), page("Help:Links", "back to [[Home]]")]);
    expect(s.pageCount).toBe(2);
    expect(s.names()).toEqual(["Help:Links", "Home"]);
    expect(s.tree().map((n) => n.name)).toEqual(["Help", "Help:Links", "Home"]);
    expect(s.exists("help")).toBe(true);
    expect(s.has("help")).toBe(false);
    expect(s.resolve("Home", "Help:Links")).toMatchObject({ kind: "page", exists: true });
    expect(s.backlinks("Home").map((b) => b.from)).toEqual(["Help:Links"]);
    expect(s.search("back").map((h) => h.page)).toEqual(["Help:Links"]);
    expect(s.home).toBe("Home");
  });

  it("refuses to open a notebook that isn't there", async () => {
    await expect(NotebookSession.open(new MemoryStore(pageKey), "nope")).rejects.toThrow(/no longer exists/);
  });

  it("saves a page to the store, and creates one when saving a name that has no page", async () => {
    const s = await open([page("Home", "one")]);
    const events: string[] = [];
    s.onChange((e) => events.push(e.kind === "page" ? `page ${e.name}` : e.kind));
    await s.save("Home", "two");
    expect(await stored(s)).toEqual({ Home: "two" });
    await s.save("New:Page", "fresh");
    expect(await stored(s)).toEqual({ Home: "two", "New:Page": "fresh" });
    expect(events).toEqual(["page Home", "page New:Page", "structure"]);
  });

  it("knows when each page was last written, which follows a page through a rename", async () => {
    const s = await open([page("Home", "one", { modified: 100 }), page("Old", "two", { modified: 200 })]);
    expect(s.modified("Home")).toBe(100);
    expect(s.modified("home")).toBe(100);
    expect(s.modified("Nope")).toBeUndefined();
    const before = Date.now();
    await s.save("Home", "changed");
    expect(s.modified("Home")).toBeGreaterThanOrEqual(before);
    expect(s.modified("Old")).toBe(200);
    await s.rename("Old", "Newer:Name");
    expect(s.modified("Old")).toBeUndefined();
    expect(s.modified("Newer:Name")).toBe(200);
  });

  it("makes new pages the way Zim does, spelled like the section they go in", async () => {
    const s = await open([page("Projects:Garden", "g")]);
    const name = await s.create("projects:Shed");
    expect(name).toBe("Projects:Shed");
    expect(s.text(name)).toMatch(/^Content-Type: text\/x-zim-wiki\nWiki-Format: zim 0\.6\nCreation-Date: \d{4}-.*\n\n====== Shed ======\n$/);
    expect(await s.create("Plain", "own text")).toBe("Plain");
    expect(s.text("Plain")).toBe("own text");
    await expect(s.create("PLAIN")).rejects.toThrow(/Plain already exists/);
    await expect(s.create("bad*name")).rejects.toThrow(/can't contain/);
    expect(await stored(s)).toHaveProperty(["Projects:Shed"]);
  });

  it("renames a page, rewrites the links to it, and writes everything to the store at once", async () => {
    const s = await open([page("Home", "see [[Help:Links]]"), page("Help:Links", "[[Home]]"), page("Help:Other", "[[Links]] and [[Home]]")]);
    const report = await s.rename("Help:Links", "Help:Linking");
    expect(report.moved).toEqual([["Help:Links", "Help:Linking"]]);
    expect(await stored(s)).toEqual({ Home: "see [[Help:Linking]]", "Help:Linking": "[[Home]]", "Help:Other": "[[Linking]] and [[Home]]" });
    expect(s.has("Help:Links")).toBe(false);
  });

  it("moves the home page's name with it", async () => {
    const s = await open([page("Home", "h"), page("Other", "[[Home]]")]);
    await s.rename("Home", "Front:Page");
    expect(s.info.home).toBe("Front:Page");
    expect(s.home).toBe("Front:Page");
    expect((await s.store.listNotebooks())[0]?.home).toBe("Front:Page");
  });

  it("deletes a page with everything below it", async () => {
    const s = await open([page("A", "a"), page("A:B", "b"), page("A:B:C", "c"), page("D", "d")]);
    expect(await s.delete("A")).toEqual(["A", "A:B", "A:B:C"]);
    expect(await stored(s)).toEqual({ D: "d" });
    expect(s.names()).toEqual(["D"]);
  });

  it("keeps a page's byte-order mark and line endings when its text changes, and writes them back on export", async () => {
    const s = await open([page("Windows", "one\ntwo\n", { bom: true, lineEnding: "crlf" })]);
    await s.save("Windows", "one\ntwo\nthree\n");
    const files = await s.exportFiles();
    const entry = files.find((f) => f.path === "Windows.txt")!;
    expect(Array.from(entry.bytes)).toEqual(Array.from(new TextEncoder().encode("﻿one\r\ntwo\r\nthree\r\n")));
    expect(files[0]?.path).toBe("notebook.zim");
  });

  it("exports pages at the paths Zim uses, with a notebook.zim that Zim can read", async () => {
    const s = await open([page("Home", "h"), page("Plugins:Table Editor:Basic", "b")]);
    await s.setTitle("My notebook");
    const files = await s.exportFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["Home.txt", "Plugins/Table_Editor/Basic.txt", "notebook.zim"]);
    const config = new TextDecoder().decode(files.find((f) => f.path === "notebook.zim")!.bytes);
    expect(parseNotebookConfig(config)).toEqual({ name: "My notebook", home: "Home" });
    expect(config).toContain("endofline=unix");
  });

  it("goes back to what the store holds when a write fails, and says so", async () => {
    class Failing extends MemoryStore {
      fail = false;
      override async replacePages(id: string, change: PageChange): Promise<void> {
        if (this.fail) throw new Error("the disk is full");
        return super.replacePages(id, change);
      }
    }
    const store = new Failing(pageKey);
    const s = await open([page("Home", "see [[Old]]"), page("Old", "o"), page("Old:Kid", "k")], store);
    store.fail = true;
    await expect(s.rename("Old", "New")).rejects.toThrow(/disk is full/);
    // nothing moved, in the model or in the store: all or nothing
    expect(s.names()).toEqual(["Home", "Old", "Old:Kid"]);
    expect(s.text("Home")).toBe("see [[Old]]");
    expect(await stored(s)).toEqual({ Home: "see [[Old]]", Old: "o", "Old:Kid": "k" });
    await expect(s.save("Home", "changed")).rejects.toThrow(/disk is full/);
    expect(s.text("Home")).toBe("see [[Old]]");
    await expect(s.delete("Old")).rejects.toThrow(/disk is full/);
    expect(s.names()).toEqual(["Home", "Old", "Old:Kid"]);
  });

  it("refuses a rename it can't do, with a message to show, and changes nothing", async () => {
    const s = await open([page("A", "a"), page("B", "b")]);
    await expect(s.rename("A", "B")).rejects.toThrow(/already exists/);
    await expect(s.rename("Nope", "C")).rejects.toThrow(/no page called/);
    expect(await stored(s)).toEqual({ A: "a", B: "b" });
  });

  it("adds imported pages, replacing the ones with the same name", async () => {
    const s = await open([page("A", "old"), page("B", "b")]);
    await s.addPages([page("a", "new", { bom: true }), page("C", "c")]);
    expect(await stored(s)).toEqual({ A: "new", B: "b", C: "c" });
    expect((await s.exportFiles()).find((f) => f.path === "A.txt")!.bytes.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  describe("attachments", () => {
    const blob = (content: string, type = "") => new Blob([content], { type });
    const sorted = (list: string[]) => [...list].sort();

    it("are stored in the folder of their page under a safe name, and listed", async () => {
      const s = await open([page("Projects", "p"), page("Projects:Garden", "g")]);
      const events: string[] = [];
      s.onChange((e) => events.push(e.kind));
      const path = await s.addFile("Projects:Garden", blob("img"), "Photo 1?.PNG");
      expect(path).toBe("Projects/Garden/Photo 1_.PNG");
      expect(s.attachments("Projects:Garden")).toEqual([{ path, size: 3, type: "image/png", modified: expect.any(Number) }]);
      expect(s.attachments("Projects")).toEqual([]);
      expect(await (await s.fileBlob(path))?.text()).toBe("img");
      expect(s.fileLink("Projects:Garden", path)).toBe("./Photo 1_.PNG");
      expect(s.fileLink("Projects", path)).toBe("./Garden/Photo 1_.PNG");
      expect(s.resolveFile("Projects:Garden", "./Photo 1_.PNG")).toEqual({ kind: "notebook", path, exists: true });
      // the same name again gets a free one, and a type the file brought is kept
      expect(await s.addFile("Projects:Garden", blob("two", "image/jpeg"), "Photo 1?.PNG")).toBe("Projects/Garden/Photo 1_ 2.PNG");
      expect(s.fileInfo("projects/garden/photo 1_ 2.png")?.type).toBe("image/jpeg");
      expect(events).toEqual(["files", "files"]);
      expect(s.fileCount).toBe(2);
      // what the store holds is what a session opened later sees
      const again = await NotebookSession.open(s.store, s.info.id);
      expect(sorted(again.attachments("Projects:Garden").map((f) => f.path))).toEqual(["Projects/Garden/Photo 1_ 2.PNG", "Projects/Garden/Photo 1_.PNG"]);
      expect(await (await again.fileBlob(path))?.text()).toBe("img");
    });

    it("are deleted one at a time", async () => {
      const s = await open([page("A", "a")]);
      const path = await s.addFile("A", blob("x"), "x.dat");
      expect(await s.removeFile("A/X.DAT")).toBe(true);
      expect(await s.removeFile(path)).toBe(false);
      expect(s.attachments("A")).toEqual([]);
      expect(await s.store.listFiles(s.info.id)).toEqual([]);
    });

    it("move with their page, in the same write as the pages, and the references follow", async () => {
      const s = await open([page("Foo", "{{./a.png}} [[./doc.pdf|doc]]"), page("Foo:Sub", "{{./b.png}}"), page("Index", "{{../Foo/a.png?width=5}}")]);
      await s.addFile("Foo", blob("A", "image/png"), "a.png");
      await s.addFile("Foo", blob("D", "application/pdf"), "doc.pdf");
      await s.addFile("Foo:Sub", blob("B", "image/png"), "b.png");
      await s.addFile("Elsewhere", blob("E"), "e.bin");
      const report = await s.rename("Foo", "Bar:Baz");
      expect(report.filesMoved.map(([from, to]) => `${from} -> ${to}`)).toEqual([
        "Foo/a.png -> Bar/Baz/a.png",
        "Foo/doc.pdf -> Bar/Baz/doc.pdf",
        "Foo/Sub/b.png -> Bar/Baz/Sub/b.png",
      ]);
      expect(s.text("Index")).toBe("{{../Bar/Baz/a.png?width=5}}");
      expect(s.text("Bar:Baz")).toBe("{{./a.png}} [[./doc.pdf|doc]]");
      expect(sorted(s.attachments("Bar:Baz").map((f) => f.path))).toEqual(["Bar/Baz/a.png", "Bar/Baz/doc.pdf"]);
      expect(s.fileInfo("Bar/Baz/Sub/b.png")).toMatchObject({ size: 1, type: "image/png" });
      expect(s.fileInfo("Foo/a.png")).toBeUndefined();
      expect(await (await s.fileBlob("Bar/Baz/Sub/b.png"))?.text()).toBe("B");
      expect(await s.fileBlob("Foo/a.png")).toBeUndefined();
      expect(sorted((await s.store.listFiles(s.info.id)).map((f) => f.path))).toEqual(["Bar/Baz/Sub/b.png", "Bar/Baz/a.png", "Bar/Baz/doc.pdf", "Elsewhere/e.bin"]);
      expect(await stored(s)).toEqual({ "Bar:Baz": "{{./a.png}} [[./doc.pdf|doc]]", "Bar:Baz:Sub": "{{./b.png}}", Index: "{{../Bar/Baz/a.png?width=5}}" });
    });

    it("are deleted with their page and the pages below it, and no others", async () => {
      const s = await open([page("A", "a"), page("A:B", "b"), page("AB", "x")]);
      await s.addFile("A", blob("1"), "one.dat");
      await s.addFile("A:B", blob("2"), "two.dat");
      await s.addFile("AB", blob("3"), "three.dat");
      await s.delete("A");
      expect((await s.store.listFiles(s.info.id)).map((f) => f.path)).toEqual(["AB/three.dat"]);
      expect(s.fileCount).toBe(1);
      expect(s.attachments("AB").map((f) => f.path)).toEqual(["AB/three.dat"]);
    });

    it("go into an export at their paths, byte for byte, beside the pages", async () => {
      const s = await open([page("Home", "{{./pic.bin}}")]);
      const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff));
      await s.addFile("Home", new Blob([bytes as BlobPart]), "pic.bin");
      await s.addFile("Plugins:Table Editor", blob("t"), "table.png");
      const entries = await s.exportFiles();
      expect(entries.map((e) => e.path).sort()).toEqual(["Home.txt", "Home/pic.bin", "Plugins/Table_Editor/table.png", "notebook.zim"].sort());
      expect(Array.from(entries.find((e) => e.path === "Home/pic.bin")!.bytes)).toEqual(Array.from(bytes));
      // through a zip and back
      const back = await readZip(createZip(entries));
      expect(Array.from(back.find((e) => e.path === "Home/pic.bin")!.bytes)).toEqual(Array.from(bytes));
    });

    it("come in with imported pages, replacing those at the same path, ignoring case, and keeping the spelling that was there", async () => {
      const s = await open([page("A", "old")]);
      await s.addFile("A", blob("old"), "Pic.png");
      await s.addPages([page("B", "b")], [{ path: "a/PIC.PNG", blob: blob("new", "image/png"), modified: 5 }, { path: "B/x.dat", blob: blob("x"), modified: 6 }]);
      expect(await (await s.fileBlob("A/Pic.png"))?.text()).toBe("new");
      expect(sorted((await s.store.listFiles(s.info.id)).map((f) => f.path))).toEqual(["A/Pic.png", "B/x.dat"]);
      expect(s.fileInfo("A/Pic.png")).toMatchObject({ size: 3, type: "image/png", modified: 5 });
    });

    it("are rolled back with everything else when a write fails", async () => {
      class Failing extends MemoryStore {
        fail = false;
        override async replacePages(id: string, change: PageChange): Promise<void> {
          if (this.fail) throw new Error("the disk is full");
          return super.replacePages(id, change);
        }
      }
      const store = new Failing(pageKey);
      const s = await open([page("Foo", "{{./a.png}}")], store);
      await s.addFile("Foo", blob("A"), "a.png");
      store.fail = true;
      await expect(s.addFile("Foo", blob("B"), "b.png")).rejects.toThrow(/disk is full/);
      await expect(s.rename("Foo", "Bar")).rejects.toThrow(/disk is full/);
      await expect(s.delete("Foo")).rejects.toThrow(/disk is full/);
      await expect(s.removeFile("Foo/a.png")).rejects.toThrow(/disk is full/);
      expect(s.names()).toEqual(["Foo"]);
      expect(s.attachments("Foo").map((f) => f.path)).toEqual(["Foo/a.png"]);
      expect(s.fileCount).toBe(1);
      expect((await store.listFiles(s.info.id)).map((f) => f.path)).toEqual(["Foo/a.png"]);
    });

    /** A store whose writes take a little while, as a real one's do. */
    class Slow extends MemoryStore {
      override async replacePages(id: string, change: PageChange): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return super.replacePages(id, change);
      }
    }

    it("never give two files the same name, however many are asked for at once", async () => {
      const s = await open([page("Ideas", "x")], new Slow(pageKey));
      const paths = await Promise.all([s.addFile("Ideas", blob("one"), "pic.png"), s.addFile("Ideas", blob("two"), "pic.png"), s.addFile("Ideas", blob("three"), "pic.png")]);
      expect(paths).toEqual(["Ideas/pic.png", "Ideas/pic 2.png", "Ideas/pic 3.png"]);
      expect(await Promise.all(paths.map(async (p) => (await s.fileBlob(p))?.text()))).toEqual(["one", "two", "three"]);
      expect(s.attachments("Ideas")).toHaveLength(3);
    });

    it("are not left behind in the old folder by a rename or a delete that comes while they are being stored", async () => {
      const store = new Slow(pageKey);
      const s = await open([page("Ideas", "x")], store);
      const adding = s.addFile("Ideas", blob("big"), "big.pdf");
      const renaming = s.rename("Ideas", "Plans");
      await Promise.all([adding, renaming]);
      expect(s.attachments("Plans").map((f) => f.path)).toEqual(["Plans/big.pdf"]);
      expect((await store.listFiles(s.info.id)).map((f) => f.path)).toEqual(["Plans/big.pdf"]);
      const addingAgain = s.addFile("Plans", blob("more"), "more.pdf");
      const deleting = s.delete("Plans");
      await Promise.all([addingAgain, deleting]);
      expect(s.fileCount).toBe(0);
      expect(await store.listFiles(s.info.id)).toEqual([]);
    });

    it("finish what is being written when the notebook is closed, and refuse anything asked after that", async () => {
      const store = new Slow(pageKey);
      const s = await open([page("Ideas", "x")], store);
      const adding = s.addFile("Ideas", blob("x"), "a.png");
      const closing = s.close();
      await expect(s.addFile("Ideas", blob("y"), "b.png")).rejects.toThrow(/closed/);
      await closing;
      expect(await adding).toBe("Ideas/a.png");
      expect((await store.listFiles(s.info.id)).map((f) => f.path)).toEqual(["Ideas/a.png"]);
      await expect(s.save("Ideas", "z")).rejects.toThrow(/closed/);
      await expect(s.rename("Ideas", "Other")).rejects.toThrow(/closed/);
      await s.close(); // closing twice is no trouble
    });

    it("are never named so that Zim would read them as pages, and no path appears twice in an export", async () => {
      const s = await open([page("Home", "h"), page("Home:notes", "n")]);
      expect(await s.addFile("Home", blob("some text"), "notes.txt")).toBe("Home/notes.txt.text");
      expect(await s.addFile("Home", blob("more"), "NOTES.TXT")).toBe("Home/NOTES.TXT 2.text"); // (the first is taken, ignoring case)
      const paths = (await s.exportFiles()).map((e) => e.path);
      expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
      expect(paths).toContain("Home/notes.txt.text");
      expect(paths).toContain("Home/notes.txt"); // the page
    });

    it("are attached in a batch with names of their own, in one write that happens entirely or not at all", async () => {
      class Failing extends MemoryStore {
        fail = false;
        writes = 0;
        override async replacePages(id: string, change: PageChange): Promise<void> {
          this.writes++;
          if (this.fail) throw new Error("the disk is full");
          return super.replacePages(id, change);
        }
      }
      const store = new Failing(pageKey);
      const s = await open([page("A", "a")], store);
      const paths = await s.addFiles("A", [{ content: blob("1"), wanted: "pic.png" }, { content: blob("2"), wanted: "pic.png" }, { content: blob("3"), wanted: "notes.txt" }]);
      expect(paths).toEqual(["A/pic.png", "A/pic 2.png", "A/notes.txt.text"]);
      expect(store.writes).toBe(1);
      store.fail = true;
      await expect(s.addFiles("A", [{ content: blob("4"), wanted: "x.png" }, { content: blob("5"), wanted: "y.png" }])).rejects.toThrow(/disk is full/);
      expect(s.attachments("A").map((f) => f.path).sort()).toEqual(["A/notes.txt.text", "A/pic 2.png", "A/pic.png"]);
      expect((await store.listFiles(s.info.id)).length).toBe(3);
      store.fail = false;
      expect(await s.addFile("A", blob("6"), "x.png")).toBe("A/x.png");
    });

    it("never take the name of a folder, and can't be put in a folder that is a file", async () => {
      const s = await open([page("A", "a"), page("A:Sub", "s"), page("A:Sec:Child", "c")]);
      await s.addFile("A:Sub", blob("p"), "pic.png");
      expect(await s.addFile("A", blob("f"), "Sub")).toBe("A/Sub 2");
      expect(await s.addFile("A", blob("f"), "Sec")).toBe("A/Sec 2");
      // a file that is where a page's folder would be: the page can't have attachments
      const t = await open([page("B", "b")]);
      await t.addFile("B", blob("file"), "Inner");
      await t.create("B:Inner", "text");
      await expect(t.addFile("B:Inner", blob("x"), "x.png")).rejects.toThrow(/can't hold attachments/);
    });

    it("refuse a move that would put one file on another, changing nothing", async () => {
      const s = await open([page("Foo", "x")]);
      await s.addFile("Foo", blob("A"), "a.png");
      await s.addFile("Bar", blob("other"), "a.png");
      await expect(s.rename("Foo", "Bar")).rejects.toThrow(/Bar\/a\.png already exists/);
      expect(s.names()).toEqual(["Foo"]);
      expect(await (await s.fileBlob("Foo/a.png"))?.text()).toBe("A");
      expect(await (await s.fileBlob("Bar/a.png"))?.text()).toBe("other");
    });
  });

  it("starts an empty notebook with a home page", async () => {
    const store = new MemoryStore(pageKey);
    const info = await createEmptyNotebook(store, "Fresh");
    const s = await NotebookSession.open(store, info.id);
    expect(s.names()).toEqual(["Home"]);
    expect(s.text("Home")).toContain("====== Home ======");
  });
});

describe("the sample notebook", () => {
  it("has valid pages whose links all lead somewhere, except the two left missing on purpose", async () => {
    const store = new MemoryStore(pageKey);
    const info = await createSampleNotebook(store);
    const s = await NotebookSession.open(store, info.id);
    expect(s.pageCount).toBe(SAMPLE_PAGES.length);
    const missing: string[] = [];
    for (const name of s.names()) {
      const text = s.text(name)!;
      expect(decodePage(new TextEncoder().encode(text)).text, name).toBe(text);
      for (const link of linksIn(text)) {
        const resolved = s.resolve(name, link.target);
        if (resolved.kind === "page" && !resolved.exists) missing.push(`${name}: [[${link.target}]]`);
        if (resolved.kind === "invalid") throw new Error(`${name}: [[${link.target}]] is invalid`);
      }
    }
    expect(missing.sort()).toEqual(["Help:Links: [[Not written yet]]", "Ideas: [[Beekeeping]]"]);
    // and the pages that other pages lead to are found by their backlinks
    expect(s.backlinks("Projects:Garden").map((b) => b.from)).toContain("Journal:2026-10-06");
    expect(s.backlinks("Help:Editor").length).toBeGreaterThan(1);
  });

  it("survives a rename of a whole section", async () => {
    const store = new MemoryStore(pageKey);
    const info = await createSampleNotebook(store);
    const s = await NotebookSession.open(store, info.id);
    await s.rename("Projects", "Work:Projects");
    expect(s.names().filter((n) => n.startsWith("Work:Projects"))).toHaveLength(4);
    for (const name of s.names()) {
      for (const link of linksIn(s.text(name)!)) {
        const resolved = s.resolve(name, link.target);
        if (resolved.kind === "page" && !resolved.exists) expect(["Not written yet", "Beekeeping"], `${name}: [[${link.target}]]`).toContain(link.target);
      }
    }
  });
});

describe("importing files", () => {
  const file = (path: string, text: string | Uint8Array) => ({ path, bytes: typeof text === "string" ? new TextEncoder().encode(text) : text });

  it("reads a notebook folder: pages by path, the config, and what it skips", () => {
    const imported = pagesFromFiles([
      file("Mine/notebook.zim", "[Notebook]\nname=Mine\nhome=Start\n"),
      file("Mine/Start.txt", "start"),
      file("Mine/Help/Auto_Formatting.txt", "af"),
      file("Mine/Help/Auto_Formatting/pic.png", "binary"),
      file("Mine/.hidden/x.txt", "hidden"),
      file("Mine/bad*name.txt", "x"),
      file("Mine/Latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
      file("Mine/help/auto formatting.txt", "same name, other case"),
      file("Mine/BOM.txt", new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62])),
    ]);
    expect(imported.config).toEqual({ name: "Mine", home: "Start" });
    expect(imported.pages.map((p) => p.name).sort()).toEqual(["BOM", "Help:Auto Formatting", "Start"]);
    expect(imported.files.map((f) => f.path)).toEqual(["Help/Auto_Formatting/pic.png"]);
    expect(imported.files[0]?.blob.size).toBe(6);
    expect(imported.skipped.map((s) => s.path).sort()).toEqual(["Latin1.txt", "bad*name.txt", "help/auto formatting.txt"]);
    expect(imported.skipped.find((s) => s.path === "Latin1.txt")?.reason).toContain("UTF-8");
    expect(imported.skipped.find((s) => s.path.startsWith("help"))?.reason).toContain("same name");
    const bom = imported.pages.find((p) => p.name === "BOM")!;
    expect([bom.text, bom.bom, bom.lineEnding]).toEqual(["a\nb", true, "crlf"]);
  });

  it("takes every other file as an attachment at its path, and says what it could not take", () => {
    const picture = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const imported = pagesFromFiles([
      { path: "Nb/notebook.zim", bytes: new TextEncoder().encode("[Notebook]\nname=Nb\n") },
      file("Nb/Home.txt", "h"),
      { path: "Nb/Home/pic.png", blob: picture, modified: 1234 },
      file("Nb/Home/data.bin", new Uint8Array([9, 8, 7])),
      file("Nb/Home/Report.PDF", "pdf"),
      file("Nb/Home/report.pdf", "same name, other case"),
      file("Nb/top level.svg", "<svg/>"),
      file("Nb/Home/.hidden/secret.png", "x"),
      file("Nb/.DS_Store", "x"),
      file("Nb/back\\slash/a.png", "x"),
      file("Nb/Home/tab\tname.png", "x"),
    ]);
    // (a backslash in a path is how Windows tools write a folder separator)
    expect(imported.files.map((f) => f.path).sort()).toEqual(["Home/Report.PDF", "Home/data.bin", "Home/pic.png", "back/slash/a.png", "top level.svg"].sort());
    const byPath = Object.fromEntries(imported.files.map((f) => [f.path, f]));
    expect(byPath["Home/pic.png"]).toMatchObject({ modified: 1234 });
    expect(byPath["Home/pic.png"]?.blob.type).toBe("image/png");
    expect(byPath["Home/data.bin"]?.blob.type).toBe("application/octet-stream");
    expect(byPath["Home/Report.PDF"]?.blob.type).toBe("application/pdf");
    expect(byPath["top level.svg"]?.blob.type).toBe("image/svg+xml");
    expect(byPath["Home/data.bin"]?.blob.size).toBe(3);
    expect(imported.skipped.map((s) => s.path).sort()).toEqual(["Home/report.pdf", "Home/tab\tname.png"].sort());
    // a path that is both a file and a folder (the archive says `a` is a file, and puts something in `a`)
    const clash = pagesFromFiles([file("Nb/Home.txt", "h"), file("Nb/Home/a", "a file"), file("Nb/Home/a/b.png", "inside it"), file("Nb/Home/ok.png", "fine")]);
    expect(clash.files.map((f) => f.path)).toEqual(["Home/a", "Home/ok.png"]);
    expect(clash.skipped.map((s) => s.path)).toEqual(["Home/a/b.png"]);
    expect(clash.skipped[0]?.reason).toContain("both a file and a folder");
    expect(imported.skipped.find((s) => s.path === "Home/report.pdf")?.reason).toContain("same name");
    expect(imported.skipped.find((s) => s.path.includes("tab"))?.reason).toContain("control");
  });

  it("finds the notebook inside a folder that was picked above it, and without a config drops the picked folder", () => {
    const nested = pagesFromFiles([file("Backups/2026/nb/notebook.zim", ""), file("Backups/2026/nb/A.txt", "a"), file("Backups/2026/other.txt", "o")]);
    expect(nested.pages.map((p) => p.name)).toEqual(["A"]);
    const bare = pagesFromFiles([file("Picked/A.txt", "a"), file("Picked/Sub/B.txt", "b")]);
    expect(bare.pages.map((p) => p.name).sort()).toEqual(["A", "Sub:B"]);
    const flat = pagesFromFiles([file("A.txt", "a"), file("Sub/B.txt", "b")]);
    expect(flat.pages.map((p) => p.name).sort()).toEqual(["A", "Sub:B"]);
  });

  it("reads and writes notebook.zim the way Zim does", () => {
    expect(parseNotebookConfig("[Notebook]\nversion=0.4\nname=manual\nhome=Start\nicon=\n")).toEqual({ name: "manual", home: "Start" });
    expect(parseNotebookConfig("[Other]\nname=no\n[Notebook]\nhome=Yes\r\n")).toEqual({ home: "Yes" });
    expect(parseNotebookConfig("")).toEqual({});
    expect(notebookConfig({ title: "A\nB", home: "Home" })).toContain("name=A B\n");
  });
});

describe("zip files", () => {
  it("has the standard checksum", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("round-trips files with any names, empty ones and big ones", async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) & 0xff);
    const entries = [
      { path: "notebook.zim", bytes: new TextEncoder().encode("[Notebook]\n") },
      { path: "Help/Auto_Formatting.txt", bytes: new TextEncoder().encode("text\n") },
      { path: "日本語/ページ.txt", bytes: new TextEncoder().encode("日本語") },
      { path: "empty.txt", bytes: new Uint8Array() },
      { path: "big.bin", bytes: big },
    ];
    const read = await readZip(createZip(entries));
    expect(read.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (const [i, entry] of read.entries()) expect(Array.from(entry.bytes.subarray(0, 64)), entry.path).toEqual(Array.from(entries[i]!.bytes.subarray(0, 64)));
    expect(read[4]!.bytes.length).toBe(300_000);
  });

  const python = spawnSync("python3", ["--version"]).status === 0;
  const dir = mkdtempSync(join(tmpdir(), "zim-zip-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!python)("is a zip that Python's own zipfile accepts, with every checksum right", () => {
    const zip = createZip([
      { path: "notebook.zim", bytes: new TextEncoder().encode("[Notebook]\nname=x\n") },
      { path: "Help/Links.txt", bytes: new TextEncoder().encode("====== Links ======\n") },
      { path: "日本語.txt", bytes: new TextEncoder().encode("é") },
    ]);
    writeFileSync(join(dir, "made.zip"), zip);
    const out = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('|'.join(sorted(z.namelist()))); print(z.read('Help/Links.txt').decode(), end='')", join(dir, "made.zip")], { encoding: "utf8" });
    expect(out).toBe("Help/Links.txt|notebook.zim|日本語.txt\n====== Links ======\n");
  });

  it.skipIf(!python)("reads a zip that another program made, compressed", async () => {
    const script = "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.writestr('nb/notebook.zim','[Notebook]\\nname=From Python\\nhome=Start\\n')\nz.writestr('nb/Start.txt','====== Start ======\\n'+'repeat '*500)\nz.writestr('nb/Sub/Page.txt','x')\nz.writestr('nb/Sub/','')\nz.close()";
    execFileSync("python3", ["-c", script, join(dir, "theirs.zip")]);
    const entries = await readZip(new Uint8Array(readFileSync(join(dir, "theirs.zip"))));
    expect(entries.map((e) => e.path).sort()).toEqual(["nb/Start.txt", "nb/Sub/Page.txt", "nb/notebook.zim"]);
    const imported = pagesFromFiles(entries);
    expect(imported.config).toEqual({ name: "From Python", home: "Start" });
    expect(imported.pages.map((p) => p.name).sort()).toEqual(["Start", "Sub:Page"]);
    expect(imported.pages.find((p) => p.name === "Start")!.text.length).toBeGreaterThan(3000);
  });

  it("refuses what is not a zip, and what has been damaged", async () => {
    await expect(readZip(new TextEncoder().encode("not a zip at all"))).rejects.toThrow(/not a zip/);
    const zip = createZip([{ path: "a.txt", bytes: new TextEncoder().encode("hello world") }]);
    const damaged = zip.slice();
    damaged[40] = (damaged[40] ?? 0) ^ 0xff; // a byte of the file's contents
    await expect(readZip(damaged)).rejects.toThrow(/checksum/);
  });
});

describe("media types", () => {
  it("come from the name when the file has none, and only pictures a browser draws safely count as images", () => {
    expect(mediaTypeFor("a/b/photo.JPG")).toBe("image/jpeg");
    expect(mediaTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(mediaTypeFor("noextension")).toBe("application/octet-stream");
    expect(mediaTypeFor(".hidden")).toBe("application/octet-stream");
    expect(mediaTypeFor("archive.tar.gz")).toBe("application/gzip");
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "IMAGE/PNG"]) expect(isImageType(type), type).toBe(true);
    for (const type of ["", "text/html", "application/pdf", "image/tiff", "image/svg", "video/mp4", "application/octet-stream"]) expect(isImageType(type), type).toBe(false);
    expect(typed(new Blob(["x"]), "a.png").type).toBe("image/png");
    expect(typed(new Blob(["x"], { type: "image/gif" }), "a.png").type).toBe("image/gif");
  });

  it("are looked up in the table's own entries only, never in what every object has", () => {
    for (const name of ["a.constructor", "a.toString", "a.__proto__", "a.hasOwnProperty", "constructor"]) {
      expect(mediaTypeFor(name), name).toBe("application/octet-stream");
    }
    expect(attachmentName({ name: "", type: "constructor" }, new Date(2026, 9, 6, 10, 5, 3))).toBe("Pasted file 2026-10-06 10.05.03.bin");
    expect(attachmentName({ name: "image.png", type: "image/png" }, new Date(2026, 9, 6, 10, 5, 3))).toBe("Pasted image 2026-10-06 10.05.03.png");
    expect(attachmentName({ name: "holiday.jpg", type: "image/jpeg" })).toBe("holiday.jpg");
  });
});

describe("the address of a picture", () => {
  it("is a blob address for a picture that is only ever an image, and a data address for an SVG, which is a document", async () => {
    const png = await pictureAddress(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    expect(png.url).toMatch(/^blob:/);
    png.release();
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>';
    for (const type of ["image/svg+xml", "IMAGE/SVG+XML", " image/svg+xml "]) {
      const svg = await pictureAddress(new Blob([svgText], { type }));
      expect(svg.url, type).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(Buffer.from(svg.url.slice(svg.url.indexOf(",") + 1), "base64").toString("utf8")).toBe(svgText);
      expect(() => svg.release()).not.toThrow();
    }
    const big = await pictureAddress(new Blob(["<svg xmlns='http://www.w3.org/2000/svg'>" + "<g/>".repeat(100_000) + "</svg>"], { type: "image/svg+xml" }));
    expect(big.url.length).toBeGreaterThan(400_000);
  });
});

/** Every file below `root` that the importer does not ignore (hidden ones), as notebook-relative paths. */
function filesBelow(root: string, dir = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(root, path));
    else found.push(relative(root, path).split(sep).join("/"));
  }
  return found.sort();
}

const roots = notebookRoots();
describe.skipIf(roots.length === 0)("real Zim notebooks (ZIM_GOLDEN_DIR), through import and export", () => {
  it("come in with their attachments and go out again, every file byte for byte", async () => {
    for (const root of roots) {
      const originals = filesBelow(root);
      const imported = pagesFromFiles(originals.map((path) => ({ path: `${basename(root)}/${path}`, bytes: new Uint8Array(readFileSync(join(root, path))) })));
      // (what could not be a page or an attachment is not expected back: it was reported when it was skipped)
      const skipped = new Set(imported.skipped.map((s) => s.path));
      const store = new MemoryStore(pageKey);
      const info = await store.createNotebook({ title: basename(root), home: imported.config.home ?? "Home", kind: "open" }, imported.pages, imported.files);
      const session = await NotebookSession.open(store, info.id);
      expect(session.pageCount, root).toBe(imported.pages.length);
      expect(session.fileCount, root).toBe(imported.files.length);
      const out = new Map((await readZip(createZip(await session.exportFiles()))).map((e) => [e.path, e.bytes]));
      for (const path of originals) {
        if (path === "notebook.zim" || skipped.has(path)) continue;
        const bytes = out.get(path);
        expect(bytes, `${root}: ${path} is in the export`).toBeDefined();
        expect(Buffer.from(bytes!).equals(readFileSync(join(root, path))), `${root}: ${path} comes back unchanged`).toBe(true);
      }
      const expected = originals.filter((p) => p !== "notebook.zim" && !skipped.has(p));
      expect([...out.keys()].filter((p) => p !== "notebook.zim").sort(), root).toEqual(expected);
    }
  });
});
