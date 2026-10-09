// Tables in the editor: where the caret is in one, each edit (what the text becomes, and where the caret goes), the
// keys, a new table, and how a table is drawn (a grid while the caret is elsewhere, its text and a toolbar while it is in it).
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { decorationsField, setShowMarkup } from "../src/editor";
import { addColumnRight, addRowBelow, alignColumn, deleteColumn, deleteRow, focusToolbar, insertTable, nextCell, previousCell, tableAt, tableEnter, tableLineBreak, tidyTable } from "../src/editor/table-commands";
import { TableToolbar, TableWidget } from "../src/editor/table-widget";
import { zimKeymap } from "../src/editor/keymap";
import { tableLayout } from "../src/table";
import { initZimSync } from "../src/zim";
import { runMarked, stateOf } from "./helpers/marked";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

/** A page with a table in it (two columns, the header and two rows), the caret where `at` says. */
const page = (inside: string): string => `intro\n\n${inside}\n\nafter\n`;
const T = ["| Name | Count |", "|:-----|------:|", "| apple | 3 |", "| pear | 12 |"].join("\n");

describe("where the caret is in a table", () => {
  const here = (marked: string) => {
    const found = tableAt(stateOf(marked));
    return found ? { row: found.row, column: found.column } : null;
  };

  it("is a row and a column, by the cell the caret is in", () => {
    expect(here(page("| ¦Name | Count |\n|:-----|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 0 });
    expect(here(page("| Name | Co¦unt |\n|:-----|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 1 });
    expect(here(page("| Name | Count |\n|:-----|------:|\n| ap¦ple | 3 |"))).toEqual({ row: 1, column: 0 });
    expect(here(page("| Name | Count |\n|:-----|------:|\n| apple | 3¦ |"))).toEqual({ row: 1, column: 1 });
    // a caret just before a pipe is in the cell before it, just after one in the cell after it, and at the start of a line in the first
    expect(here(page("| Name ¦| Count |\n|:-----|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 0 });
    expect(here(page("| Name |¦ Count |\n|:-----|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 1 });
    expect(here(page("¦| Name | Count |\n|:-----|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 0 });
    // the alignment row counts as the header's, and its columns are found by its pipes
    expect(here(page("| Name | Count |\n|:---¦--|------:|\n| apple | 3 |"))).toEqual({ row: 0, column: 0 });
    expect(here(page("| Name | Count |\n|:-----|---¦---:|\n| apple | 3 |"))).toEqual({ row: 0, column: 1 });
  });

  it("is nowhere outside a table, or in what is not one", () => {
    expect(here("intro¦\n\n| a | b |\n| c | d |\n")).toBeNull();
    expect(here("intro\n\n| a | b |\n| c | d |\n\naf¦ter\n")).toBeNull();
    // (a header with nothing below it, a table that is one row, and a table in a list item)
    expect(here("| a | b |\n|---|---|¦\n")).toBeNull();
    expect(here("| a | b |¦\n")).toBeNull();
    expect(here("* | a | b |¦ \n")).toBeNull();
  });

  it("goes with the block: where it starts and ends", () => {
    const state = stateOf(page(`| Name | Count |\n| ap¦ple | 3 |`));
    const found = tableAt(state)!;
    expect(state.sliceDoc(found.from, found.to)).toBe("| Name | Count |\n| apple | 3 |");
    expect(found.text).toBe("| Name | Count |\n| apple | 3 |");
    expect(found.layout.columns).toBe(2);
  });
});

describe("what a table can be asked", () => {
  it("adds a row below the caret's, and the caret goes into its cell in the same column", () => {
    expect(runMarked(addRowBelow, page("| a | b |\n| c¦ | d |\n| e | f |"))).toBe(page("| a   | b   |\n| c   | d   |\n| ¦    |     |\n| e   | f   |"));
    expect(runMarked(addRowBelow, page("| a | b¦ |\n| c | d |"))).toBe(page("| a   | b   |\n|     | ¦    |\n| c   | d   |"));
    // from the header it is the first row; from the alignment row too
    expect(runMarked(addRowBelow, page("| ¦a | b |\n| c | d |"))).toBe(page("| a   | b   |\n| ¦    |     |\n| c   | d   |"));
    expect(runMarked(addRowBelow, page("| a | b |\n|--¦-|---|\n| c | d |"))).toBe(page("| a   | b   |\n|-----|-----|\n| ¦    |     |\n| c   | d   |"));
  });

  it("deletes the caret's row, but not the header or the only row below it", () => {
    expect(runMarked(deleteRow, page("| a | b |\n| c | d |\n| e¦ | f |"))).toBe(page("| a   | b   |\n| ⟨c⟩   | d   |"));
    expect(runMarked(deleteRow, page("| a | b |\n| c¦ | d |\n| e | f |"))).toBe(page("| a   | b   |\n| ⟨e⟩   | f   |"));
    expect(runMarked(deleteRow, page("| ¦a | b |\n| c | d |\n| e | f |"))).toBeNull();
    expect(runMarked(deleteRow, page("| a | b |\n| c¦ | d |"))).toBeNull();
  });

  it("adds a column after the caret's, with a header of its own, and the caret goes into the new cell of its row", () => {
    expect(runMarked(addColumnRight, page("| a | b |\n| c | d |¦"))).toBe(page("| a   | b   | Header 3 |\n| c   | d   | ¦         |"));
    expect(runMarked(addColumnRight, page("| a¦ | b |\n| c | d |"))).toBe(page("| a   | ⟨Header 2⟩ | b   |\n| c   |          | d   |"));
  });

  it("deletes the caret's column, but not the only one", () => {
    expect(runMarked(deleteColumn, page("| a | b | c |\n| d | e¦ | f |"))).toBe(page("| a   | c   |\n| d   | ⟨f⟩   |"));
    expect(runMarked(deleteColumn, page("| a¦ |\n| d |"))).toBeNull();
  });

  it("aligns the caret's column, and writes the alignment row", () => {
    expect(runMarked(alignColumn("right"), page("| a | b¦ |\n| c | d |"))).toBe(page("| a   |   ⟨b⟩ |\n|-----|----:|\n| c   |   d |"));
    expect(runMarked(alignColumn("center"), page("| ¦abc | b |\n| c | d |"))).toBe(page("| ⟨abc⟩ | b   |\n|:---:|-----|\n|  c  | d   |"));
    expect(runMarked(alignColumn("left"), page("| ¦a | b |\n| c | d |"))).toBe(page("| ⟨a⟩   | b   |\n|:----|-----|\n| c   | d   |"));
    // back to as it comes: the alignment row stays, with nothing to say
    expect(runMarked(alignColumn("normal"), page("| a | b |\n|:--|---|\n| c¦ | d |"))).toBe(page("| a   | b   |\n|-----|-----|\n| ⟨c⟩   | d   |"));
  });

  it("writes the table with its columns lined up, and does nothing more to one that already is", () => {
    const tidy = runMarked(tidyTable, page("|a|b|\n|c¦ccc|d|"));
    expect(tidy).toBe(page("| a    | b   |\n| ⟨cccc⟩ | d   |"));
    const again = runMarked(tidyTable, tidy!.replace("⟨", "").replace("⟩", "¦"));
    expect(again!.replace(/[⟨⟩¦]/g, "")).toBe(tidy!.replace(/[⟨⟩¦]/g, ""));
  });

  it("is not done in a page that can't be changed, with a selection that goes beyond the table, or outside one", () => {
    expect(runMarked(addRowBelow, page("| a | b |\n| c¦ | d |"), [EditorState.readOnly.of(true)])).toBeNull();
    expect(runMarked(addRowBelow, page("| a | b |\n| ⟨c | d |\n\nafter⟩"))).toBeNull();
    expect(runMarked(addRowBelow, "plain ¦text")).toBeNull();
  });
});

describe("moving in a table", () => {
  it("goes on to the next cell with Tab, with what is in it selected, a row at a time", () => {
    const t = (caret: string) => page(`| ${caret === "h1" ? "¦" : ""}one | two |\n| three | four |`);
    expect(runMarked(nextCell, page("| o¦ne | two |\n| three | four |"))).toBe(page("| one | ⟨two⟩ |\n| three | four |"));
    expect(runMarked(nextCell, page("| one | t¦wo |\n| three | four |"))).toBe(page("| one | two |\n| ⟨three⟩ | four |"));
    expect(runMarked(nextCell, page("| one | two |\n| ⟨three⟩ | four |"))).toBe(page("| one | two |\n| three | ⟨four⟩ |"));
    expect(t("h1")).toContain("¦one");
  });

  it("makes a row of its own after the last cell, and puts the caret in its first cell", () => {
    expect(runMarked(nextCell, page("| one | two |\n| three | fo¦ur |"))).toBe(page("| one   | two  |\n| three | four |\n| ¦      |      |"));
  });

  it("goes back with Shift-Tab, and stays in the first cell instead of leaving the table", () => {
    expect(runMarked(previousCell, page("| one | tw¦o |\n| three | four |"))).toBe(page("| ⟨one⟩ | two |\n| three | four |"));
    expect(runMarked(previousCell, page("| one | two |\n| th¦ree | four |"))).toBe(page("| one | ⟨two⟩ |\n| three | four |"));
    expect(runMarked(previousCell, page("| o¦ne | two |\n| three | four |"))).toBe(page("| o¦ne | two |\n| three | four |"));
  });

  it("lands in an empty cell inside its padding, ready to type", () => {
    expect(runMarked(nextCell, page("| a¦ | b |\n|     |     |"))).toBe(page("| a | ⟨b⟩ |\n|     |     |"));
    expect(runMarked(nextCell, page("| a | b¦ |\n|     |     |"))).toBe(page("| a | b |\n| ¦    |     |"));
  });

  it("leaves the keys alone outside a table, and in a page that can't be changed", () => {
    expect(runMarked(nextCell, "plain ¦text")).toBeNull();
    expect(runMarked(previousCell, "plain ¦text")).toBeNull();
    expect(runMarked(tableEnter, "plain ¦text")).toBeNull();
    expect(runMarked(tableLineBreak, "plain ¦text")).toBeNull();
    expect(runMarked(nextCell, page("| o¦ne | two |\n| three | four |"), [EditorState.readOnly.of(true)])).toBeNull();
  });

  it("is a binding that comes before the list's: Tab is the table's in a table and the page's elsewhere", () => {
    const tab = zimKeymap.filter((binding) => binding.key === "Tab").map((binding) => binding.run!);
    expect(tab.length).toBeGreaterThanOrEqual(2);
    const first = (marked: string): string | null => {
      for (const run of tab) {
        const found = runMarked(({ state, dispatch }) => run({ state, dispatch } as never), marked);
        if (found !== null) return found;
      }
      return null;
    };
    expect(first(page("| o¦ne | two |\n| three | four |"))).toBe(page("| one | ⟨two⟩ |\n| three | four |"));
    expect(first("plain ¦text")).toBe("plain \t¦text");
  });
});

describe("Enter in a table", () => {
  it("goes down to the cell below, whatever is selected", () => {
    expect(runMarked(tableEnter, page("| o¦ne | two |\n| three | four |"))).toBe(page("| one | two |\n| ⟨three⟩ | four |"));
    expect(runMarked(tableEnter, page("| one | t¦wo |\n| three | four |\n| five | six |"))).toBe(page("| one | two |\n| three | ⟨four⟩ |\n| five | six |"));
  });

  it("makes a row below the last when it has something in it, and goes to the cell below in it as in any other row", () => {
    expect(runMarked(tableEnter, page("| one | two |\n| three | fo¦ur |"))).toBe(page("| one   | two  |\n| three | four |\n|       | ¦     |"));
  });

  it("ends the table on an empty last row: the row goes, and the caret is on the line after the table", () => {
    // (the table has a row below its header that stays)
    expect(runMarked(tableEnter, "| a | b |\n| c | d |\n|   |   ¦|\n\nafter\n")).toBe("| a   | b   |\n| c   | d   |\n¦\n\nafter\n");
    // (what follows is as it was, even text that comes straight after the table)
    expect(runMarked(tableEnter, "| a | b |\n| c | d |\n|   |   ¦|\nafter\n")).toBe("| a   | b   |\n| c   | d   |\n¦\nafter\n");
  });

  it("ends the table at the end of the page with a line of its own to go on in", () => {
    expect(runMarked(tableEnter, "| a | b |\n| c | d |\n| ¦ |   |")).toBe("| a   | b   |\n| c   | d   |\n¦");
  });

  it("does not take the only row away", () => {
    expect(runMarked(tableEnter, "text\n\n| a | b |\n|   |  ¦ |\n\nafter\n")).toBe("text\n\n| a | b |\n|   |   |\n¦\n\nafter\n");
  });
});

describe("a line break in a cell", () => {
  it("is the two characters a table holds it as", () => {
    expect(runMarked(tableLineBreak, page("| one¦ | two |\n| three | four |"))).toBe(page("| one\\n¦ | two |\n| three | four |"));
    // (and the grid reads it back as a line break)
    const layout = tableLayout("| one\\ntwo | b |\n| c | d |")!;
    expect(layout.rows[0]!.cells[0]!.text).toBe("one\ntwo");
  });
});

describe("a new table", () => {
  /** Insert a table in `marked` and show the result; the table's header and rows, as the text says. */
  const inserted = (marked: string) => {
    let state = stateOf(marked);
    insertTable()({ state, dispatch: (tr) => (state = tr.state) });
    const doc = state.doc.toString();
    return { doc, selected: state.sliceDoc(state.selection.main.from, state.selection.main.to), state };
  };
  const TABLE = "| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n|          |          |          |\n|          |          |          |";

  it("is a block of its own below the line the caret is on, with an empty line between, and the first header selected", () => {
    const { doc, selected, state } = inserted("first\n\nsecond line¦\n\nlast\n");
    expect(doc).toBe(`first\n\nsecond line\n\n${TABLE}\n\nlast\n`);
    expect(selected).toBe("Header 1");
    // it is a table: the first one in the page
    expect(tableAt(state)).toMatchObject({ row: 0, column: 0 });
  });

  it("goes where the caret is when that is an empty line, with an empty line each side of it", () => {
    expect(inserted("first\n¦\nlast\n").doc).toBe(`first\n\n${TABLE}\n\nlast\n`);
    expect(inserted("first\n\n¦\nlast\n").doc).toBe(`first\n\n${TABLE}\n\nlast\n`);
    // (on a line with text it goes below that line, not in the middle of it)
    expect(inserted("first\n\n¦last\n").doc).toBe(`first\n\nlast\n\n${TABLE}\n`);
    expect(inserted("first\n\nlast¦").doc).toBe(`first\n\nlast\n\n${TABLE}\n`);
    expect(inserted("first¦\nnext\n").doc).toBe(`first\n\n${TABLE}\n\nnext\n`);
    expect(inserted("¦").doc).toBe(`${TABLE}\n`);
    expect(inserted("text\n¦").doc).toBe(`text\n\n${TABLE}\n`);
  });

  it("goes at the end of the page, not in its header, when the caret is in the header", () => {
    const header = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-09T08:15:00+02:00\n\n====== Page ======\ntext\n";
    const { doc, selected } = inserted(`Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCrea¦tion-Date: 2026-10-09T08:15:00+02:00\n\n====== Page ======\ntext\n`);
    expect(doc.startsWith(header)).toBe(true);
    expect(doc.slice(header.length)).toContain("| Header 1");
    expect(selected).toBe("Header 1");
  });

  it("goes below the table that the caret is in, and not in the middle of it", () => {
    expect(inserted("| a | b |\n| c¦ | d |\n| e | f |\n\nnext").doc).toBe(`| a | b |\n| c | d |\n| e | f |\n\n${TABLE}\n\nnext`);
    expect(inserted("| a | b |\n| c | d |\n| e | f |¦").doc).toBe(`| a | b |\n| c | d |\n| e | f |\n\n${TABLE}\n`);
  });

  it("is made again to be a table by the reader that reads it (what was written is a table)", () => {
    const { state } = inserted("first¦");
    const here = tableAt(state)!;
    expect(here.layout.columns).toBe(3);
    expect(here.layout.rows).toHaveLength(3);
    expect(here.layout.alignLine).toBe(1);
  });

  it("is not made in a page that can't be changed", () => {
    expect(runMarked(insertTable(), "text¦", [EditorState.readOnly.of(true)])).toBeNull();
  });
});

describe("how a table is drawn", () => {
  interface Drawn {
    from: number;
    to: number;
    cls: string;
    widget?: string;
    block: boolean;
    value: { spec: { widget?: unknown } };
  }
  const draw = (marked: string, options: { markup?: boolean; readOnly?: boolean } = {}) => {
    const state = stateOf(marked, [...(options.readOnly ? [EditorState.readOnly.of(true)] : [])]);
    // (the decorations are those of the state's own field: `showMarkup` is a state field of the editor)
    const shown = options.markup ? state.update({ effects: setShowMarkup.of(true) }).state : state;
    const found: Drawn[] = [];
    shown.field(decorationsField).all.between(0, shown.doc.length, (from, to, value) => {
      const spec = value.spec as { class?: string; widget?: { constructor: { name: string } }; block?: boolean };
      found.push({ from, to, cls: spec.class ?? "", ...(spec.widget ? { widget: spec.widget.constructor.name } : {}), block: !!spec.block, value });
    });
    return { state: shown, found, grids: found.filter((d) => d.widget === "TableWidget"), bars: found.filter((d) => d.widget === "TableToolbar"), lines: found.filter((d) => d.cls.includes("cm-zim-table")) };
  };
  const rows = "| Name | Count |\n|:-----|------:|\n| apple | 3 |\n| pear | 12 |";

  it("is a grid, in place of its lines, while the caret is elsewhere", () => {
    const { state, grids, bars, lines } = draw(`intro\n\n${rows}\n\naf¦ter\n`);
    expect(grids).toHaveLength(1);
    expect(grids[0]).toMatchObject({ block: true });
    expect(state.sliceDoc(grids[0]!.from, grids[0]!.to)).toBe(rows);
    expect((grids[0]!.value.spec.widget as TableWidget).text).toBe(rows);
    // nothing of its text is drawn as lines, and there is no toolbar
    expect(lines).toHaveLength(0);
    expect(bars).toHaveLength(0);
  });

  it("is its text, line by line, with a toolbar over it, while the caret is in it, on its first or last character too", () => {
    for (const marked of [`intro\n\n${rows.replace("apple", "ap¦ple")}\n\nafter\n`, `intro\n\n¦${rows}\n\nafter\n`, `intro\n\n${rows}¦\n\nafter\n`]) {
      const { state, grids, bars, lines } = draw(marked);
      expect(grids, marked).toHaveLength(0);
      expect(lines, marked).toHaveLength(4);
      expect(bars, marked).toHaveLength(1);
      // the toolbar is a block of its own over the first line
      expect(bars[0]).toMatchObject({ block: true, from: state.doc.toString().indexOf("| Name"), to: state.doc.toString().indexOf("| Name") });
    }
  });

  it("is its text, whatever the caret, when the markup is shown, and has a toolbar only if the caret is in it", () => {
    const outside = draw(`intro\n\n${rows}\n\naf¦ter\n`, { markup: true });
    expect(outside.grids).toHaveLength(0);
    expect(outside.lines).toHaveLength(4);
    expect(outside.bars).toHaveLength(0);
    expect(draw(`intro\n\n${rows.replace("pear", "pe¦ar")}\n`, { markup: true }).bars).toHaveLength(1);
  });

  it("is a grid for each table, and the one with the caret in it is text", () => {
    const { grids, bars, lines } = draw(`${rows}\n\ntext\n\n| x | y |\n| z¦ | w |\n`);
    expect(grids).toHaveLength(1);
    expect(grids[0]!.from).toBe(0);
    expect(lines).toHaveLength(2);
    expect(bars).toHaveLength(1);
  });

  it("stays lines when it is not a table: a header with nothing below it, a single line, a row in a list", () => {
    for (const marked of ["| a | b |\n|---|---|\n\ntext¦\n", "| a | b |\n\ntext¦\n", "text\n\n| a | b |\n| x | y |\n\n\t| indented | table |\n\nmore¦\n".replace("| x | y |\n", "")]) {
      const { grids, bars, lines } = draw(marked);
      expect(grids, marked).toHaveLength(0);
      expect(bars, marked).toHaveLength(0);
      expect(lines.length, marked).toBeGreaterThan(0);
    }
  });

  it("has no toolbar in a page that can't be changed, but is a grid or the text all the same", () => {
    expect(draw(`intro\n\n${rows}\n\naf¦ter\n`, { readOnly: true }).grids).toHaveLength(1);
    const inside = draw(`intro\n\n${rows.replace("apple", "ap¦ple")}\n`, { readOnly: true });
    expect(inside.grids).toHaveLength(0);
    expect(inside.lines).toHaveLength(4);
    expect(inside.bars).toHaveLength(0);
  });

  it("shows text when the selection covers the table, as when it touches any construct", () => {
    expect(draw(`⟨intro\n\n${rows}\n\nafter⟩\n`).grids).toHaveLength(0);
  });

  it("tells the toolbar what the caret's place allows", () => {
    const flags = (marked: string) => (draw(marked).bars[0]!.value.spec.widget as TableToolbar).state;
    expect(flags(`| Na¦me | Count |\n|:-----|------:|\n| apple | 3 |\n| pear | 12 |`)).toEqual({ canDeleteRow: false, canDeleteColumn: true, align: "left" });
    expect(flags(`| Name | Count |\n|:-----|------:|\n| apple | 3 |\n| pe¦ar | 12 |`)).toEqual({ canDeleteRow: true, canDeleteColumn: true, align: "left" });
    expect(flags(`| Name | Count |\n|:-----|------:|\n| apple | 3 |\n| pear | 1¦2 |`)).toEqual({ canDeleteRow: true, canDeleteColumn: true, align: "right" });
    // the only row below the header can't go, nor the only column
    expect(flags(`| Name | Count |\n| apple¦ | 3 |`)).toEqual({ canDeleteRow: false, canDeleteColumn: true, align: "normal" });
    expect(flags(`| Name |\n| ap¦ple |\n| pear |`)).toEqual({ canDeleteRow: true, canDeleteColumn: false, align: "normal" });
  });

  it("is the same grid for the same text, and another for any other (so a drawn one is kept as long as it is right)", () => {
    expect(new TableWidget(rows).eq(new TableWidget(rows))).toBe(true);
    expect(new TableWidget(rows).eq(new TableWidget(rows.replace("pear", "plum")))).toBe(false);
    const bar = (extra: object = {}) => new TableToolbar({ canDeleteRow: true, canDeleteColumn: true, align: "normal", ...extra });
    expect(bar().eq(bar())).toBe(true);
    for (const different of [{ canDeleteRow: false }, { canDeleteColumn: false }, { align: "right" }]) expect(bar().eq(bar(different)), JSON.stringify(different)).toBe(false);
    expect(bar().eq(new TableWidget(rows))).toBe(false);
  });

  it("is given the focus key: Alt-F10 is the table's, and needs a table", () => {
    expect(zimKeymap.some((binding) => binding.key === "Alt-F10" && binding.run === (focusToolbar as unknown))).toBe(true);
  });
});
