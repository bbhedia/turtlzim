// A table as it is drawn when the caret is elsewhere: a grid, whose cells show their text formatted (bold,
// links, tags, code) and not as the markup it is written in; and the toolbar over a table that is being edited.
// The page's text is not changed by any of it: a click in the grid puts the caret in that cell of the text
// (which shows the table as it is written), and the toolbar's buttons are the commands of table-commands.ts.
import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { Kind } from "../kinds";
import { highlight } from "../zim";
import type { Align, TableLayout } from "../table";
import { addColumnRight, addRowBelow, alignColumn, cachedLayout, cellContent, deleteColumn, deleteRow, tidyTable } from "./table-commands";
import { linkStatusFacet } from "./syntax";
import type { LinkStatus } from "./syntax";

// ---------------------------------------------------------------------------------------------
// the text of a cell

/** The elements that wrap what a span of text marks. */
const WRAPPERS: Record<number, { tag: string; cls?: string }> = {
  [Kind.Bold]: { tag: "strong" },
  [Kind.Italic]: { tag: "em" },
  [Kind.Underline]: { tag: "span", cls: "cm-zim-underline" },
  [Kind.Strike]: { tag: "span", cls: "cm-zim-strike" },
  [Kind.InlineVerbatim]: { tag: "code", cls: "cm-zim-code-inline" },
  [Kind.Superscript]: { tag: "sup" },
  [Kind.Subscript]: { tag: "sub" },
  [Kind.Tag]: { tag: "span", cls: "cm-zim-tag" },
  [Kind.AutoUrl]: { tag: "span", cls: "cm-zim-url" },
  [Kind.AutoEmail]: { tag: "span", cls: "cm-zim-url" },
};

/**
 * What the text of a cell looks like: its markup drawn, not shown (the syntax characters are left out), links and
 * tags marked with what they lead to (`data-link`, `data-tag`) for a click to follow. `linkStatus` says whether a link's page
 * is there.
 */
export function renderInline(text: string, linkStatus?: (target: string) => LinkStatus): Node[] {
  const spans = highlight(text);
  const root = document.createDocumentFragment();
  const open: Array<{ end: number; element: ParentNode }> = [{ end: text.length, element: root }];
  let at = 0;
  const top = () => open[open.length - 1]!;
  const flush = (to: number) => {
    if (to > at) top().element.append(document.createTextNode(text.slice(at, to)));
    at = Math.max(at, to);
  };
  for (let i = 0; i < spans.length; i++) {
    const [start, end, kind] = [spans.start(i), spans.end(i), spans.kind(i)];
    while (open.length > 1 && top().end <= start) {
      flush(top().end);
      open.pop();
    }
    flush(start);
    const wrap = WRAPPERS[kind];
    if (kind === Kind.Marker) {
      at = Math.max(at, end);
    } else if (kind === Kind.LinkTarget && spans.detail(i) === 1) {
      // (the target of a link that has text of its own to show is source, not text)
      at = Math.max(at, end);
    } else if (kind === Kind.Link) {
      const t = spans.next(Kind.LinkTarget, i, end);
      const target = t >= 0 ? text.slice(spans.start(t), spans.end(t)) : "";
      const element = document.createElement("span");
      element.className = `cm-zim-link${linkStatus && linkStatus(target) === "missing" ? " cm-zim-link-missing" : ""}`;
      element.dataset.link = target;
      top().element.append(element);
      open.push({ end, element });
    } else if (kind === Kind.Image || kind === Kind.Anchor) {
      if (kind === Kind.Image) {
        const written = text.slice(start + 2, end - 2);
        const bar = written.lastIndexOf("|");
        const label = bar >= 0 && bar < written.length - 1 ? written.slice(bar + 1) : ((written.split(/[?|]/)[0] ?? written).split("/").pop() || written);
        const chip = document.createElement("span");
        chip.className = "cm-zim-chip cm-zim-chip-image";
        chip.textContent = label;
        top().element.append(chip);
      }
      at = Math.max(at, end);
    } else if (wrap) {
      const element = document.createElement(wrap.tag);
      if (wrap.cls) element.className = wrap.cls;
      if (kind === Kind.Tag) element.dataset.tag = text.slice(start + 1, end);
      if (kind === Kind.AutoUrl || kind === Kind.AutoEmail) element.dataset.link = text.slice(start, end);
      top().element.append(element);
      open.push({ end, element });
    }
  }
  while (open.length > 1) {
    flush(top().end);
    open.pop();
  }
  flush(text.length);
  return [...root.childNodes];
}

// ---------------------------------------------------------------------------------------------
// the grid

/** What a click in the grid does with a link or a tag in a cell (a plain click goes to the text, to edit). */
export interface GridHost {
  followLink?: (target: string, from: number, to: number) => void;
  followTag?: (tag: string) => void;
}

const ALIGN_CLASS: Record<Align, string> = { normal: "", left: "cm-zim-align-left", right: "cm-zim-align-right", center: "cm-zim-align-center" };

export class TableWidget extends WidgetType {
  constructor(
    /** The block's lines. */
    readonly text: string,
    private readonly host: GridHost = {},
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.text === this.text;
  }

  get estimatedHeight(): number {
    return this.text.split("\n").length * 32;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const layout = cachedLayout(this.text) as TableLayout;
    const status = view.state.facet(linkStatusFacet);
    const wrap = document.createElement("div");
    wrap.className = "cm-zim-grid-wrap";
    const table = document.createElement("table");
    table.className = "cm-zim-grid";
    table.setAttribute("aria-label", `Table of ${layout.rows.length - 1} ${layout.rows.length === 2 ? "row" : "rows"} and ${layout.columns} ${layout.columns === 1 ? "column" : "columns"}`);
    layout.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < layout.columns; c++) {
        const cell = row.cells[c];
        const td = document.createElement(r === 0 ? "th" : "td");
        const classes = [ALIGN_CLASS[layout.aligns[c] ?? "normal"], layout.wraps[c] ? "cm-zim-wrap" : ""].filter(Boolean);
        if (classes.length) td.className = classes.join(" ");
        if (r === 0) td.scope = "col";
        td.dataset.row = String(r);
        td.dataset.column = String(c);
        if (cell) td.append(...renderInline(r === 0 && layout.wraps[c] ? cell.text.replace(/<$/, "") : cell.text, status));
        tr.append(td);
      }
      table.append(tr);
    });
    wrap.append(table);
    wrap.addEventListener("mousedown", (event) => this.pressed(event, view, wrap, layout));
    return wrap;
  }

  private pressed(event: MouseEvent, view: EditorView, wrap: HTMLElement, layout: TableLayout): void {
    if (event.button !== 0) return;
    // (the page's own text takes the caret; the grid never takes a selection of its own, or the focus)
    event.preventDefault();
    const target = event.target as HTMLElement;
    const from = view.posAtDOM(wrap);
    const cell = target.closest<HTMLElement>("td, th");
    const follows = event.ctrlKey || event.metaKey || view.state.readOnly;
    if (follows) {
      const tag = target.closest<HTMLElement>("[data-tag]");
      const link = target.closest<HTMLElement>("[data-link]");
      if (tag?.dataset.tag !== undefined && this.host.followTag) return this.host.followTag(tag.dataset.tag);
      if (link?.dataset.link !== undefined && this.host.followLink) return this.host.followLink(link.dataset.link, from, from + this.text.length);
    }
    const row = layout.rows[Number(cell?.dataset.row ?? 0)];
    const at = row?.cells[Number(cell?.dataset.column ?? 0)];
    let anchor: number;
    if (!row) anchor = from;
    else if (!at) anchor = from + row.end;
    else anchor = from + cellContent(this.text, at)[1]; // the end of what the cell says: where a person goes on typing
    view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: "select.pointer" });
    view.focus();
  }
}

// ---------------------------------------------------------------------------------------------
// the toolbar

/** What the toolbar needs to know of the table and the caret's place in it, to draw its buttons. */
export interface ToolbarState {
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
  align: Align;
}

interface ToolbarButton {
  label: string;
  title: string;
  run: (view: EditorView) => boolean;
  /** Disabled when this says the thing can't be done. */
  can?: (state: ToolbarState) => boolean;
  /** Pressed when this says it is what the column has now. */
  pressed?: (state: ToolbarState) => boolean;
}

const BUTTONS: ToolbarButton[] = [
  { label: "+ Row", title: "Add a row below this one", run: (v) => addRowBelow(v) },
  { label: "− Row", title: "Delete this row", run: (v) => deleteRow(v), can: (s) => s.canDeleteRow },
  { label: "+ Column", title: "Add a column after this one", run: (v) => addColumnRight(v) },
  { label: "− Column", title: "Delete this column", run: (v) => deleteColumn(v), can: (s) => s.canDeleteColumn },
  { label: "Left", title: "Align this column to the left", run: (v) => alignColumn("left")(v), pressed: (s) => s.align === "left" },
  { label: "Center", title: "Center this column", run: (v) => alignColumn("center")(v), pressed: (s) => s.align === "center" },
  { label: "Right", title: "Align this column to the right", run: (v) => alignColumn("right")(v), pressed: (s) => s.align === "right" },
  { label: "Tidy", title: "Write the table with its columns lined up", run: (v) => tidyTable(v) },
];

export class TableToolbar extends WidgetType {
  constructor(readonly state: ToolbarState) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableToolbar && other.state.canDeleteRow === this.state.canDeleteRow && other.state.canDeleteColumn === this.state.canDeleteColumn && other.state.align === this.state.align;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-zim-table-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Table");
    for (const spec of BUTTONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = spec.label;
      button.title = spec.title;
      button.setAttribute("aria-label", spec.title);
      if (spec.can && !spec.can(this.state)) button.disabled = true;
      if (spec.pressed) button.setAttribute("aria-pressed", String(spec.pressed(this.state)));
      // (a press must not take the caret out of the table: the buttons act on where it is)
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        spec.run(view);
        view.focus();
      });
      bar.append(button);
    }
    bar.addEventListener("keydown", (event) => {
      const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        view.focus();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    return bar;
  }
}
