// Tables (core/zim-format's `table` module, compiled to wasm): what a table block says, and the edits
// the editor offers. A table is read from the text of its block (its lines, without the line break
// after the last); every edit answers with the text to put in the block's place, or undefined if it
// can't be done. `initZim()` must have finished before any of it is used.
import {
  tableAddColumn as wasmAddColumn,
  tableAddRow as wasmAddRow,
  tableDeleteColumn as wasmDeleteColumn,
  tableDeleteRow as wasmDeleteRow,
  tableFormat as wasmFormat,
  tableLayout as wasmLayout,
  tableNew as wasmNew,
  tableSetAlign as wasmSetAlign,
} from "./zim-wasm/zim_wasm.js";
import { assertZimReady } from "./zim";

export type Align = "normal" | "left" | "right" | "center";

/** A cell: where it is written (UTF-16 offsets from the start of the block, spaces round the text included), and what it says. */
export interface TableCell {
  start: number;
  end: number;
  /** As written, without the spaces round it. */
  raw: string;
  /** What it says: `raw` with `\n`, `\t`, `\\` and `\|` read as the characters they stand for. */
  text: string;
}

/** A line of the table (the header first; the alignment row is not one). */
export interface TableRow {
  /** Which line of the block it is. */
  line: number;
  start: number;
  end: number;
  cells: TableCell[];
}

export interface TableLayout {
  columns: number;
  /** The line of the alignment row, or null if the table has none. */
  alignLine: number | null;
  aligns: Align[];
  /** For each column, whether its header ends with `<` (its cells wrap). */
  wraps: boolean[];
  rows: TableRow[];
}

/** The table in `text`, or undefined if it is not one (a header, and a row below it). */
export function tableLayout(text: string): TableLayout | undefined {
  assertZimReady();
  const json = wasmLayout(text);
  return json === undefined || json === null ? undefined : (JSON.parse(json) as TableLayout);
}

/** The table written out again, every column as wide as its widest cell. */
export function tableFormat(text: string): string | undefined {
  assertZimReady();
  return wasmFormat(text) ?? undefined;
}

/** A row of empty cells below row `after` (0 is the header). */
export function tableAddRow(text: string, after: number): string | undefined {
  assertZimReady();
  return wasmAddRow(text, after) ?? undefined;
}

/** Row `row` removed (not the header, and not the last row below it). */
export function tableDeleteRow(text: string, row: number): string | undefined {
  assertZimReady();
  return wasmDeleteRow(text, row) ?? undefined;
}

/** A column of empty cells after column `after`. */
export function tableAddColumn(text: string, after: number): string | undefined {
  assertZimReady();
  return wasmAddColumn(text, after) ?? undefined;
}

/** Column `column` removed (not the last column). */
export function tableDeleteColumn(text: string, column: number): string | undefined {
  assertZimReady();
  return wasmDeleteColumn(text, column) ?? undefined;
}

/** Column `column` aligned as asked. */
export function tableSetAlign(text: string, column: number, align: Align): string | undefined {
  assertZimReady();
  return wasmSetAlign(text, column, align) ?? undefined;
}

/** The text of a new table of `columns` columns and `rows` rows below its header, with an alignment row. */
export function tableNew(columns: number, rows: number): string {
  assertZimReady();
  return wasmNew(columns, rows);
}
