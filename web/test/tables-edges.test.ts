// The edges of editing in a table: a row with fewer cells than the table has, and a selection that is not one caret in one table.
import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { StateCommand } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { redo, undo } from "@codemirror/commands";
import { zimExtensions } from "../src/editor";
import { addRowBelow, deleteRow, enterTableDown, enterTableUp, goToCell, insertTable, nextCell, previousCell, tableAt, tableEnter, tableLineBreak, tidyTable } from "../src/editor/table-commands";
import { initZimSync } from "../src/zim";
import { runMarked, stateOf } from "./helpers/marked";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("a row with fewer cells than the table has", () => {
  it("is made whole when Tab goes to a cell that it does not have, and the caret is in that cell", () => {
    // (the header has three cells and this row two: the end of the row is after its last pipe, no place for a letter)
    expect(runMarked(nextCell, "| a | b | c |\n| d | e¦ |")).toBe("| a   | b   | c   |\n| d   | e   | ¦    |");
    // Shift-Tab from the row below goes back into the row above, whose third cell is made in the same way
    expect(runMarked(previousCell, "| a | b | c |\n| d | e |\n| f¦ | g | h |")).toBe("| a   | b   | c   |\n| d   | e   | ¦    |\n| f   | g   | h   |");
    // Enter goes down the column into a row that is short there
    expect(runMarked(tableEnter, "| a | b | c |\n| d | e | f¦ |\n| g | h |")).toBe("| a   | b   | c   |\n| d   | e   | f   |\n| g   | h   | ¦    |");
  });

  it("is a table still when something is typed in the cell that was made", () => {
    for (const [command, marked] of [
      [nextCell, "| a | b | c |\n| d | e¦ |"],
      [nextCell, "| a | b | c | d |\n| 1¦ |\n| x | y | z | w |"],
      [previousCell, "| a | b | c |\n| d | e |\n| f¦ | g | h |"],
      [tableEnter, "| a | b | c |\n| d | e | f¦ |\n| g | h |"],
    ] as const) {
      let state = stateOf(marked);
      command({ state, dispatch: (tr) => void (state = tr.state) });
      state = state.update({ changes: { from: state.selection.main.head, insert: "Q" } }).state;
      const here = tableAt(state);
      expect(here, marked).not.toBeNull();
      expect(here!.layout.rows.flatMap((r) => r.cells.map((c) => c.text)), marked).toContain("Q");
      expect(here!.layout.rows.every((r) => r.cells.length === here!.layout.columns), marked).toBe(true);
    }
  });

  it("is made whole by a click in a cell that it does not have, with the caret at the end of what the cell says", () => {
    const state = stateOf("¦| a | b | c |\n| d | e |");
    const here = tableAt(state, 0)!;
    const click = (row: number, column: number): string => {
      const next = state.update(goToCell(here, row, column, "select.pointer", true)).state;
      expect(next.selection.main.empty).toBe(true);
      const head = next.selection.main.head;
      return next.doc.sliceString(0, head) + "¦" + next.doc.sliceString(head);
    };
    // a cell that the row has: the caret goes to the end of what it says, and nothing is rewritten
    expect(click(1, 1)).toBe("| a | b | c |\n| d | e¦ |");
    expect(click(0, 2)).toBe("| a | b | c¦ |\n| d | e |");
    // one that it does not have: made, empty, and the caret in it
    expect(click(1, 2)).toBe("| a   | b   | c   |\n| d   | e   | ¦    |");
  });
});

describe("an edit of a table with a range of text selected in it", () => {
  // CodeMirror maps the selection through a change, for undo and redo. A range that lies inside a stretch that is replaced
  // (a table's edits replace its whole block) came out with its end before its start: the page was selected backwards.
  const ordered = (state: EditorState): boolean => state.selection.ranges.every((r) => r.from <= r.to && r.to <= state.doc.length);

  it("leaves a selection that is in order through an undo and a redo, and the next undo and redo", () => {
    for (const [command, marked] of [
      [nextCell, "| a | b |\n| 1 | ⟨2⟩ |"], // Tab in the last cell: a row is added
      [addRowBelow, "| a | b |\n| 1 | ⟨2⟩ |"],
      [deleteRow, "| a | b |\n| 1 | 2 |\n| 3 | ⟨4⟩ |"],
      [tidyTable, "| a | b |\n| 1 | ⟨2222⟩ |"],
    ] as const) {
      let state = stateOf(marked);
      const before = state.doc.toString();
      command({ state, dispatch: (tr) => void (state = tr.state) });
      const after = state.doc.toString();
      expect(after, marked).not.toBe(before);
      const seen: Array<[string, string]> = [];
      for (const [name, step] of [["undo", undo], ["redo", redo], ["undo", undo], ["redo", redo]] as const) {
        step({ state, dispatch: (tr) => void (state = tr.state) });
        const { anchor, head } = state.selection.main;
        expect(ordered(state), `${marked}: after ${name} the selection is ${anchor}-${head}`).toBe(true);
        seen.push([name, state.doc.toString()]);
      }
      // undo goes back to the text before and redo to the text after, whatever became of the selection
      expect(seen, marked).toEqual([["undo", before], ["redo", after], ["undo", before], ["redo", after]]);
      // and a key typed there is typed (a selection that was backwards made the change throw)
      expect(() => state.update(state.replaceSelection("x")), marked).not.toThrow();
    }
  });
});

describe("a line break in a cell, after backslashes", () => {
  const cellText = (marked: string): string | undefined => {
    let state = stateOf(marked);
    tableLineBreak({ state, dispatch: (tr) => void (state = tr.state) });
    return tableAt(state)?.layout.rows[0]?.cells[0]?.text;
  };

  it("is a line break at the end of the cell, whatever backslashes come before it", () => {
    // (the cell reads as it did, with a line break after it: a run of backslashes can take the break's own for its partner)
    for (let backslashes = 0; backslashes <= 6; backslashes++) {
      const marked = `| a${"\\".repeat(backslashes)}¦ | b |\n| 1 | 2 |`;
      const before = tableAt(stateOf(marked))!.layout.rows[0]!.cells[0]!.text;
      expect(cellText(marked), `${backslashes} backslashes`).toBe(`${before}\n`);
    }
  });

  it("is a line break in the middle of a cell too, and takes the place of what is selected", () => {
    expect(cellText("| ab¦cd | b |\n| 1 | 2 |")).toBe("ab\ncd");
    expect(cellText("| a\\¦bc | b |\n| 1 | 2 |")).toBe("a\\\nbc");
    expect(cellText("| a⟨bc⟩d | b |\n| 1 | 2 |")).toBe("a\nd");
  });
});

describe("a new table, with the caret in a block that is not text of the page", () => {
  it("goes below the block, not into it: verbatim text, an object, and a table that is not read as one", () => {
    for (const [marked, block] of [
      ["'''\nco¦de\n'''\nafter\n", "'''\ncode\n'''"],
      ['{{{code: lang="python"\nco¦de\n}}}\nafter\n', '{{{code: lang="python"\ncode\n}}}'],
      ["| a¦ | b |\n|---|---|\nafter\n", "| a | b |\n|---|---|"],
    ] as const) {
      const text = runMarked(insertTable(2, 1), marked)!.replace(/[¦⟨⟩]/g, "");
      expect(text.startsWith(`${block}\n\n| Header 1 | Header 2 |`), marked).toBe(true);
      expect(text.endsWith("\n\nafter\n"), marked).toBe(true);
    }
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
