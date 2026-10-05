import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { StateCommand } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { zimExtensions } from "../src/editor";
import {
  WRAPPERS,
  indentLess,
  indentMore,
  insertLink,
  listBackspace,
  listEnter,
  nextMarker,
  setHeading,
  toggleCheckboxHere,
  toggleList,
  toggleWrap,
} from "../src/editor/commands";
import { zimKeymap } from "../src/editor/keymap";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

// Tests are written as "this → that" with the selection inside the text: ¦ is a caret, ⟨…⟩ a selection.
const CARET = "¦";
const OPEN = "⟨";
const CLOSE = "⟩";

function parse(text: string): { doc: string; from: number; to: number } {
  let doc = "";
  let from = -1;
  let to = -1;
  for (const ch of text) {
    if (ch === CARET) from = to = doc.length;
    else if (ch === OPEN) from = doc.length;
    else if (ch === CLOSE) to = doc.length;
    else doc += ch;
  }
  if (from < 0 || to < 0) throw new Error(`no selection in ${JSON.stringify(text)}`);
  return { doc, from, to };
}

function show(state: EditorState): string {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  if (from === to) return doc.slice(0, from) + CARET + doc.slice(from);
  return doc.slice(0, from) + OPEN + doc.slice(from, to) + CLOSE + doc.slice(to);
}

/** Run `command` on `input` (with its selection marked) and return the result in the same notation, or null if it declined. */
function run(command: StateCommand, input: string, readOnly = false): string | null {
  const { doc, from, to } = parse(input);
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [zimExtensions({ exactLineBreaks: doc.includes("\r") }), ...(readOnly ? [EditorState.readOnly.of(true)] : [])],
  });
  const handled = command({ state, dispatch: (tr) => void (state = tr.state) });
  return handled ? show(state) : null;
}

describe("inline styles", () => {
  const bold = toggleWrap(WRAPPERS.bold);

  it("wrap the selection, which stays selected inside the markers", () => {
    expect(run(bold, "say ⟨hello⟩ now")).toBe("say **⟨hello⟩** now");
  });

  it("leave surrounding blanks outside the markers", () => {
    expect(run(bold, "say ⟨ hello ⟩ now")).toBe("say  **⟨hello⟩**  now");
  });

  it("wrap each line of a multi-line selection on its own, skipping blank lines", () => {
    expect(run(bold, "⟨one\n\ntwo⟩")).toBe("**⟨one**\n\n**two⟩**");
  });

  it("wrap the word under a bare caret and leave the caret where it was", () => {
    expect(run(bold, "say hel¦lo now")).toBe("say **hel¦lo** now");
    expect(run(bold, "say hello¦ now")).toBe("say **hello¦** now");
  });

  it("insert an empty pair, caret between, where there is no word", () => {
    expect(run(bold, "¦")).toBe("**¦**");
    expect(run(bold, "a ¦ b")).toBe("a **¦** b");
  });

  it("come off when the selection or caret is inside such a construct", () => {
    expect(run(bold, "say **⟨hello⟩** now")).toBe("say ⟨hello⟩ now");
    expect(run(bold, "say **hel¦lo** now")).toBe("say hel¦lo now");
    expect(run(bold, "say ⟨**hello**⟩ now")).toBe("say ⟨hello⟩ now");
    expect(run(bold, "say **hello**¦ now")).toBe("say hello¦ now"); // touching the closing marker counts
  });

  it("know each style's markers", () => {
    const styles: Array<[keyof typeof WRAPPERS, string]> = [
      ["italic", "//x//"],
      ["underline", "__x__"],
      ["strike", "~~x~~"],
      ["code", "''x''"],
      ["superscript", "^{x}"],
      ["subscript", "_{x}"],
    ];
    for (const [name, wrapped] of styles) {
      const toggle = toggleWrap(WRAPPERS[name]);
      expect(run(toggle, "⟨x⟩"), name).toBe(wrapped.replace("x", "⟨x⟩"));
      expect(run(toggle, wrapped.replace("x", "⟨x⟩")), `${name} off`).toBe("⟨x⟩");
    }
  });

  it("nest: a word inside bold can be made italic, and only the italic comes off", () => {
    const italic = toggleWrap(WRAPPERS.italic);
    expect(run(italic, "**bo¦ld**")).toBe("**//bo¦ld//**");
    expect(run(italic, "**//bo¦ld//**")).toBe("**bo¦ld**");
  });

  it("only take off the construct of the right kind", () => {
    expect(run(toggleWrap(WRAPPERS.italic), "**bo¦ld**")).toBe("**//bo¦ld//**");
  });

  it("do nothing in a read-only editor", () => {
    expect(run(bold, "⟨x⟩", true)).toBeNull();
  });

  it("insert a link around the selection, or an empty one", () => {
    expect(run(insertLink, "go ⟨there⟩ now")).toBe("go [[there]]¦ now");
    expect(run(insertLink, "go ¦ now")).toBe("go [[¦]] now");
  });
});

describe("headings", () => {
  it("make a plain line a heading, change its level, or turn it off", () => {
    expect(run(setHeading(1), "Ti¦tle")).toContain("====== Title ======");
    expect(run(setHeading(3), "====== Ti¦tle ======")).toContain("==== Title ====");
    expect(run(setHeading(1), "====== Ti¦tle ======")).toContain("Title");
    expect(run(setHeading(1), "====== Ti¦tle ======")).not.toContain("=");
    expect(run(setHeading(0), "=== Ti¦tle ===")).not.toContain("=");
  });

  it("level 5 is two equals signs", () => {
    expect(run(setHeading(5), "T¦")).toContain("== T ==");
  });

  it("apply to every selected line, skipping blank lines", () => {
    const out = run(setHeading(2), "⟨one\n\ntwo⟩") as string;
    expect(out.replace(/[⟨⟩¦]/g, "")).toBe("===== one =====\n\n===== two =====");
  });

  it("leave list items, code and header lines alone", () => {
    expect(run(setHeading(1), "* it¦em")).toBeNull();
    expect(run(setHeading(1), "'''\nco¦de\n'''")).toBeNull();
    expect(run(setHeading(1), "Content-Type: x¦\n\nbody")).toBeNull();
    expect(run(setHeading(0), "plain ¦text")).toBeNull();
  });
});

describe("list markers continue", () => {
  it("nextMarker", () => {
    expect(nextMarker("* ")).toBe("* ");
    expect(nextMarker("1. ")).toBe("2. ");
    expect(nextMarker("9. ")).toBe("10. ");
    expect(nextMarker("a. ")).toBe("b. ");
    expect(nextMarker("Y. ")).toBe("Z. ");
    expect(nextMarker("z. ")).toBe("a. ");
    expect(nextMarker("[*] ")).toBe("[ ] ");
    expect(nextMarker("[x] ")).toBe("[ ] ");
  });
});

describe("Enter in a list", () => {
  it("continues the list with the same indent and the next marker", () => {
    expect(run(listEnter, "* one¦")).toBe("* one\n* ¦");
    expect(run(listEnter, "1. one¦")).toBe("1. one\n2. ¦");
    expect(run(listEnter, "a. one¦")).toBe("a. one\nb. ¦");
    expect(run(listEnter, "[*] done¦")).toBe("[*] done\n[ ] ¦");
    expect(run(listEnter, "\t\t* deep¦")).toBe("\t\t* deep\n\t\t* ¦");
  });

  it("moves the rest of the text to the new item", () => {
    expect(run(listEnter, "* on¦e")).toBe("* on\n* ¦e");
    expect(run(listEnter, "* ⟨on⟩e")).toBe("* \n* ¦e");
  });

  it("on an empty item goes out a level, then off the list", () => {
    expect(run(listEnter, "* one\n\t* ¦")).toBe("* one\n* ¦");
    expect(run(listEnter, "* one\n* ¦")).toBe("* one\n¦");
  });

  it("is the ordinary Enter outside a list, and before an item's text", () => {
    expect(run(listEnter, "plain¦")).toBeNull();
    expect(run(listEnter, "¦* one")).toBeNull();
    expect(run(listEnter, "* ¦one")).not.toBeNull(); // right after the marker is already in the text
    expect(run(listEnter, "*¦ one")).toBeNull(); // inside the marker
  });
});

describe("Backspace after a marker", () => {
  it("takes the item off the list, or out a level", () => {
    expect(run(listBackspace, "* ¦one")).toBe("¦one");
    expect(run(listBackspace, "\t* ¦one")).toBe("* ¦one");
    expect(run(listBackspace, "[ ] ¦task")).toBe("¦task");
    expect(run(listBackspace, "* ¦")).toBe("¦");
  });

  it("is the ordinary Backspace everywhere else", () => {
    expect(run(listBackspace, "* o¦ne")).toBeNull();
    expect(run(listBackspace, "pla¦in")).toBeNull();
    expect(run(listBackspace, "* ⟨o⟩ne")).toBeNull();
  });
});

describe("Tab and Shift-Tab", () => {
  it("indent a list item from anywhere in it", () => {
    expect(run(indentMore, "* o¦ne")).toBe("\t* o¦ne");
    expect(run(indentMore, "* one\n* t¦wo")).toBe("* one\n\t* t¦wo");
  });

  it("insert a tab in plain text, but indent whole lines when several are selected", () => {
    expect(run(indentMore, "te¦xt")).toBe("te\t¦xt");
    expect(run(indentMore, "⟨a\nb⟩")).toBe("\t⟨a\n\tb⟩");
  });

  it("indent every selected list item", () => {
    expect(run(indentMore, "⟨* a\n* b⟩")).toBe("\t⟨* a\n\t* b⟩");
  });

  it("outdent, only where there is something to remove", () => {
    expect(run(indentLess, "\t\t* x¦")).toBe("\t* x¦");
    expect(run(indentLess, "⟨\t* a\n\t* b⟩")).toBe("⟨* a\n* b⟩");
    expect(run(indentLess, "* x¦")).toBeNull();
  });
});

describe("list kinds", () => {
  it("turn lines into a list, numbering them, and back", () => {
    expect(run(toggleList("bullet"), "⟨one\ntwo⟩")).toBe("* ⟨one\n* two⟩");
    expect(run(toggleList("number"), "⟨one\ntwo\nthree⟩")).toBe("1. ⟨one\n2. two\n3. three⟩");
    expect(run(toggleList("checkbox"), "⟨one\ntwo⟩")).toBe("[ ] ⟨one\n[ ] two⟩");
    expect(run(toggleList("bullet"), "⟨* one\n* two⟩")).toBe("⟨one\ntwo⟩");
  });

  it("keep indentation, skip blank lines, and change the kind of a line that already is an item", () => {
    expect(run(toggleList("bullet"), "⟨\tone\n\n\ttwo⟩")).toBe("⟨\t* one\n\n\t* two⟩");
    expect(run(toggleList("checkbox"), "* o¦ne")).toBe("[ ] o¦ne");
    expect(run(toggleList("bullet"), "[*] do¦ne")).toBe("* do¦ne");
  });

  it("taking an indented item off the list takes its indentation too", () => {
    expect(run(toggleList("bullet"), "\t* o¦ne")).toBe("o¦ne");
  });
});

describe("the checkbox of the current line", () => {
  it("is ticked, reopened, or dropped", () => {
    expect(run(toggleCheckboxHere(), "[ ] t¦ask")).toBe("[*] t¦ask");
    expect(run(toggleCheckboxHere(), "[*] t¦ask")).toBe("[ ] t¦ask");
    expect(run(toggleCheckboxHere(true), "[ ] t¦ask")).toBe("[x] t¦ask");
    expect(run(toggleCheckboxHere(true), "[x] t¦ask")).toBe("[ ] t¦ask");
  });

  it("is made on a bullet item or a plain line", () => {
    expect(run(toggleCheckboxHere(), "* it¦em")).toBe("[ ] it¦em");
    expect(run(toggleCheckboxHere(), "pla¦in")).toBe("[ ] pla¦in");
  });
});

describe("the keymap", () => {
  const keys = zimKeymap.map((b) => b.key);

  it("binds the editing keys", () => {
    for (const key of ["Mod-b", "Mod-i", "Mod-u", "Mod-k", "Mod-Alt-1", "Mod-Alt-5", "Mod-Alt-0", "Enter", "Backspace", "Tab", "Shift-Tab", "F12", "Mod-Enter"]) {
      expect(keys, key).toContain(key);
    }
  });

  it("doesn't bind keys a browser keeps for itself (tab switching and opening)", () => {
    for (const key of keys) {
      expect(key, key).not.toMatch(/^Mod-[1-9]$/);
    }
  });

  it("binds each key once", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});
