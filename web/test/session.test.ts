import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linksIn, pageKey } from "../src/notebook-core";
import { NotebookSession, createEmptyNotebook } from "../src/notebook/session";
import { SAMPLE_PAGES, createSampleNotebook } from "../src/notebook/sample";
import { MemoryStore } from "../src/notebook/store";
import type { NotebookStore, StoredPage } from "../src/notebook/store";
import { notebookConfig, pagesFromFiles, parseNotebookConfig } from "../src/notebook/zim-files";
import { decodePage, initZimSync } from "../src/zim";
import { createZip, crc32, readZip } from "../src/zip";

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
    const files = s.exportFiles();
    const entry = files.find((f) => f.path === "Windows.txt")!;
    expect(Array.from(entry.bytes)).toEqual(Array.from(new TextEncoder().encode("﻿one\r\ntwo\r\nthree\r\n")));
    expect(files[0]?.path).toBe("notebook.zim");
  });

  it("exports pages at the paths Zim uses, with a notebook.zim that Zim can read", async () => {
    const s = await open([page("Home", "h"), page("Plugins:Table Editor:Basic", "b")]);
    await s.setTitle("My notebook");
    const files = s.exportFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["Home.txt", "Plugins/Table_Editor/Basic.txt", "notebook.zim"]);
    const config = new TextDecoder().decode(files.find((f) => f.path === "notebook.zim")!.bytes);
    expect(parseNotebookConfig(config)).toEqual({ name: "My notebook", home: "Home" });
    expect(config).toContain("endofline=unix");
  });

  it("goes back to what the store holds when a write fails, and says so", async () => {
    class Failing extends MemoryStore {
      fail = false;
      override async replacePages(id: string, change: { remove: string[]; put: StoredPage[] }): Promise<void> {
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
    expect(s.exportFiles().find((f) => f.path === "A.txt")!.bytes.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
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
    expect(imported.attachments).toBe(1);
    expect(imported.skipped.map((s) => s.path).sort()).toEqual(["Latin1.txt", "bad*name.txt", "help/auto formatting.txt"]);
    expect(imported.skipped.find((s) => s.path === "Latin1.txt")?.reason).toContain("UTF-8");
    expect(imported.skipped.find((s) => s.path.startsWith("help"))?.reason).toContain("same name");
    const bom = imported.pages.find((p) => p.name === "BOM")!;
    expect([bom.text, bom.bom, bom.lineEnding]).toEqual(["a\nb", true, "crlf"]);
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
