import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Kind, ListMarker, checkCodes } from "../src/kinds";
import { decodePage, encodePage, highlight, initZimSync, isZimReady } from "../src/zim";
import { corpusFiles, dump, readPage, spanProblem } from "./support";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("the wasm module", () => {
  it("loads, and its codes are the ones src/kinds.ts declares", () => {
    expect(isZimReady()).toBe(true); // initZimSync verified them
  });

  it("fails loudly when the constants and the wasm disagree", () => {
    const codes = {
      kinds: { ...Kind },
      listMarker: { ...ListMarker },
      opaque: { TABLE: 1, OBJECT: 2 },
      verbatimUnterminated: 1 << 16,
    };
    expect(() => checkCodes(codes)).not.toThrow();
    expect(() => checkCodes({ ...codes, kinds: { ...Kind, Bold: 99 } })).toThrow(/Bold.*11.*99/);
    expect(() => checkCodes({ ...codes, kinds: { ...Kind, Brand_new: 26 } })).toThrow(/Brand_new/);
    expect(() => checkCodes({ ...codes, verbatimUnterminated: 1 })).toThrow(/VERBATIM_UNTERMINATED/);
  });
});

describe("highlight across the wasm boundary", () => {
  it("counts offsets in UTF-16 units, the unit of JavaScript strings", () => {
    const text = "😀 **bold**"; // 😀 is two UTF-16 units but four UTF-8 bytes
    const spans = highlight(text);
    expect([spans.start(0), spans.end(0), spans.kind(0)]).toEqual([3, 11, Kind.Bold]);
    expect(text.slice(spans.start(0), spans.end(0))).toBe("**bold**");
  });

  it("gives the same spans as the Rust expectations (core/zim-format/tests/highlight.rs)", () => {
    const text = "a **b //c// d** e";
    expect(dump(text, highlight(text))).toEqual([
      'Bold "**b //c// d**"',
      'Marker(Bold) "**"',
      'Italic "//c//"',
      'Marker(Italic) "//"',
      'Marker(Italic) "//"',
      'Marker(Bold) "**"',
    ]);
    const page = "\tsome **bold\n\ttext** here\n";
    expect(dump(page, highlight(page))).toEqual([
      'IndentedParagraph "\\tsome **bold\\n\\ttext** here" #1',
      'Bold "**bold\\n\\ttext**"',
      'Marker(Bold) "**"',
      'Marker(Bold) "**"',
    ]);
  });

  it("keeps every offset on a character boundary for astral and combining text", () => {
    const text = "𝔘 **𝔘𝔫𝔦** é [[ünï|😀]] @tag\n* 日本語 //x//\n";
    expect(spanProblem(text, highlight(text))).toBeNull();
  });

  it("describes a page using every construct, and no more than the Rust side does", () => {
    const text =
      "Content-Type: text/x-zim-wiki\n\n====== Title ======\n\nSome **bold**, //it//, __u__, ~~s~~, ''v'', x^{2}, H_{2}O, [[a|b]], @t, http://e.org, me@e.org, {{./p.png?w=1|alt}}, {{id: x}}.\n\n* one\n\t[*] two\n\n\tindented\n\n'''\nraw\n'''\n\n--------------------\n\n| a |\n";
    const spans = highlight(text);
    expect(spanProblem(text, spans)).toBeNull();
    const kinds = new Set(Array.from({ length: spans.length }, (_, i) => spans.kind(i)));
    for (const [name, code] of Object.entries(Kind)) {
      if (name === "Opaque" || name === "HeaderKey" || name === "Header") continue;
      expect(kinds.has(code), `${name} should occur`).toBe(true);
    }
  });

  it("finds enclosing constructs and parents", () => {
    const text = "x **b //c// d** y";
    const spans = highlight(text);
    const inItalic = text.indexOf("c");
    // Edges are inclusive (a caret touching a construct is inside it), so the italic's opening
    // marker, which ends right where "c" starts, is listed too; look at the constructs only.
    const all = spans.enclosing(inItalic);
    expect(all.filter((i) => !spans.isMarker(i)).map((i) => spans.kind(i))).toEqual([Kind.Bold, Kind.Italic]);
    expect(all.filter((i) => spans.isMarker(i)).map((i) => spans.kind(spans.owner(i)))).toEqual([Kind.Italic]);
    const italic = spans.enclosing(inItalic, Kind.Italic)[0] as number;
    expect(spans.kind(spans.parent(italic))).toBe(Kind.Bold);
  });

  it("copes with an empty page and with pages that are only blank lines", () => {
    expect(highlight("").length).toBe(0);
    expect(highlight("\n\n\n").length).toBe(0);
  });
});

describe("the file layer across the wasm boundary", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("splits a BOM + CRLF file into clean text and puts it back exactly", () => {
    const original = bytes("\ufeffContent-Type: text/x-zim-wiki\r\n\r\n====== Title ======\r\n[ ] task\r\n");
    const page = decodePage(original);
    expect(page).toEqual({
      text: "Content-Type: text/x-zim-wiki\n\n====== Title ======\n[ ] task\n",
      bom: true,
      lineEnding: "crlf",
    });
    expect(Array.from(encodePage(page))).toEqual(Array.from(original));
    // ... and the clean text is what the parser can read: the header and the heading are found.
    const spans = highlight(page.text);
    const kinds = Array.from({ length: spans.length }, (_, i) => spans.kind(i));
    expect(kinds).toContain(Kind.Header);
    expect(kinds).toContain(Kind.Heading);
  });

  it("keeps a mixed-endings file's text exactly, carriage returns included", () => {
    const original = bytes("a\r\nb\nc\r");
    const page = decodePage(original);
    expect(page.lineEnding).toBe("mixed");
    expect(page.text).toBe("a\r\nb\nc\r");
    expect(Array.from(encodePage(page))).toEqual(Array.from(original));
  });

  it("an edited CRLF page is written with CRLF again", () => {
    const page = decodePage(bytes("one\r\ntwo\r\n"));
    const saved = encodePage({ ...page, text: page.text + "three\n" });
    expect(new TextDecoder().decode(saved)).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("refuses bytes that are not UTF-8, and says where", () => {
    expect(() => decodePage(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toThrow(/not valid UTF-8.*offset 3/);
  });

  it("rejects an unknown line ending", () => {
    expect(() => encodePage({ text: "x", bom: false, lineEnding: "cr" as never })).toThrow(/line ending/);
  });
});

const files = corpusFiles();
describe.skipIf(files.length === 0)("real Zim pages (ZIM_GOLDEN_DIR)", () => {
  it("have well-formed spans on this side of the boundary too", () => {
    let checked = 0;
    const problems: string[] = [];
    for (const file of files) {
      const text = readPage(file);
      if (text === null) continue;
      checked++;
      const problem = spanProblem(text, highlight(text));
      if (problem) problems.push(`${file}: ${problem}`);
    }
    expect(checked).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });
});
