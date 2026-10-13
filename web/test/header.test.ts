// The page's header (Zim's own lines: `Content-Type`, `Wiki-Format`, `Creation-Date`) is folded into one line, as Zim hides it, until the
// caret comes into it. The document is the file as it was: this is how it is drawn.
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { decorationsField, setShowMarkup } from "../src/editor";
import { pageBodyStart } from "../src/editor/commands";
import { HeaderWidget, headerLabel } from "../src/editor/widgets";
import { initZimSync } from "../src/zim";
import { stateOf } from "./helpers/marked";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const HEADER = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00";

/** How a page is drawn: the chips that fold a header, and the lines of a header that is shown. */
function draw(marked: string, options: { markup?: boolean; readOnly?: boolean } = {}) {
  const state = stateOf(marked, [...(options.readOnly ? [EditorState.readOnly.of(true)] : [])]);
  const shown = options.markup ? state.update({ effects: setShowMarkup.of(true) }).state : state;
  const chips: Array<{ from: number; to: number; block: boolean; text: string }> = [];
  const lines: number[] = [];
  shown.field(decorationsField).all.between(0, shown.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: unknown; block?: boolean };
    if (spec.widget instanceof HeaderWidget) chips.push({ from, to, block: !!spec.block, text: spec.widget.text });
    if (spec.class?.includes("cm-zim-header") && !spec.class.includes("header-key")) lines.push(from);
  });
  return { state: shown, chips, lines };
}

describe("the header of a page, folded", () => {
  it("is one line in place of its lines, a block, while the caret is in the body", () => {
    const { chips, lines } = draw(`${HEADER}\n\n====== Garden ======\nbo¦dy\n`);
    expect(chips).toEqual([{ from: 0, to: HEADER.length, block: true, text: HEADER }]);
    expect(lines).toEqual([]);
  });

  it("is so at the start of the page, where a page is opened, and on the empty line below it", () => {
    for (const marked of [`¦${HEADER}\n\n====== Garden ======\nbody\n`, `${HEADER}\n¦\n====== Garden ======\nbody\n`, `${HEADER}\n\n¦====== Garden ======\nbody\n`]) {
      expect(draw(marked).chips, marked).toHaveLength(1);
    }
  });

  it("is so in a page that is only a header, and in one that can't be changed", () => {
    expect(draw(`${HEADER}\n¦`).chips).toHaveLength(1);
    expect(draw(`${HEADER}\n\nbo¦dy\n`, { readOnly: true }).chips).toHaveLength(1);
  });

  it("is the three lines, as written, when the caret is in them, on their first or last character but the page's first", () => {
    for (const marked of [`C¦ontent-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00\n\nbody\n`, `${HEADER.replace("zim 0.6", "zi¦m 0.6")}\n\nbody\n`, `${HEADER}¦\n\nbody\n`, `⟨Cont⟩ent-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00\n\nbody\n`]) {
      const { chips, lines } = draw(marked);
      expect(chips, marked).toHaveLength(0);
      expect(lines, marked).toHaveLength(3);
    }
  });

  it("is the three lines, as written, whatever the caret, when the markup is shown", () => {
    const { chips, lines } = draw(`${HEADER}\n\nbo¦dy\n`, { markup: true });
    expect(chips).toHaveLength(0);
    expect(lines).toHaveLength(3);
  });

  it("is unfolded by a selection that starts at the start of the page and goes on (select all, Shift+Up from the body), and not by a caret that is only there", () => {
    expect(draw(`⟨${HEADER}\n\nbody⟩\n`).chips).toHaveLength(0);
    expect(draw(`¦${HEADER}\n\nbody\n`).chips).toHaveLength(1);
  });

  it("is not there for a page that has no header, or one that only looks like it", () => {
    expect(draw("====== Garden ======\nbo¦dy\n").chips).toEqual([]);
    expect(draw("Content-Type is a sentence, not a header\nbo¦dy\n").chips).toEqual([]);
    expect(draw("¦").chips).toEqual([]);
  });

  it("changes nothing of the text, and the body starts below the header and its empty line", () => {
    const text = `${HEADER}\n\n====== Garden ======\nbody\n`;
    const { state } = draw(`${HEADER}\n\n====== Garden ======\nbo¦dy\n`);
    expect(state.doc.toString()).toBe(text);
    expect(pageBodyStart(state)).toBe(HEADER.length + 2);
    expect(state.doc.sliceString(pageBodyStart(state))).toBe("====== Garden ======\nbody\n");
    expect(pageBodyStart(stateOf("====== Garden ======\nbo¦dy\n"))).toBe(0);
  });
});

describe("what the folded header says", () => {
  it("is that it is there, and the day the page was made when it says", () => {
    expect(headerLabel(HEADER)).toBe("Page header · created 2026-10-06");
    expect(headerLabel("Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6")).toBe("Page header");
    expect(headerLabel("Content-Type: text/x-zim-wiki\nCreation-Date: soon")).toBe("Page header");
    expect(headerLabel("Creation-Date:2024-02-29T00:00:00+01:00")).toBe("Page header · created 2024-02-29");
  });

  it("is redrawn only when the header is another", () => {
    expect(new HeaderWidget(HEADER).eq(new HeaderWidget(HEADER))).toBe(true);
    expect(new HeaderWidget(HEADER).eq(new HeaderWidget(HEADER.replace("06T", "07T")))).toBe(false);
  });
});
