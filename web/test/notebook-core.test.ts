import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  NotebookModel,
  anchorsIn,
  checkPageName,
  classifyLink,
  headingId,
  linksIn,
  newPageText,
  pageToPath,
  parsePageName,
  pathToPage,
  zimTimestamp,
} from "../src/notebook-core";
import { decodePage, initZimSync } from "../src/zim";
import { notebookRoots } from "./support";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

function sample(): NotebookModel {
  const nb = new NotebookModel();
  nb.put("Help", "====== Help ======\nsee [[+Links]]\n");
  nb.put("Help:Links", "back to [[Help]] and [[Start]] and [[nowhere]] and [[https://example.org]]\n");
  nb.put("Start", "go to [[Help:Links]], also [[help:links#top|the links page]]\n");
  return nb;
}

describe("names", () => {
  it("are read the way Zim reads them", () => {
    expect(parsePageName(":Help: Auto_Formatting ")).toBe("Help:Auto Formatting");
    expect(parsePageName("日本語:ページ")).toBe("日本語:ページ");
  });

  it("are refused with a message a person can act on", () => {
    expect(() => parsePageName("a*b")).toThrow(/can't contain '\*'/);
    expect(() => parsePageName("")).toThrow(/can't be empty/);
    expect(() => parsePageName("a::b")).toThrow(/empty part/);
    expect(() => parsePageName(".hidden")).toThrow(/dot/);
    expect(checkPageName("a|b")).toEqual({ error: expect.stringContaining("'|'") });
    expect(checkPageName("Fine:Name")).toEqual({ name: "Fine:Name" });
  });

  it("map to files and back", () => {
    expect(pageToPath("Plugins:Table Editor:Basic")).toBe("Plugins/Table_Editor/Basic.txt");
    expect(pathToPage("Plugins/Table_Editor/Basic.txt")).toBe("Plugins:Table Editor:Basic");
    expect(() => pathToPage("notebook.zim")).toThrow(/\.txt/);
    expect(() => pathToPage("../x.txt")).toThrow();
  });
});

describe("link targets", () => {
  it("are classified by the Rust rules", () => {
    const cases: Record<string, string> = {
      "https://example.org": "url",
      "file:///tmp/x": "file",
      "./pic.png": "file",
      "mailto:me@example.org": "email",
      "me@example.org": "email",
      "#heading": "anchor",
      "wp?wiki": "interwiki",
      "Help:Links": "page",
      ":Abs": "page",
      "+Child": "page",
      "": "invalid",
    };
    for (const [target, kind] of Object.entries(cases)) expect(classifyLink(target), target).toBe(kind);
  });

  it("have heading ids", () => {
    expect(headingId("Link to a heading or object")).toBe("link-to-a-heading-or-object");
  });

  it("are found in a text, with positions that index the JavaScript string", () => {
    const text = "😀 see [[Zü]] and [[:A:B|shown]] {{id: spot}}\n====== Ö ======\n";
    const links = linksIn(text);
    expect(links.map((l) => [l.target, l.display])).toEqual([["Zü", null], [":A:B", "shown"]]);
    for (const link of links) {
      expect(text.slice(link.targetStart, link.targetEnd)).toBe(link.target);
      expect(text.slice(link.start, link.start + 2)).toBe("[[");
      expect(text.slice(link.end - 2, link.end)).toBe("]]");
    }
    const anchors = anchorsIn(text);
    expect(anchors.map((a) => a.id)).toEqual(["spot", "ö"]);
    expect(text.slice(anchors[0]!.at, anchors[0]!.at + 5)).toBe("{{id:");
    expect(text.slice(anchors[1]!.at, anchors[1]!.at + 6)).toBe("======");
  });
});

describe("a notebook", () => {
  it("holds pages, ignoring case, and lists its tree", () => {
    const nb = sample();
    expect(nb.size).toBe(3);
    expect(nb.get("help:LINKS")).toContain("back to");
    expect(nb.has("Help")).toBe(true);
    expect(nb.has("Nope")).toBe(false);
    expect(nb.find("HELP")).toBe("Help");
    expect(nb.names()).toEqual(["Help", "Help:Links", "Start"]);
    expect(nb.tree()).toEqual([
      { name: "Help", depth: 0, hasPage: true, children: 1 },
      { name: "Help:Links", depth: 1, hasPage: true, children: 0 },
      { name: "Start", depth: 0, hasPage: true, children: 0 },
    ]);
    expect(() => nb.put("bad*name", "x")).toThrow(/can't contain/);
    expect(nb.get("bad*name")).toBeUndefined();
  });

  it("says where links lead", () => {
    const nb = sample();
    expect(nb.resolve("Help:Links", "Start")).toEqual({ kind: "page", page: "Start", exists: true, anchor: null });
    expect(nb.resolve("Help:Links", "nowhere#top")).toEqual({ kind: "page", page: "Help:nowhere", exists: false, anchor: "top" });
    expect(nb.resolve("Help", "+Links")).toEqual({ kind: "page", page: "Help:Links", exists: true, anchor: null });
    expect(nb.resolve("Help", "#part")).toEqual({ kind: "anchor", anchor: "part" });
    expect(nb.resolve("Help", "https://example.org")).toEqual({ kind: "url", url: "https://example.org" });
    expect(nb.resolve("Help", "wp?Zim")).toEqual({ kind: "interwiki", key: "wp", page: "Zim" });
    expect(nb.resolve("Help", "Foo::Bar")).toEqual({ kind: "invalid", reason: expect.stringContaining("empty part") });
    expect(nb.linkTo("Start", "Help:Links")).toBe("Help:Links");
    expect(nb.linkTo("Help", "Help:Links")).toBe("+Links");
  });

  it("knows what links to a page, and finds text", () => {
    const nb = sample();
    expect(nb.backlinks("Help:Links").map((b) => [b.from, b.count])).toEqual([["Help", 1], ["Start", 2]]);
    expect(nb.backlinks("not a valid * name")).toEqual([]);
    expect(nb.search("example").map((h) => h.page)).toEqual(["Help:Links"]);
    expect(nb.search("links")[0]).toMatchObject({ inName: true });
  });

  it("renames, rewriting links, and says what it did", () => {
    const nb = sample();
    const report = nb.rename("Help:Links", "Help:Linking");
    expect(report).toEqual({ moved: [["Help:Links", "Help:Linking"]], rewritten: ["Help", "Start"], linksChanged: 3 });
    expect(nb.get("Start")).toBe("go to [[Help:Linking]], also [[Help:Linking#top|the links page]]\n");
    expect(nb.get("Help")).toContain("[[+Linking]]");
    expect(nb.has("Help:Links")).toBe(false);
  });

  it("refuses a rename it can't do, with a message to show, and changes nothing", () => {
    const nb = sample();
    expect(() => nb.rename("Help", "Start")).toThrow(/already exists/);
    expect(() => nb.rename("Missing", "Other")).toThrow(/no page called Missing/);
    expect(() => nb.rename("Help", "Help:Deeper")).toThrow(/below itself/);
    expect(nb.names()).toEqual(["Help", "Help:Links", "Start"]);
  });

  it("removes a page, or a page with all below it", () => {
    const nb = sample();
    expect(nb.remove("Help")).toBe(true);
    expect(nb.removeTree("Help")).toEqual(["Help:Links"]);
    expect(nb.names()).toEqual(["Start"]);
  });
});

describe("new pages", () => {
  it("start the way Zim starts them", () => {
    expect(newPageText("Projects:Garden", "2026-10-06T09:41:03+02:00")).toBe(
      "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:41:03+02:00\n\n====== Garden ======\n",
    );
  });

  it("are stamped the way Zim writes a creation date", () => {
    expect(zimTimestamp()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(zimTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^2026-01-02T03:04:05[+-]\d\d:\d\d$/);
  });
});

/** The pages of a notebook folder, named by the Rust rules (so `pathToPage` and `decodePage` are exercised too). */
function readNotebook(root: string): Map<string, string> {
  const pages = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".txt")) {
        try {
          pages.set(pathToPage(relative(root, path).split("\\").join("/")), decodePage(new Uint8Array(readFileSync(path))).text);
        } catch {
          // not a page: a name or encoding the rules refuse
        }
      }
    }
  };
  walk(root);
  return pages;
}

const roots = notebookRoots();
describe.skipIf(roots.length === 0)("real Zim notebooks (ZIM_GOLDEN_DIR), through the wasm build", () => {
  it("have every page link leading to a page", () => {
    for (const root of roots) {
      const nb = new NotebookModel();
      const pages = readNotebook(root);
      for (const [name, text] of pages) nb.put(name, text);
      expect(nb.size, root).toBe(pages.size);
      const broken: string[] = [];
      let links = 0;
      for (const [name, text] of pages) {
        for (const link of linksIn(text)) {
          const resolved = nb.resolve(name, link.target);
          if (resolved.kind === "page") {
            links++;
            if (!resolved.exists) broken.push(`${name}: [[${link.target}]]`);
          }
        }
      }
      expect(broken, root).toEqual([]);
      expect(links).toBeGreaterThan(0);
      nb.free();
    }
  });

  it("rename the same way the native Rust build does", () => {
    // The Rust test prints "Help -> Docs:Handbook: 27 pages moved, 77 links rewritten on 27 pages"
    // for Zim's manual; the wasm build must do exactly the same.
    for (const root of roots) {
      const pages = readNotebook(root);
      if (!pages.has("Help:Links") || !pages.has("Help")) continue;
      const nb = new NotebookModel();
      for (const [name, text] of pages) nb.put(name, text);
      const report = nb.rename("Help", "Docs:Handbook");
      expect([report.moved.length, report.linksChanged, report.rewritten.length]).toEqual([27, 77, 27]);
      // and every link still leads to a page that exists
      for (const name of nb.names()) {
        for (const link of linksIn(nb.get(name)!)) {
          const resolved = nb.resolve(name, link.target);
          if (resolved.kind === "page") expect(resolved.exists, `${name}: [[${link.target}]]`).toBe(true);
        }
      }
      nb.free();
    }
  });
});
