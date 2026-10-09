// The edges of editing in a table: a row with fewer cells than the table has, and a selection that is not one caret in one table.
import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { StateCommand } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { zimExtensions } from "../src/editor";
import { addRowBelow, enterTableDown, enterTableUp, nextCell, previousCell, tableEnter, tableLineBreak } from "../src/editor/table-commands";
import { initZimSync } from "../src/zim";
import { runMarked } from "./helpers/marked";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("a row with fewer cells than the table has", () => {
  it("has the caret at its end when Tab goes to a cell that it does not have", () => {
    // (the header has three cells and this row two: the third is not written yet, and its place is the end of the line)
    expect(runMarked(nextCell, "| a | b | c |\n| d | e¦ |")).toBe("| a | b | c |\n| d | e |¦");
    // and Shift-Tab from the row below goes back into the cells it has
    expect(runMarked(previousCell, "| a | b | c |\n| d | e |\n| f¦ | g | h |")).toBe("| a | b | c |\n| d | e |¦\n| f | g | h |");
  });
});

describe("a selection that is not one caret in one table", () => {
  const doc = "| a | b |\n| c | d |\n\nplain";
  const stateWith = (selection: EditorSelection): EditorState => EditorState.create({ doc, selection, extensions: [zimExtensions(), EditorState.allowMultipleSelections.of(true)] });
  const handled = (command: StateCommand, state: EditorState): boolean => command({ state, dispatch: () => undefined });

  it("is nothing for the commands of a table: several carets", () => {
    const state = stateWith(EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(doc.length)]));
    for (const command of [addRowBelow, nextCell, previousCell, tableEnter, tableLineBreak]) expect(handled(command, state)).toBe(false);
  });

  it("is nothing for them when the selection goes beyond the table, whichever end the caret is at", () => {
    for (const selection of [EditorSelection.single(doc.length, 3), EditorSelection.single(3, doc.length), EditorSelection.single(0, doc.length)]) {
      for (const command of [addRowBelow, nextCell, tableEnter, tableLineBreak]) expect(handled(command, stateWith(selection))).toBe(false);
    }
  });

  it("is theirs when it is inside the table, a caret or a selection of text", () => {
    for (const selection of [EditorSelection.single(3), EditorSelection.single(2, 5), EditorSelection.single(0, 9)]) {
      expect(handled(addRowBelow, stateWith(selection))).toBe(true);
    }
  });
});

describe("an arrow into a table that is drawn as a grid", () => {
  it("goes from the line above to the first cell of its first row", () => {
    expect(runMarked(enterTableDown, "above\n¦\n| a | b |\n| c | d |\n\nbelow")).toBe("above\n\n| a¦ | b |\n| c | d |\n\nbelow");
    // from anywhere in a line that the table follows at once
    expect(runMarked(enterTableDown, "ab¦ove\n| a | b |\n| c | d |")).toBe("above\n| a¦ | b |\n| c | d |");
  });

  it("goes from the line below to the first cell of its last row", () => {
    expect(runMarked(enterTableUp, "above\n\n| a | b |\n| c | d |\n| e | f |\n¦\nbelow")).toBe("above\n\n| a | b |\n| c | d |\n| e¦ | f |\n\nbelow");
    expect(runMarked(enterTableUp, "| a | b |\n| c | d |\nbe¦low")).toBe("| a | b |\n| c¦ | d |\nbelow");
  });

  it("is not for a line that is not beside a table, a selection, the top and the bottom of the page, or a caret already in a table", () => {
    expect(runMarked(enterTableDown, "ab¦ove\n\n| a | b |\n| c | d |")).toBeNull();
    expect(runMarked(enterTableUp, "| a | b |\n| c | d |\n\nbe¦low")).toBeNull();
    expect(runMarked(enterTableDown, "⟨ab⟩ove\n| a | b |\n| c | d |")).toBeNull();
    expect(runMarked(enterTableDown, "| a | b |\n| c | d |\nlast¦")).toBeNull();
    expect(runMarked(enterTableUp, "fi¦rst\n| a | b |\n| c | d |")).toBeNull();
    expect(runMarked(enterTableDown, "| a¦ | b |\n| c | d |")).toBeNull();
    expect(runMarked(enterTableUp, "| a | b |\n| c¦ | d |")).toBeNull();
    // (and not a block of lines that is not a table: a header with nothing below it)
    expect(runMarked(enterTableDown, "ab¦ove\n| a | b |\n|---|---|")).toBeNull();
  });

  it("chooses the table that is on the side that the arrow goes, when two are a line apart", () => {
    const two = "| a | b |\n| c | d |\n¦\n| e | f |\n| g | h |";
    expect(runMarked(enterTableDown, two)).toBe("| a | b |\n| c | d |\n\n| e¦ | f |\n| g | h |");
    expect(runMarked(enterTableUp, two)).toBe("| a | b |\n| c¦ | d |\n\n| e | f |\n| g | h |");
  });
});
