// Editing commands. Each is a pure function of the editor state (a CodeMirror `StateCommand`), so
// they run and are tested without a DOM. What is a bold span, a list item or a heading is decided
// by the parser's spans (the same ones that drive the formatting), never by sniffing the text.
import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState, Line, SelectionRange, StateCommand, TransactionSpec } from "@codemirror/state";
import { Kind, ListMarker } from "../kinds";
import { spansOf } from "./syntax";

// ---------------------------------------------------------------------------------------------
// Checkboxes

/**
 * Toggle the checkbox whose marker starts at `markerFrom`: an open box becomes done (`[*]`), any
 * other state goes back to open (`[ ]`). With `cross`, an open box becomes dropped (`[x]`) instead
 * and a dropped one reopens. Returns null when there is no checkbox marker there.
 */
export function toggleCheckboxAt(state: EditorState, markerFrom: number, cross = false): TransactionSpec | null {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= markerFrom; i++) {
    if (spans.kind(i) !== Kind.ListMarker || spans.start(i) !== markerFrom) continue;
    const detail = spans.detail(i);
    let glyph: string;
    switch (detail) {
      case ListMarker.UNCHECKED:
        glyph = cross ? "x" : "*";
        break;
      case ListMarker.CHECKED:
        glyph = cross ? "x" : " ";
        break;
      case ListMarker.XCHECKED:
        glyph = cross ? " " : "*";
        break;
      case ListMarker.MIGRATED:
      case ListMarker.TRANSMIGRATED:
        glyph = " ";
        break;
      default:
        return null;
    }
    // `[` + glyph + `]`: replace only the glyph, so nothing else about the line is touched.
    return { changes: { from: markerFrom + 1, to: markerFrom + 2, insert: glyph }, userEvent: "input.toggle" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Helpers over lines, list items and headings

/** A list item as the parser sees it, with the offsets commands need. */
export interface ListItemInfo {
  line: Line;
  /** Depth in tabs. */
  indent: number;
  markerFrom: number;
  /** Where the item's text starts (after the marker and its space). */
  textFrom: number;
  /** A `ListMarker` code. */
  marker: number;
}

const isCheckboxMarker = (marker: number): boolean => marker >= ListMarker.UNCHECKED;

/** The distinct lines touched by the selection, in order. */
function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = [];
  let last = 0;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let end = state.doc.lineAt(range.to).number;
    // A selection that ends at the very start of a line doesn't include that line.
    if (!range.empty && end > first && range.to === state.doc.line(end).from) end--;
    for (let n = Math.max(first, last + 1); n <= end; n++) {
      lines.push(state.doc.line(n));
      last = n;
    }
  }
  return lines;
}

/** The list items whose line starts in [from, to], keyed by the line's start. */
function listItems(state: EditorState, from: number, to: number): Map<number, ListItemInfo> {
  const spans = spansOf(state);
  const items = new Map<number, ListItemInfo>();
  for (let i = 0; i < spans.length && spans.start(i) <= to; i++) {
    if (spans.kind(i) !== Kind.ListItem || spans.start(i) < from) continue;
    const marker = i + 1;
    if (marker >= spans.length || spans.kind(marker) !== Kind.ListMarker) continue;
    const line = state.doc.lineAt(spans.start(i));
    items.set(line.from, {
      line,
      indent: spans.detail(i),
      markerFrom: spans.start(marker),
      textFrom: spans.end(marker),
      marker: spans.detail(marker),
    });
  }
  return items;
}

function itemAt(state: EditorState, line: Line): ListItemInfo | undefined {
  return listItems(state, line.from, line.from).get(line.from);
}

/** What kind of line this is, for commands that only make sense on ordinary text. */
function isPlainTextLine(state: EditorState, line: Line): boolean {
  if (line.length === 0) return false;
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= line.to; i++) {
    const kind = spans.kind(i);
    const covers = spans.start(i) <= line.from && spans.end(i) >= line.to;
    if (covers && (kind === Kind.ListItem || kind === Kind.VerbatimBlock || kind === Kind.Opaque || kind === Kind.Header || kind === Kind.HorizontalRule)) {
      return false;
    }
  }
  return true;
}

const scrolled = (spec: TransactionSpec): TransactionSpec => ({ ...spec, scrollIntoView: true });

// ---------------------------------------------------------------------------------------------
// Inline formatting

export interface Wrapper {
  /** The span kind the construct has. */
  kind: number;
  open: string;
  close: string;
}

export const WRAPPERS = {
  bold: { kind: Kind.Bold, open: "**", close: "**" },
  italic: { kind: Kind.Italic, open: "//", close: "//" },
  underline: { kind: Kind.Underline, open: "__", close: "__" },
  strike: { kind: Kind.Strike, open: "~~", close: "~~" },
  code: { kind: Kind.InlineVerbatim, open: "''", close: "''" },
  superscript: { kind: Kind.Superscript, open: "^{", close: "}" },
  subscript: { kind: Kind.Subscript, open: "_{", close: "}" },
} as const satisfies Record<string, Wrapper>;

/** The innermost construct of `kind` that contains [from, to] (edges included), or -1. */
function enclosingConstruct(state: EditorState, kind: number, from: number, to: number): number {
  const spans = spansOf(state);
  let found = -1;
  for (let i = 0; i < spans.length && spans.start(i) <= from; i++) {
    if (spans.kind(i) === kind && spans.end(i) >= to) found = i;
  }
  return found;
}

/** The first and last marker owned by span `owner`. */
function markersOf(state: EditorState, owner: number): [number, number] | null {
  const spans = spansOf(state);
  let first = -1;
  let last = -1;
  for (let i = owner + 1; i < spans.length && spans.start(i) < spans.end(owner); i++) {
    if (spans.kind(i) === Kind.Marker && spans.owner(i) === owner) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 || first === last ? null : [first, last];
}

/** The parts of [from, to] that have text in them, one per line, without surrounding blanks. */
function trimmedSegments(state: EditorState, from: number, to: number): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
    const line = state.doc.line(n);
    let a = Math.max(from, line.from);
    let b = Math.min(to, line.to);
    const text = state.sliceDoc(a, b);
    a += text.length - text.trimStart().length;
    b -= text.length - text.trimEnd().length;
    if (a < b) segments.push([a, b]);
  }
  return segments;
}

function wrapRange(state: EditorState, w: Wrapper, range: SelectionRange): { changes: ChangeSpec; range: SelectionRange } {
  // Inside a construct of this kind (a caret in it, or a selection within it): take it off.
  const found = enclosingConstruct(state, w.kind, range.from, range.to);
  if (found >= 0) {
    const markers = markersOf(state, found);
    if (markers) {
      const spans = spansOf(state);
      const changes = state.changes([
        { from: spans.start(markers[0]), to: spans.end(markers[0]) },
        { from: spans.start(markers[1]), to: spans.end(markers[1]) },
      ]);
      return { changes, range: range.map(changes) };
    }
  }

  let from = range.from;
  let to = range.to;
  if (range.empty) {
    const word = state.wordAt(range.head);
    if (!word) {
      // Nothing to wrap: an empty pair with the caret between, ready to type into.
      return {
        changes: { from: range.head, insert: w.open + w.close },
        range: EditorSelection.cursor(range.head + w.open.length),
      };
    }
    ({ from, to } = word);
  }
  const segments = trimmedSegments(state, from, to);
  if (segments.length === 0) {
    return {
      changes: { from: range.head, insert: w.open + w.close },
      range: EditorSelection.cursor(range.head + w.open.length),
    };
  }
  const changes = state.changes(
    segments.flatMap(([a, b]): ChangeSpec[] => [
      { from: a, insert: w.open },
      { from: b, insert: w.close },
    ]),
  );
  if (range.empty) {
    // The caret stays inside the word: after the opening marker if it was at the start, before the
    // closing one if it was at the end.
    return { changes, range: EditorSelection.cursor(changes.mapPos(range.head, range.head === to ? -1 : 1)) };
  }
  const first = segments[0] as [number, number];
  const last = segments[segments.length - 1] as [number, number];
  return { changes, range: EditorSelection.range(changes.mapPos(first[0], 1), changes.mapPos(last[1], -1)) };
}

/**
 * Toggle an inline style. Inside a construct of that style, it comes off; otherwise the selection
 * (trimmed of surrounding blanks, one piece per line) is wrapped, a bare caret wraps the word
 * under it, and with no word there an empty pair is inserted.
 */
export function toggleWrap(wrapper: Wrapper): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(
      state.update(
        scrolled({ ...state.changeByRange((range) => wrapRange(state, wrapper, range)), userEvent: "input.format" }),
      ),
    );
    return true;
  };
}

/** `[[selection]]`, or an empty link with the caret inside it. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(
    state.update(
      scrolled({
        ...state.changeByRange((range) => {
          if (range.empty) {
            return { changes: { from: range.head, insert: "[[]]" }, range: EditorSelection.cursor(range.head + 2) };
          }
          const changes = state.changes([
            { from: range.from, insert: "[[" },
            { from: range.to, insert: "]]" },
          ]);
          return { changes, range: EditorSelection.cursor(changes.mapPos(range.to, 1)) };
        }),
        userEvent: "input.format",
      }),
    ),
  );
  return true;
};

// ---------------------------------------------------------------------------------------------
// Headings

/** Make the selected lines headings of `level` (1 to 5); a line that already is one of that level becomes plain text again. `0` clears headings. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const spans = spansOf(state);
    const headings = new Map<number, { level: number; text: string }>();
    for (let i = 0; i < spans.length; i++) {
      if (spans.kind(i) !== Kind.Heading) continue;
      const bars = 7 - spans.detail(i);
      headings.set(spans.start(i), {
        level: spans.detail(i),
        text: state.sliceDoc(spans.start(i) + bars + 1, spans.end(i) - bars - 1),
      });
    }
    const changes: ChangeSpec[] = [];
    for (const line of selectedLines(state)) {
      const heading = headings.get(line.from);
      if (!heading && (level === 0 || !isPlainTextLine(state, line))) continue;
      const text = heading ? heading.text : line.text.trim();
      const bars = "=".repeat(7 - level);
      const next = level === 0 || heading?.level === level ? text : `${bars} ${text} ${bars}`;
      if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    }
    if (changes.length === 0) return false;
    dispatch(state.update(scrolled({ changes, userEvent: "input.format" })));
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Lists

/** The marker text that follows `marker` (as written) on the next line of a list. */
export function nextMarker(written: string): string {
  const token = written.trimEnd();
  if (token === "*") return "* ";
  if (token.startsWith("[")) return "[ ] ";
  const digits = /^(\d+)\.$/.exec(token);
  if (digits) return `${Number(digits[1]) + 1}. `;
  const letter = /^([a-zA-Z])\.$/.exec(token);
  if (letter) {
    const c = (letter[1] as string).charCodeAt(0);
    const wraps = c === 0x7a || c === 0x5a; // z or Z: only single letters are markers, so start over
    return `${String.fromCharCode(wraps ? c - 25 : c + 1)}. `;
  }
  return "* ";
}

/**
 * Enter in a list item continues the list with the same indent and the next marker; in the middle
 * of an item the rest of the text moves to the new one. On an empty item the list ends (an indented
 * one first moves out a level).
 */
export const listEnter: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const item = itemAt(state, line);
  if (!item || range.from < item.textFrom) return false;

  if (line.to === item.textFrom && range.empty) {
    // An empty item: leave the list, or go out one level.
    const spec: TransactionSpec =
      item.indent > 0
        ? { changes: { from: line.from, to: line.from + 1 }, selection: EditorSelection.cursor(range.head - 1) }
        : { changes: { from: line.from, to: line.to }, selection: EditorSelection.cursor(line.from) };
    dispatch(state.update(scrolled({ ...spec, userEvent: "input" })));
    return true;
  }
  const marker = nextMarker(state.sliceDoc(item.markerFrom, item.textFrom));
  const insert = `\n${"\t".repeat(item.indent)}${marker}`;
  dispatch(
    state.update(
      scrolled({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        userEvent: "input",
      }),
    ),
  );
  return true;
};

/** Backspace right after a list marker takes the item out a level, or off the list at the top level. */
export const listBackspace: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const item = itemAt(state, state.doc.lineAt(pos));
  if (!item || pos !== item.textFrom) return false;
  const spec: TransactionSpec =
    item.indent > 0
      ? { changes: { from: item.line.from, to: item.line.from + 1 } }
      : { changes: { from: item.markerFrom, to: item.textFrom } };
  dispatch(state.update(scrolled({ ...spec, userEvent: "delete.backward" })));
  return true;
};

/**
 * Tab: in a list, indent the selected items one level; elsewhere insert a tab (or, with several
 * lines selected, indent them all).
 */
export const indentMore: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  const range = state.selection.main;
  const items = listItems(state, lines[0]?.from ?? 0, lines[lines.length - 1]?.from ?? 0);
  const inList = lines.some((l) => items.has(l.from));
  if (!inList && range.empty) {
    dispatch(state.update(scrolled(state.replaceSelection("\t"))));
    return true;
  }
  const changes = lines.filter((l) => l.length > 0).map((l) => ({ from: l.from, insert: "\t" }));
  if (changes.length === 0) return false;
  dispatch(state.update(scrolled({ changes, userEvent: "input.indent" })));
  return true;
};

/** Shift-Tab: take the selected lines out one level. */
export const indentLess: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const changes = selectedLines(state)
    .filter((l) => state.sliceDoc(l.from, l.from + 1) === "\t")
    .map((l) => ({ from: l.from, to: l.from + 1 }));
  if (changes.length === 0) return false;
  dispatch(state.update(scrolled({ changes, userEvent: "delete.dedent" })));
  return true;
};

export type ListKind = "bullet" | "number" | "checkbox";

const markerFor = (kind: ListKind, index: number): string => (kind === "bullet" ? "* " : kind === "checkbox" ? "[ ] " : `${index + 1}. `);

const isKind = (marker: number, kind: ListKind): boolean =>
  kind === "bullet" ? marker === ListMarker.BULLET : kind === "checkbox" ? isCheckboxMarker(marker) : marker === ListMarker.NUMBER;

/**
 * Turn the selected lines into a list of `kind`; if they all already are one, take them off the
 * list. Blank lines are skipped, existing indentation is kept, and numbers count up.
 */
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const lines = selectedLines(state).filter((l) => l.length > 0);
    if (lines.length === 0) return false;
    const items = listItems(state, lines[0]!.from, lines[lines.length - 1]!.from);
    const allOfKind = lines.every((l) => {
      const item = items.get(l.from);
      return item !== undefined && isKind(item.marker, kind);
    });
    const changes: ChangeSpec[] = [];
    lines.forEach((line, index) => {
      const item = items.get(line.from);
      if (allOfKind && item) {
        // Off the list means plain text: the indentation goes too, or it would be an indented paragraph.
        changes.push({ from: line.from, to: item.textFrom });
      } else if (item) {
        changes.push({ from: item.markerFrom, to: item.textFrom, insert: markerFor(kind, index) });
      } else {
        const tabs = /^\t*/.exec(line.text)?.[0].length ?? 0;
        changes.push({ from: line.from + tabs, insert: markerFor(kind, index) });
      }
    });
    dispatch(state.update(scrolled({ changes, userEvent: "input.format" })));
    return true;
  };
}

/**
 * The checkbox of the line the caret is on: toggle it; on a bullet or numbered item, make it a
 * checkbox item; on a plain line, make it one. `cross` marks it dropped instead of done.
 */
export function toggleCheckboxHere(cross = false): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const line = state.doc.lineAt(state.selection.main.head);
    const item = itemAt(state, line);
    if (item && isCheckboxMarker(item.marker)) {
      const spec = toggleCheckboxAt(state, item.markerFrom, cross);
      if (!spec) return false;
      dispatch(state.update(scrolled(spec)));
      return true;
    }
    return toggleList("checkbox")({ state, dispatch });
  };
}

// ---------------------------------------------------------------------------------------------
// Inserting references (to attachments)

/**
 * Put `text` (a reference to an attachment, say) in the page, as a change: at `at` if that is given
 * (where something was dropped), else in place of the selection, with the caret after it. At the end
 * of the page, on a line of its own, if `at` is `"end"`, or if the place is a caret in the header
 * block or at the very top of the page (the page was only just opened, and anything put there would
 * break the header).
 */
export function insertReference(state: EditorState, text: string, at?: number | "end"): TransactionSpec {
  const spans = spansOf(state);
  // the header block and the blank line that ends it: the body starts below that
  let bodyStart = spans.length > 0 && spans.kind(0) === Kind.Header ? spans.end(0) : 0;
  while (bodyStart > 0 && bodyStart < state.doc.length && /[\r\n]/.test(state.sliceDoc(bodyStart, bodyStart + 1))) bodyStart++;
  const main = state.selection.main;
  const from = at === "end" ? 0 : (at ?? main.from);
  const to = at === undefined ? main.to : from;
  if (at === "end" || from < bodyStart || from === 0) {
    const end = state.doc.length;
    const insert = `${end > 0 && state.sliceDoc(end - 1, end) !== "\n" ? "\n" : ""}${text}\n`;
    return { changes: { from: end, insert }, selection: EditorSelection.cursor(end + insert.length), scrollIntoView: true, userEvent: "input" };
  }
  return { changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true, userEvent: "input" };
}
