// Tables in the editor: where the caret is in one, the edits that the toolbar and the keys offer, and a new
// table. A table is the text of its block (see core/zim-format's `table`, which does the reading and every
// edit): an edit here is the block's new text, put in as one change, and the caret put in the cell it belongs.
import { EditorSelection } from "@codemirror/state";
import type { EditorState, SelectionRange, StateCommand, Transaction, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Kind, Opaque } from "../kinds";
import { tableAddColumn, tableAddRow, tableDeleteColumn, tableDeleteRow, tableFormat, tableLayout, tableNew, tableSetAlign } from "../table";
import type { Align, TableCell, TableLayout } from "../table";
import { pageBodyStart } from "./commands";
import { spansOf } from "./syntax";

const CACHED = 64;
const layouts = new Map<string, TableLayout | undefined>();

/** The table in `text` (a block's lines), read once for as long as it is the same text (the decorations ask on every move of the caret). */
export function cachedLayout(text: string): TableLayout | undefined {
  if (layouts.has(text)) {
    const known = layouts.get(text);
    layouts.delete(text);
    layouts.set(text, known);
    return known;
  }
  const layout = tableLayout(text);
  layouts.set(text, layout);
  if (layouts.size > CACHED) layouts.delete(layouts.keys().next().value as string);
  return layout;
}

/** A table that the caret is in. */
export interface TableHere {
  /** The block, from the start of its first line to the end of its last. */
  from: number;
  to: number;
  text: string;
  layout: TableLayout;
  /** The row the caret is on (0 is the header, which the alignment row counts as) and its column. */
  row: number;
  column: number;
}

/** Which row and column of `layout` the offset `offset` into its text is in. */
export function placeIn(layout: TableLayout, text: string, offset: number): { row: number; column: number } {
  const line = text.slice(0, offset).split("\n").length - 1;
  let row = layout.rows.findIndex((r) => r.line === line);
  let column: number;
  if (row >= 0) {
    const cells = layout.rows[row]!.cells;
    column = cells.findIndex((cell) => offset <= cell.end);
    if (column < 0) column = cells.length - 1;
  } else {
    // the alignment row: by its pipes
    row = 0;
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    column = Math.max(0, text.slice(lineStart, offset).split("|").length - 2);
  }
  return { row, column: Math.max(0, Math.min(column, layout.columns - 1)) };
}

/** The table that `pos` is in (the caret, by default), if it is in one that can be read as a table. */
export function tableAt(state: EditorState, pos: number = state.selection.main.head): TableHere | null {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= pos; i++) {
    if (spans.kind(i) !== Kind.Opaque || spans.detail(i) !== Opaque.TABLE || spans.end(i) < pos) continue;
    const from = spans.start(i);
    const text = state.sliceDoc(from, spans.end(i));
    const layout = cachedLayout(text);
    return layout ? { from, to: spans.end(i), text, layout, ...placeIn(layout, text, pos - from) } : null;
  }
  return null;
}

/** What is in a cell, as a range of the block's text: the text without the spaces round it, or (an empty cell) a caret inside its padding. */
export function cellContent(text: string, cell: TableCell): [number, number] {
  const written = text.slice(cell.start, cell.end);
  if (cell.raw === "") {
    const at = cell.start + Math.min(1, written.length);
    return [at, at];
  }
  const lead = Math.max(0, written.indexOf(cell.raw));
  return [cell.start + lead, cell.start + lead + cell.raw.length];
}

/** The selection that holds the cell (`row`, `column`) of the table `layout` read from `text`, which starts at `from`. */
function inCell(from: number, text: string, layout: TableLayout, row: number, column: number): SelectionRange {
  const line = layout.rows[Math.max(0, Math.min(row, layout.rows.length - 1))]!;
  const cell = line.cells[Math.max(0, Math.min(column, layout.columns - 1))];
  // (a row with fewer cells than the table has no cell here: its end is where one is written)
  if (!cell) return EditorSelection.cursor(from + line.end);
  const [a, b] = cellContent(text, cell);
  return EditorSelection.range(from + a, from + b);
}

/** The block's new text as a change, and the caret in the cell where the person goes on. */
function replaced(here: TableHere, text: string | undefined, row: number, column: number): TransactionSpec | null {
  if (text === undefined) return null;
  const layout = cachedLayout(text);
  if (!layout) return null;
  return {
    changes: text === here.text ? [] : { from: here.from, to: here.to, insert: text },
    selection: EditorSelection.create([inCell(here.from, text, layout, row, column)]),
    scrollIntoView: true,
    userEvent: "input.table",
  };
}

/** The table that the one selection is in: not read-only, and not a selection that goes beyond the table. */
function editable(state: EditorState): TableHere | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const here = tableAt(state);
  const main = state.selection.main;
  return here && main.from >= here.from && main.to <= here.to ? here : null;
}

/**
 * Dispatch `spec`, which may rewrite the table's block. CodeMirror keeps the selection from before a change (undo and redo
 * restore it from there) and maps it through the change; a range of text that lies inside a stretch that is replaced comes
 * out the other side with its end before its start, and the redo would select the page backwards (and the next key typed
 * would fail). A table's edits replace its whole block, and Tab selects what a cell says, so such a selection is made a caret
 * first (a step of its own that adds nothing to the undo history).
 */
function dispatchEdit(state: EditorState, dispatch: (tr: Transaction) => void, spec: TransactionSpec): void {
  const main = state.selection.main;
  const rewrites = spec.changes !== undefined && !(Array.isArray(spec.changes) && spec.changes.length === 0);
  let from = state;
  if (rewrites && !main.empty) {
    const collapsed = state.update({ selection: EditorSelection.cursor(main.head), userEvent: "select" });
    dispatch(collapsed);
    from = collapsed.state;
  }
  dispatch(from.update(spec));
}

const tableCommand =
  (make: (here: TableHere) => TransactionSpec | null): StateCommand =>
  ({ state, dispatch }) => {
    const here = editable(state);
    const spec = here && make(here);
    if (!spec) return false;
    dispatchEdit(state, dispatch, spec);
    return true;
  };

/** A row below the caret's (below the header, if the caret is in it). */
export const addRowBelow = tableCommand((here) => replaced(here, tableAddRow(here.text, here.row), here.row + 1, here.column));

/** The caret's row goes (not the header, and not the only row below it). */
export const deleteRow = tableCommand((here) => replaced(here, tableDeleteRow(here.text, here.row), here.row, here.column));

/** A column after the caret's. */
export const addColumnRight = tableCommand((here) => replaced(here, tableAddColumn(here.text, here.column), here.row, here.column + 1));

/** The caret's column goes (not the only one). */
export const deleteColumn = tableCommand((here) => replaced(here, tableDeleteColumn(here.text, here.column), here.row, here.column));

/** The caret's column is aligned as asked. */
export const alignColumn = (align: Align): StateCommand => tableCommand((here) => replaced(here, tableSetAlign(here.text, here.column, align), here.row, here.column));

/** The table written out again with every column as wide as its widest cell. */
export const tidyTable = tableCommand((here) => replaced(here, tableFormat(here.text), here.row, here.column));

/** Whether the caret's row, and its column, can go: for the toolbar to say so. */
export function whatCanGo(here: TableHere): { row: boolean; column: boolean } {
  return { row: here.row > 0 && here.layout.rows.length > 2, column: here.layout.columns > 1 };
}

/**
 * Where the caret goes to be in the cell (`row`, `column`): in what it says (so that typing replaces it) or, with `caret`,
 * at the end of it. A row can have fewer cells than the table has, and then the text has no such cell: the end of the row
 * is after its last pipe, and a letter typed there would break the row off the table. So the table is written out in full
 * first (every row with all its cells, as any edit of a table writes it) and the caret goes into the cell that this makes.
 */
export function goToCell(here: TableHere, row: number, column: number, userEvent: string, caret = false): TransactionSpec {
  const r = Math.max(0, Math.min(row, here.layout.rows.length - 1));
  const c = Math.max(0, Math.min(column, here.layout.columns - 1));
  let text = here.text;
  let layout = here.layout;
  let changes: TransactionSpec["changes"];
  if (c >= layout.rows[r]!.cells.length) {
    const whole = tableFormat(here.text);
    const read = whole === undefined ? undefined : cachedLayout(whole);
    if (whole !== undefined && read) {
      text = whole;
      layout = read;
      changes = { from: here.from, to: here.to, insert: whole };
    }
  }
  const cell = inCell(here.from, text, layout, r, c);
  return { ...(changes ? { changes, userEvent: "input.table" } : { userEvent }), selection: caret ? EditorSelection.cursor(cell.to) : EditorSelection.create([cell]), scrollIntoView: true };
}

/** A click in a cell of the grid (the table that starts at `from`): the caret goes to the end of what the cell says, and the table is its text from then on. */
export function caretToCell(view: EditorView, from: number, row: number, column: number): boolean {
  const here = tableAt(view.state, from);
  if (!here) return false;
  dispatchEdit(view.state, (tr) => view.dispatch(tr), goToCell(here, row, column, "select.pointer", true));
  return true;
}

/** Tab: on to the next cell, with what is in it selected; after the last cell, to a row of its own. */
export const nextCell: StateCommand = ({ state, dispatch }) => {
  const here = editable(state);
  if (!here) return false;
  let { row, column } = here;
  column += 1;
  if (column >= here.layout.columns) {
    column = 0;
    row += 1;
  }
  const rows = here.layout.rows.length;
  const spec = row >= rows ? replaced(here, tableAddRow(here.text, rows - 1), rows, 0) : goToCell(here, row, column, "select");
  if (!spec) return false;
  dispatchEdit(state, dispatch, spec);
  return true;
};

/** Shift-Tab: back to the cell before (the first cell stays: the key is the table's, not the page's). */
export const previousCell: StateCommand = ({ state, dispatch }) => {
  const here = editable(state);
  if (!here) return false;
  let { row, column } = here;
  column -= 1;
  if (column < 0) {
    column = here.layout.columns - 1;
    row -= 1;
  }
  if (row < 0) return true;
  dispatchEdit(state, dispatch, goToCell(here, row, column, "select"));
  return true;
};

/**
 * Enter: to the cell below. In the last row it makes a row for the next, and on an empty last row it ends the table: the
 * empty row goes (if another is left below the header) and the caret is on a new line after the table.
 */
export const tableEnter: StateCommand = ({ state, dispatch }) => {
  const here = editable(state);
  if (!here) return false;
  const rows = here.layout.rows.length;
  if (here.row < rows - 1) {
    dispatchEdit(state, dispatch, goToCell(here, here.row + 1, here.column, "select"));
    return true;
  }
  const empty = here.layout.rows[here.row]!.cells.every((cell) => cell.raw === "");
  if (!empty) return addRowBelow({ state, dispatch });
  const text = rows > 2 ? (tableDeleteRow(here.text, here.row) ?? here.text) : here.text;
  // (a line of its own after the table, whatever follows it: the spacing there is left as it was)
  dispatchEdit(state, dispatch, {
    changes: text === here.text ? { from: here.to, insert: "\n" } : { from: here.from, to: here.to, insert: `${text}\n` },
    selection: EditorSelection.cursor(here.from + text.length + 1),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
};

/**
 * Shift-Enter: a line break in the cell (written `\n`, as a table holds it). After a backslash that stands for itself (an odd
 * number of them in a row: the last has no partner) the break's own backslash would be taken as that one's partner, and what
 * is written would read as a backslash and an n; so the lone backslash is given a partner first.
 */
export const tableLineBreak: StateCommand = ({ state, dispatch }) => {
  if (!editable(state)) return false;
  const at = state.selection.main.from;
  let run = 0;
  while (run < at && state.sliceDoc(at - run - 1, at - run) === "\\") run++;
  dispatch(state.update({ ...state.replaceSelection(run % 2 === 1 ? "\\\\n" : "\\n"), scrollIntoView: true, userEvent: "input" }));
  return true;
};

/**
 * An arrow into a table from the line beside it: the editor's own arrows go over a table that is drawn as a grid (a
 * block that is not text to move through), so these go in: into the first cell of its first row from above, of
 * its last row from below, and the table is its text from then on. Anywhere else they leave the key alone.
 */
function intoTable(forward: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const main = state.selection.main;
    if (state.selection.ranges.length !== 1 || !main.empty) return false;
    const line = state.doc.lineAt(main.head);
    const beside = forward ? (line.number < state.doc.lines ? state.doc.line(line.number + 1) : null) : line.number > 1 ? state.doc.line(line.number - 1) : null;
    if (!beside) return false;
    const spans = spansOf(state);
    for (let i = 0; i < spans.length && spans.start(i) <= beside.to; i++) {
      if (spans.kind(i) !== Kind.Opaque || spans.detail(i) !== Opaque.TABLE) continue;
      // (the table's first line is the line below the caret's, or its last line is the one above)
      if (forward ? spans.start(i) !== beside.from : spans.end(i) !== beside.to) continue;
      const from = spans.start(i);
      const text = state.sliceDoc(from, spans.end(i));
      const layout = cachedLayout(text);
      if (!layout) return false;
      const first = inCell(from, text, layout, forward ? 0 : layout.rows.length - 1, 0);
      dispatch(state.update({ selection: EditorSelection.cursor(first.to), scrollIntoView: true, userEvent: "select" }));
      return true;
    }
    return false;
  };
}

export const enterTableDown = intoTable(true);
export const enterTableUp = intoTable(false);

/** Alt-F10: to the toolbar of the table that the caret is in (Escape comes back). */
export function focusToolbar(view: EditorView): boolean {
  const here = tableAt(view.state);
  const first = here && view.dom.querySelector<HTMLElement>(".cm-zim-table-toolbar button:not(:disabled)");
  if (!first) return false;
  first.focus();
  return true;
}

/** Where the block ends (a table, an object, verbatim text) that `pos` is in, or null if it is in none of them. */
function blockEndAt(state: EditorState, pos: number): number | null {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= pos; i++) {
    const kind = spans.kind(i);
    if ((kind === Kind.Opaque || kind === Kind.VerbatimBlock) && spans.end(i) >= pos) return spans.end(i);
  }
  return null;
}

/** A new table, of `columns` columns and `rows` rows below its header, as a block of its own, with the first cell's text selected. */
export function insertTable(columns = 3, rows = 2): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const table = tableNew(columns, rows);
    const doc = state.doc;
    // the page is written below its header: a caret in the header, or at the top of an empty page, is no place
    const head = state.selection.main.head;
    // (a caret in a block is below that block: a table in the middle of a table would cut it in two, and in verbatim text it would not be one)
    const line = head < pageBodyStart(state) || (head === 0 && doc.length === 0) ? doc.line(doc.lines) : doc.lineAt(blockEndAt(state, head) ?? head);
    const before = line.number > 1 ? doc.line(line.number - 1) : null;
    const after = line.number < doc.lines ? doc.line(line.number + 1) : null;
    // (what comes after ends the table's last line if there is a next line, and the table is followed by an empty line if that one is not)
    const suffix = after !== null && after.length === 0 ? "" : "\n";
    let at: number;
    let prefix: string;
    if (line.length === 0) {
      // on an empty line: there, with an empty line each side of it (the one it is on is one of them; the other is made)
      at = line.from;
      prefix = before && before.length > 0 ? "\n" : "";
    } else {
      // on a line with text: below it, with an empty line between
      at = line.to;
      prefix = "\n\n";
    }
    const layout = cachedLayout(table)!;
    const cell = layout.rows[0]!.cells[0]!;
    const [a, b] = cellContent(table, cell);
    dispatch(
      state.update({
        changes: { from: at, insert: prefix + table + suffix },
        selection: EditorSelection.single(at + prefix.length + a, at + prefix.length + b),
        scrollIntoView: true,
        userEvent: "input.table",
      }),
    );
    return true;
  };
}
