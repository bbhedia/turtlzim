// What the link completion does with a long answer.
import { readFileSync } from "node:fs";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { linkSource, zimExtensions } from "../src/editor";
import { stateOf } from "./helpers/marked";
import type { LinkSuggestion } from "../src/notebook-core";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("where a link may be typed", () => {
  const offer = (marked: string) => {
    const state = stateOf(marked);
    return linkSource(() => [{ page: "Garden", link: "Garden", exists: true }])(new CompletionContext(state, state.selection.main.head, false));
  };

  it("is right after a span of code that ends there, and not in it", () => {
    expect(offer("\'\'code\'\'[[Gar¦")).not.toBeNull();
    expect(offer("\'\'co[[Gar¦de\'\'")).toBeNull();
  });

  it("is not in a block of code that is not closed, which runs to the end of the page, and is in the text after one that is", () => {
    expect(offer("\'\'\'\nfoo [[Gar¦")).toBeNull();
    expect(offer("\'\'\'\nfoo\n\'\'\'\n[[Gar¦")).not.toBeNull();
  });
});

describe("a long answer", () => {
  it("is cut to twenty, the first twenty, in the order it came", () => {
    const many: LinkSuggestion[] = Array.from({ length: 30 }, (_, i) => ({ page: `Page ${String(i).padStart(2, "0")}`, link: `Page ${i}`, exists: true }));
    const state = EditorState.create({ doc: "[[pa", selection: EditorSelection.cursor(4), extensions: [zimExtensions()] });
    const result = linkSource(() => many)(new CompletionContext(state, 4, false));
    const options = (result as Exclude<typeof result, Promise<unknown>>)?.options ?? [];
    expect(options).toHaveLength(20);
    expect(options[0]!.label).toBe("Page 00");
    expect(options[19]!.label).toBe("Page 19");
  });
});
