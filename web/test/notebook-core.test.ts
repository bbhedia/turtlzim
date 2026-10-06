import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  NotebookModel,
  anchorsIn,
  checkFilePath,
  checkPageName,
  classifyLink,
  headingId,
  imageParam,
  imagesIn,
  linksIn,
  newPageText,
  pageToPath,
  parsePageName,
  pathToPage,
  relativeFileText,
  safeFileName,
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
    expect(report).toEqual({ moved: [["Help:Links", "Help:Linking"]], rewritten: ["Help", "Start"], linksChanged: 3, filesMoved: [] });
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

describe("files", () => {
  function withFiles(): NotebookModel {
    const nb = new NotebookModel();
    nb.put("Usage", "====== Usage ======\n");
    nb.put("Usage:Getting Things Done", "\t{{../GTD_flowchart.png}} and [[./notes.pdf|notes]]\n");
    for (const path of ["Usage/GTD_flowchart.png", "Usage/Getting_Things_Done/notes.pdf", "top.png"]) nb.putFile(path);
    return nb;
  }

  it("are paths in a notebook, found by folder, ignoring case", () => {
    const nb = withFiles();
    expect(nb.fileCount).toBe(3);
    expect(nb.files()).toEqual(["top.png", "Usage/Getting_Things_Done/notes.pdf", "Usage/GTD_flowchart.png"]);
    expect(nb.filesOf("usage")).toEqual(["Usage/GTD_flowchart.png"]);
    expect(nb.filesOf("Usage:Getting Things Done")).toEqual(["Usage/Getting_Things_Done/notes.pdf"]);
    expect(nb.filesBelow("Usage")).toHaveLength(2);
    expect(nb.hasFile("USAGE/gtd_flowchart.PNG")).toBe(true);
    expect(nb.filePath("USAGE/gtd_flowchart.PNG")).toBe("Usage/GTD_flowchart.png");
    expect(nb.filePath("nope.png")).toBeUndefined();
    expect(nb.filesOf("not a * valid name")).toEqual([]);
  });

  it("refuse a path that can't be a file, with a message to show", () => {
    const nb = new NotebookModel();
    expect(() => nb.putFile("../a.png")).toThrow(/\.\./);
    expect(() => nb.putFile("/abs")).toThrow(/relative/);
    expect(() => nb.putFile(".hidden/a")).toThrow(/hidden/);
    expect(nb.fileCount).toBe(0);
    expect(checkFilePath("Foo/a.png")).toBeUndefined();
    expect(checkFilePath("Foo//a.png")).toMatch(/empty part/);
  });

  it("are looked up from the folder of the page that refers to them", () => {
    const nb = withFiles();
    expect(nb.resolveFile("Usage:Getting Things Done", "../GTD_flowchart.png")).toEqual({ kind: "notebook", path: "Usage/GTD_flowchart.png", exists: true });
    expect(nb.resolveFile("Usage:Getting Things Done", "./notes.pdf")).toEqual({ kind: "notebook", path: "Usage/Getting_Things_Done/notes.pdf", exists: true });
    expect(nb.resolveFile("Usage:Getting Things Done", "./nope.png")).toEqual({ kind: "notebook", path: "Usage/Getting_Things_Done/nope.png", exists: false });
    expect(nb.resolveFile("Usage", "/etc/hosts")).toEqual({ kind: "outside" });
    expect(nb.resolveFile("Usage", "../../x")).toEqual({ kind: "outside" });
    expect(() => nb.resolveFile("bad*name", "./a")).toThrow(/can't contain/);
  });

  it("get safe names and free paths when they are attached", () => {
    const nb = withFiles();
    expect(safeFileName("What? [ok].png")).toBe("What_ _ok_.png");
    expect(safeFileName("")).toBe("file");
    expect(nb.attachmentPath("Usage", "GTD_flowchart.png")).toBe("Usage/GTD_flowchart 2.png");
    expect(nb.attachmentPath("Usage:Getting Things Done", "new/pic.png")).toBe("Usage/Getting_Things_Done/pic.png");
    expect(nb.fileLink("Usage:Getting Things Done", "Usage/GTD_flowchart.png")).toBe("../GTD_flowchart.png");
    expect(relativeFileText("Usage", "Usage/a.png")).toBe("./a.png");
    expect(relativeFileText("Usage", "Usage/a.png", false)).toBe("a.png");
    expect(relativeFileText("Usage:Sub", "top.png")).toBe("../../top.png");
  });

  it("move with their page when it is renamed, and the references to them follow", () => {
    const nb = withFiles();
    nb.put("Index", "{{../Usage/GTD_flowchart.png?width=50}}\n");
    const report = nb.rename("Usage", "Docs:Usage");
    expect(report.filesMoved).toEqual([
      ["Usage/Getting_Things_Done/notes.pdf", "Docs/Usage/Getting_Things_Done/notes.pdf"],
      ["Usage/GTD_flowchart.png", "Docs/Usage/GTD_flowchart.png"],
    ]);
    expect(nb.files()).toEqual(["Docs/Usage/Getting_Things_Done/notes.pdf", "Docs/Usage/GTD_flowchart.png", "top.png"]);
    expect(nb.get("Index")).toBe("{{../Docs/Usage/GTD_flowchart.png?width=50}}\n");
    expect(report.linksChanged).toBe(1);
    expect(nb.resolveFile("Docs:Usage:Getting Things Done", "../GTD_flowchart.png")).toMatchObject({ exists: true });
  });

  it("go with their page when it is deleted", () => {
    const nb = withFiles();
    nb.removeTree("Usage");
    expect(nb.removeFilesBelow("Usage")).toEqual(["Usage/Getting_Things_Done/notes.pdf", "Usage/GTD_flowchart.png"]);
    expect(nb.files()).toEqual(["top.png"]);
    expect(nb.removeFile("TOP.png")).toBe(true);
    expect(nb.removeFile("top.png")).toBe(false);
  });

  it("are referred to by images, found with positions that index the JavaScript string", () => {
    const text = "😀 {{./a b.png?width=20&height=10&flag|Alt}} and {{id: here}} {{../c.png}}\n";
    const images = imagesIn(text);
    expect(images.map((i) => i.path)).toEqual(["./a b.png", "../c.png"]);
    for (const image of images) {
      expect(text.slice(image.start, image.start + 2)).toBe("{{");
      expect(text.slice(image.end - 2, image.end)).toBe("}}");
      expect(text.slice(image.pathStart, image.pathEnd)).toBe(image.path);
    }
    expect(images[0]!.alt).toBe("Alt");
    expect(images[0]!.query).toEqual([["width", "20"], ["height", "10"], ["flag", null]]);
    expect(imageParam(images[0]!, "WIDTH")).toBe("20");
    expect(imageParam(images[0]!, "flag")).toBeUndefined();
    expect(imageParam(images[1]!, "width")).toBeUndefined();
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

/** The files of a notebook folder that are not pages: their paths, with `/` between folders. */
function readFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path);
      else {
        const relativePath = relative(root, path).split("\\").join("/");
        if (relativePath !== "notebook.zim" && !relativePath.endsWith(".txt")) files.push(relativePath);
      }
    }
  };
  walk(root);
  return files.sort();
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

  it("have every image and file link leading to an attachment that is there", () => {
    for (const root of roots) {
      const nb = new NotebookModel();
      const pages = readNotebook(root);
      for (const [name, text] of pages) nb.put(name, text);
      const files = readFiles(root);
      for (const file of files) nb.putFile(file);
      expect(nb.fileCount, root).toBe(files.length);
      const broken: string[] = [];
      let found = 0;
      for (const [name, text] of pages) {
        const targets = [...imagesIn(text).map((i) => i.path), ...linksIn(text).map((l) => l.target).filter((t) => classifyLink(t) === "file")];
        for (const target of targets) {
          const resolved = nb.resolveFile(name, target);
          if (resolved.kind === "notebook") {
            if (resolved.exists) found++;
            else broken.push(`${name}: ${target}`);
          }
        }
      }
      expect(broken, root).toEqual([]);
      // the Rust test prints "25 images and 0 file links lead to 25 of them" for Zim's manual
      if (pages.has("Usage:Getting Things Done")) expect(found).toBe(25);
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
      for (const file of readFiles(root)) nb.putFile(file);
      const report = nb.rename("Help", "Docs:Handbook");
      expect([report.moved.length, report.linksChanged, report.rewritten.length, report.filesMoved.length]).toEqual([27, 77, 27, 0]);
      // and moving the section that holds most attachments takes them along, as the Rust test shows
      // ("Plugins -> Addons: 40 pages and 32 files moved, 43 links rewritten on 22 pages")
      const plugins = new NotebookModel();
      for (const [name, text] of pages) plugins.put(name, text);
      for (const file of readFiles(root)) plugins.putFile(file);
      const moved = plugins.rename("Plugins", "Addons");
      expect([moved.moved.length, moved.filesMoved.length, moved.linksChanged, moved.rewritten.length]).toEqual([40, 32, 43, 22]);
      plugins.free();
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
