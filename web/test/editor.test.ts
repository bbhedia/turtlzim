import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDecorations, classifyLink, decorationsField, linkAt, spansOf, zimExtensions } from "../src/editor";
import { toggleCheckboxAt } from "../src/editor/commands";
import { BulletWidget, CheckboxWidget, ChipWidget, RuleWidget } from "../src/editor/widgets";
import { ListMarker } from "../src/kinds";
import { initZimSync } from "../src/zim";
import { corpusFiles, readPage } from "./support";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const stateOf = (doc: string, caret?: number | [number, number], showMarkup = false): EditorState =>
  EditorState.create({
    doc,
    ...(caret === undefined
      ? {}
      : { selection: typeof caret === "number" ? EditorSelection.cursor(caret) : EditorSelection.single(caret[0], caret[1]) }),
    // createZimEditor sets exactLineBreaks exactly when the text holds a carriage return
    extensions: zimExtensions({ showMarkup, exactLineBreaks: doc.includes("\r") }),
  });

interface Deco {
  from: number;
  to: number;
  cls: string;
  widget?: string;
  hidden: boolean;
  line: boolean;
}

/** The decorations of a state, as plain data. `hidden` is a replace decoration without a widget. */
function decos(state: EditorState): Deco[] {
  const out: Deco[] = [];
  state.field(decorationsField).all.between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: { constructor: { name: string } } };
    out.push({
      from,
      to,
      cls: spec.class ?? "",
      ...(spec.widget ? { widget: spec.widget.constructor.name } : {}),
      hidden: to > from && !spec.widget && !spec.class && value.point,
      // line decorations are zero-length point decorations that carry a class
      line: from === to && !!spec.class,
    });
  });
  return out;
}

const textOf = (state: EditorState, d: Deco) => state.sliceDoc(d.from, d.to);
const hiddenTexts = (state: EditorState) => decos(state).filter((d) => d.hidden).map((d) => textOf(state, d));

describe("the document is the page text, byte for byte", () => {
  const samples: Record<string, string> = {
    "CRs kept (a mixed-endings file)": "====== T ======\r\nline two\nthree\r",
    "lone CR": "a\rb\rc",
    bom: "﻿Content-Type: text/x-zim-wiki\n\n====== T ======\n",
    "trailing whitespace": "text   \n\t\n\n\nno final newline  ",
    "control characters": "a\u0000b c\u0007",
    "astral and combining": "𝔘𝔫𝔦 é 😀\n",
    empty: "",
  };
  for (const [name, text] of Object.entries(samples)) {
    it(name, () => {
      expect(stateOf(text).doc.toString()).toBe(text);
    });
  }

  it("normal pages treat a pasted CRLF as one line break, so a CRLF file stays consistent", () => {
    const state = stateOf("one\ntwo");
    const pasted = state.update({ changes: { from: 3, insert: state.toText("\r\nA\r\nB\rC") } }).state.doc;
    expect(pasted.toString()).toBe("one\nA\nB\nC\ntwo");
  });

  it("pages that hold a carriage return keep every one, and a pasted CRLF stays as pasted", () => {
    const state = stateOf("a\r\nb");
    expect(state.doc.lines).toBe(2);
    const pasted = state.update({ changes: { from: 1, insert: state.toText("X\r\nY") } }).state.doc;
    expect(pasted.toString()).toBe("aX\r\nY\r\nb");
  });

  it("also holds for every real Zim page", () => {
    const files = corpusFiles();
    if (files.length === 0) return; // needs ZIM_GOLDEN_DIR
    let checked = 0;
    for (const file of files) {
      const text = readPage(file);
      if (text === null) continue;
      expect(stateOf(text).doc.toString(), file).toBe(text);
      expect(buildDecorations(stateOf(text), spansOf(stateOf(text)), false)).toBeTruthy();
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("live preview: syntax characters hide until the caret reaches their construct", () => {
  it("hides a heading's = signs unless the caret is on its line", () => {
    const doc = "====== Title ======\nbody";
    expect(hiddenTexts(stateOf(doc, doc.length))).toEqual(["====== ", " ======"]);
    const on = stateOf(doc, 3);
    expect(hiddenTexts(on)).toEqual([]);
    expect(decos(on).some((d) => d.cls === "cm-zim-marker" && textOf(on, d) === "====== ")).toBe(true);
    expect(decos(on).some((d) => d.cls.includes("cm-zim-h1") && d.line)).toBe(true);
  });

  it("hides **, // and friends around text the caret isn't in, and shows them when it is", () => {
    const doc = "plain **bold** and //it// end";
    expect(hiddenTexts(stateOf(doc, 0))).toEqual(["**", "**", "//", "//"]);
    // inside the bold: its asterisks show, the italics' slashes stay hidden
    expect(hiddenTexts(stateOf(doc, doc.indexOf("bold") + 2))).toEqual(["//", "//"]);
    // touching the edge counts as inside
    expect(hiddenTexts(stateOf(doc, doc.indexOf("**")))).toEqual(["//", "//"]);
    expect(hiddenTexts(stateOf(doc, doc.indexOf("**") + 8))).toEqual(["//", "//"]);
  });

  it("reveals the markers of every construct a selection touches", () => {
    const doc = "**a** and //b// and ~~c~~";
    expect(hiddenTexts(stateOf(doc, [0, doc.indexOf("//b") + 4]))).toEqual(["~~", "~~"]);
  });

  it("keeps everything visible in show-markup mode", () => {
    const doc = "====== T ======\n**b** [[a|b]]";
    expect(hiddenTexts(stateOf(doc, doc.length, true))).toEqual([]);
  });

  it("shows a link's display text and hides its target and brackets", () => {
    const doc = "see [[Some:Page|the page]] now";
    expect(hiddenTexts(stateOf(doc, 0))).toEqual(["[[", "Some:Page", "|", "]]"]);
    const at = stateOf(doc, doc.indexOf("the page") + 2);
    expect(hiddenTexts(at)).toEqual([]);
    const plain = "see [[Some:Page]] now";
    expect(hiddenTexts(stateOf(plain, 0))).toEqual(["[[", "]]"]); // the target is the text, so it stays
  });

  it("draws bullets, checkboxes and rules as widgets, and images and anchors as chips", () => {
    const doc = "* one\n[ ] open\n[*] done\n[x] dropped\n--------------------\n{{./pics/a.png|My picture}} {{id: spot}}\n";
    const state = stateOf(doc, doc.length);
    const widgets = decos(state).filter((d) => d.widget).map((d) => [d.widget, textOf(state, d)]);
    expect(widgets).toEqual([
      ["BulletWidget", "* "],
      ["CheckboxWidget", "[ ] "],
      ["CheckboxWidget", "[*] "],
      ["CheckboxWidget", "[x] "],
      ["RuleWidget", "--------------------"],
      ["ChipWidget", "{{./pics/a.png|My picture}}"],
      ["ChipWidget", "{{id: spot}}"],
    ]);
    // markers inside a chip are not decorated separately (the chip replaces them)
    expect(decos(state).filter((d) => d.cls === "cm-zim-marker" || d.hidden)).toEqual([]);
    // done and dropped items are styled as such
    expect(decos(state).some((d) => d.cls === "cm-zim-item-done")).toBe(true);
    expect(decos(state).some((d) => d.cls === "cm-zim-item-dropped")).toBe(true);
  });

  it("shows an image's or anchor's source when the caret is in it", () => {
    const doc = "x {{./a.png|alt}} y";
    const state = stateOf(doc, doc.indexOf("a.png"));
    expect(decos(state).some((d) => d.widget)).toBe(false);
    expect(decos(state).some((d) => d.cls === "cm-zim-image-source")).toBe(true);
  });

  it("labels an image chip with its alt text, else its file name", () => {
    const chip = (doc: string) => {
      const widget = decos(stateOf(doc, doc.length)).find((d) => d.widget === "ChipWidget");
      return widget;
    };
    expect(chip("{{./dir/photo.png?width=5}} end")?.widget).toBe("ChipWidget");
    const labelOf = (doc: string) => {
      const state = stateOf(doc, doc.length);
      let label = "";
      state.field(decorationsField).all.between(0, doc.length, (_f, _t, v) => {
        const w = (v.spec as { widget?: ChipWidget }).widget;
        if (w instanceof ChipWidget) label = w.text;
      });
      return label;
    };
    expect(labelOf("{{./dir/photo.png?width=5}} end")).toBe("photo.png");
    expect(labelOf("{{./dir/photo.png|A nice photo}} end")).toBe("A nice photo");
  });

  it("styles blocks line by line", () => {
    const doc = "'''\ncode\n'''\n\n\tindented\n\t\tdeeper? no, one paragraph\n\n| a | b |\n";
    const state = stateOf(doc, doc.length);
    const lineClasses = decos(state).filter((d) => d.line).map((d) => d.cls);
    expect(lineClasses.filter((c) => c.startsWith("cm-zim-code")).length).toBe(3);
    expect(lineClasses.some((c) => c.includes("cm-zim-code-first"))).toBe(true);
    expect(lineClasses.some((c) => c.includes("cm-zim-code-last"))).toBe(true);
    expect(lineClasses.filter((c) => c === "cm-zim-indented").length).toBe(2);
    expect(lineClasses.some((c) => c.includes("cm-zim-table"))).toBe(true);
    // the fences are hidden when the caret is elsewhere
    expect(hiddenTexts(state)).toEqual(["'''", "'''"]);
  });

  it("flags a code block that never closes", () => {
    const state = stateOf("'''\nunfinished\n", 0);
    expect(decos(state).some((d) => d.cls.includes("cm-zim-code-open"))).toBe(true);
  });

  it("makes every replaced range atomic so the caret skips it", () => {
    const state = stateOf("* item with **bold**\n", 0);
    const atomic: string[] = [];
    state.field(decorationsField).atomic.between(0, state.doc.length, (f, t) => void atomic.push(state.sliceDoc(f, t)));
    expect(atomic).toEqual(["* ", "**", "**"]);
  });

  it("uses the same widget classes the tests expect", () => {
    expect(new BulletWidget().eq(new BulletWidget())).toBe(true);
    expect(new CheckboxWidget(ListMarker.CHECKED).eq(new CheckboxWidget(ListMarker.UNCHECKED))).toBe(false);
    expect(new RuleWidget().eq(new RuleWidget())).toBe(true);
  });
});

describe("checkboxes", () => {
  const apply = (doc: string, at: number, cross = false) => {
    const state = stateOf(doc);
    const spec = toggleCheckboxAt(state, at, cross);
    if (!spec) return null;
    return state.update(spec).state.doc.toString();
  };

  it("an open box becomes done, any other state reopens", () => {
    expect(apply("[ ] task", 0)).toBe("[*] task");
    expect(apply("[*] task", 0)).toBe("[ ] task");
    expect(apply("[x] task", 0)).toBe("[*] task");
    expect(apply("[>] task", 0)).toBe("[ ] task");
    expect(apply("[<] task", 0)).toBe("[ ] task");
  });

  it("with cross held, open and dropped swap and done becomes dropped", () => {
    expect(apply("[ ] task", 0, true)).toBe("[x] task");
    expect(apply("[x] task", 0, true)).toBe("[ ] task");
    expect(apply("[*] task", 0, true)).toBe("[x] task");
  });

  it("changes only the glyph, in nested items too", () => {
    const doc = "* a\n\t[ ] sub **x**\n";
    expect(apply(doc, doc.indexOf("[ ]"))).toBe("* a\n\t[*] sub **x**\n");
  });

  it("does nothing where there is no checkbox", () => {
    expect(apply("* bullet", 0)).toBeNull();
    expect(apply("[ ] task", 3)).toBeNull();
    expect(apply("plain", 0)).toBeNull();
  });
});

describe("links", () => {
  it("classifies targets", () => {
    expect(classifyLink("Page")).toBe("page");
    expect(classifyLink(":Absolute:Page")).toBe("page");
    expect(classifyLink("+Child")).toBe("page");
    expect(classifyLink("Ns:Page#anchor")).toBe("page");
    expect(classifyLink("#here")).toBe("anchor");
    expect(classifyLink("https://example.org/x")).toBe("url");
    expect(classifyLink("ftp://example.org")).toBe("url");
    expect(classifyLink("file:///etc/passwd")).toBe("file");
    expect(classifyLink("mailto:me@example.org")).toBe("email");
    expect(classifyLink("me@example.org")).toBe("email");
    expect(classifyLink("wp?Test")).toBe("interwiki");
  });

  it("finds the link under a position, with its target and label", () => {
    const doc = "go [[Ns:Page|to the page]] or [[Other]] or https://example.org/a and me@example.org";
    const state = stateOf(doc);
    expect(linkAt(state, doc.indexOf("to the"))).toMatchObject({ kind: "page", target: "Ns:Page", label: "to the page" });
    expect(linkAt(state, doc.indexOf("Other"))).toMatchObject({ kind: "page", target: "Other", label: "Other" });
    expect(linkAt(state, doc.indexOf("example.org/a"))).toMatchObject({ kind: "url", target: "https://example.org/a" });
    expect(linkAt(state, doc.length - 3)).toMatchObject({ kind: "email", target: "mailto:me@example.org", label: "me@example.org" });
    expect(linkAt(state, 1)).toBeNull();
  });
});
