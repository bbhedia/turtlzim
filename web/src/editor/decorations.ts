import { StateField } from "@codemirror/state";
import type { EditorState, Line, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { Kind, ListMarker, Opaque, VERBATIM_UNTERMINATED } from "../kinds";
import type { Spans } from "../spans";
import { imageParam, imagesIn } from "../notebook-core";
import type { TextImage } from "../notebook-core";
import { imageSourceFacet, linkStatusFacet, refreshLinks, setShowMarkup, showMarkupField, spansOf } from "./syntax";
import { followFacet } from "./follow";
import { linkToFollow } from "./links";
import { cachedLayout, placeIn, whatCanGo } from "./table-commands";
import { TableToolbar, TableWidget } from "./table-widget";
import type { GridHost } from "./table-widget";
import { BulletWidget, CheckboxWidget, ChipWidget, HeaderWidget, ImageWidget, RuleWidget, isCheckbox } from "./widgets";

/** The decorations of a document, and the subset of them that hide text (the caret skips those). */
export interface Decorated {
  all: DecorationSet;
  atomic: DecorationSet;
}

const INLINE_CLASSES: Record<number, string> = {
  [Kind.HeaderKey]: "cm-zim-header-key",
  [Kind.Bold]: "cm-zim-bold",
  [Kind.Italic]: "cm-zim-italic",
  [Kind.Underline]: "cm-zim-underline",
  [Kind.Strike]: "cm-zim-strike",
  [Kind.InlineVerbatim]: "cm-zim-code-inline",
  [Kind.Superscript]: "cm-zim-sup",
  [Kind.Subscript]: "cm-zim-sub",
  [Kind.LinkDisplay]: "cm-zim-link-display",
  [Kind.Tag]: "cm-zim-tag",
  [Kind.AutoUrl]: "cm-zim-url",
  [Kind.AutoEmail]: "cm-zim-url",
};

/**
 * Live preview: how a page looks, as decorations over its text. The text itself is never changed.
 *
 * Syntax characters (the `**` of bold, the `[[` of a link, the `======` of a heading) are the
 * `Marker` spans, each owned by the construct it belongs to. A marker is dimmed while a selection
 * touches its construct and hidden otherwise; `showMarkup` keeps every marker visible. Bullets,
 * checkboxes and rules are drawn as widgets in place of their characters, and images and anchors
 * as small chips until the caret enters them.
 */
export function buildDecorations(state: EditorState, spans: Spans, showMarkup: boolean): Decorated {
  const doc = state.doc;
  const linkStatus = state.facet(linkStatusFacet);
  const imageSource = state.facet(imageSourceFacet);
  const statusOf = new Map<string, string>(); // each target is asked about once per rebuild
  const imageOf = new Map<string, TextImage | undefined>(); // and each image is read once
  const ranges = state.selection.ranges;
  const touches = (from: number, to: number): boolean => ranges.some((r) => r.from <= to && r.to >= from);
  const reveal = (from: number, to: number): boolean => showMarkup || touches(from, to);
  // A picture stays a picture while the caret is beside it (arrowing past one must not make the page jump
  // around); its source shows when it is selected, or the caret is inside the source.
  const revealImage = (from: number, to: number): boolean => showMarkup || ranges.some((r) => r.from < to && r.to > from);

  const all: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];

  // what a click with Ctrl in the grid of a table does with a link or a tag in a cell: what the editor was given for the page's own
  const follow = state.facet(followFacet);
  const gridHost = (): GridHost => ({
    ...(follow.link ? { followLink: (target: string, a: number, b: number) => follow.link?.(linkToFollow(target, a, b)) } : {}),
    ...(follow.tag ? { followTag: (tag: string) => follow.tag?.(tag) } : {}),
  });

  const lineDeco = (pos: number, cls: string, style?: string): void => {
    all.push(Decoration.line({ class: cls, ...(style ? { attributes: { style } } : {}) }).range(pos));
  };
  const mark = (from: number, to: number, cls: string): void => {
    if (from < to) all.push(Decoration.mark({ class: cls }).range(from, to));
  };
  const replace = (from: number, to: number, widget?: BulletWidget | CheckboxWidget | ChipWidget | ImageWidget | RuleWidget): void => {
    if (from >= to) return;
    const range = Decoration.replace(widget ? { widget } : {}).range(from, to);
    all.push(range);
    atomic.push(range);
  };
  const eachLine = (from: number, to: number, f: (line: Line, index: number, count: number) => void): void => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) f(doc.line(n), n - first, last - first + 1);
  };

  const open: number[] = []; // the chain of spans containing the current one
  let skipUntil = 0; // spans starting before this are covered by a replacing widget
  for (let i = 0; i < spans.length; i++) {
    const from = spans.start(i);
    const to = spans.end(i);
    const kind = spans.kind(i);
    const detail = spans.detail(i);
    while (open.length && spans.end(open[open.length - 1] as number) <= from) open.pop();
    const parent = open.length ? (open[open.length - 1] as number) : -1;
    open.push(i);
    if (from < skipUntil) continue;

    switch (kind) {
      case Kind.Header:
        // Zim does not show it: one line, until the caret comes into it (and with Show markup, as written). A caret at the very start of
        // the page does not unfold it: that is where a page is opened, before anyone has put the caret anywhere.
        if (!(showMarkup || ranges.some((r) => r.to > from && r.from <= to))) {
          all.push(Decoration.replace({ widget: new HeaderWidget(state.sliceDoc(from, to)), block: true }).range(from, to));
          skipUntil = to;
          break;
        }
        eachLine(from, to, (line) => lineDeco(line.from, "cm-zim-header"));
        break;

      case Kind.Heading:
        lineDeco(doc.lineAt(from).from, `cm-zim-heading cm-zim-h${detail}`);
        break;

      case Kind.IndentedParagraph:
        eachLine(from, to, (line) => lineDeco(line.from, "cm-zim-indented", `--zim-depth: ${detail}`));
        break;

      case Kind.ListItem:
        lineDeco(doc.lineAt(from).from, "cm-zim-item", `--zim-depth: ${detail}`);
        break;

      case Kind.ListMarker:
        if (detail === ListMarker.BULLET) {
          if (showMarkup) mark(from, to, "cm-zim-list-marker");
          else replace(from, to, new BulletWidget());
        } else if (isCheckbox(detail)) {
          if (showMarkup) mark(from, to, "cm-zim-list-marker");
          else replace(from, to, new CheckboxWidget(detail));
          const line = doc.lineAt(from).from;
          if (detail === ListMarker.CHECKED) lineDeco(line, "cm-zim-item-done");
          if (detail === ListMarker.XCHECKED) lineDeco(line, "cm-zim-item-dropped");
        } else {
          mark(from, to, "cm-zim-list-marker cm-zim-list-number");
        }
        break;

      case Kind.VerbatimBlock: {
        const unterminated = (detail & VERBATIM_UNTERMINATED) !== 0;
        eachLine(from, to, (line, index, count) => {
          let cls = "cm-zim-code";
          if (index === 0) cls += " cm-zim-code-first";
          if (index === count - 1) cls += " cm-zim-code-last";
          if (unterminated) cls += " cm-zim-code-open";
          lineDeco(line.from, cls);
        });
        break;
      }

      case Kind.HorizontalRule:
        if (reveal(from, to)) mark(from, to, "cm-zim-rule-source");
        else {
          replace(from, to, new RuleWidget());
          skipUntil = to;
        }
        break;

      case Kind.Opaque: {
        // A table that can be read as one is drawn as a grid, until the caret comes into it: then it is the text it is
        // written as, with a toolbar over it. (Anything else in this kind of block is shown as written.)
        const text = detail === Opaque.TABLE ? state.sliceDoc(from, to) : "";
        const layout = detail === Opaque.TABLE ? cachedLayout(text) : undefined;
        if (layout && !reveal(from, to)) {
          all.push(Decoration.replace({ widget: new TableWidget(text, gridHost()), block: true }).range(from, to));
          skipUntil = to;
          break;
        }
        eachLine(from, to, (line) =>
          lineDeco(line.from, `cm-zim-opaque ${detail === Opaque.OBJECT ? "cm-zim-object" : "cm-zim-table"}`),
        );
        const head = state.selection.main.head;
        if (layout && !state.readOnly && head >= from && head <= to) {
          const { row, column } = placeIn(layout, text, head - from);
          const can = whatCanGo({ from, to, text, layout, row, column });
          all.push(Decoration.widget({ widget: new TableToolbar({ canDeleteRow: can.row, canDeleteColumn: can.column, align: layout.aligns[column] ?? "normal" }), block: true, side: -1 }).range(from));
        }
        break;
      }

      case Kind.Marker: {
        const owner = detail;
        if (reveal(spans.start(owner), spans.end(owner))) mark(from, to, "cm-zim-marker");
        else replace(from, to);
        break;
      }

      case Kind.Link: {
        let cls = "cm-zim-link";
        const target = spans.next(Kind.LinkTarget, i, to);
        if (linkStatus && target >= 0) {
          const text = state.sliceDoc(spans.start(target), spans.end(target));
          if (!statusOf.has(text)) statusOf.set(text, linkStatus(text));
          if (statusOf.get(text) === "missing") cls += " cm-zim-link-missing";
        }
        mark(from, to, cls);
        break;
      }

      case Kind.LinkTarget:
        // With a display part (detail 1) the target is source, not text: hide it like the brackets.
        if (detail === 1 && parent >= 0 && !reveal(spans.start(parent), spans.end(parent))) replace(from, to);
        else mark(from, to, "cm-zim-link-target");
        break;

      case Kind.Image: {
        if (!imageSource ? reveal(from, to) : revealImage(from, to)) {
          mark(from, to, "cm-zim-image-source");
          break;
        }
        const written = state.sliceDoc(from, to);
        const label = imageLabel(written.slice(2, -2));
        if (!imageSource) {
          replace(from, to, new ChipWidget("image", label));
        } else {
          if (!imageOf.has(written)) imageOf.set(written, imagesIn(written)[0]);
          const image = imageOf.get(written);
          const source = image ? imageSource(image.path) : ({ status: "missing" } as const);
          if (image && source.status === "ready") {
            replace(from, to, new ImageWidget(source.url, image.path, image.alt ?? "", imageParam(image, "width"), imageParam(image, "height"), imageParam(image, "href") !== undefined));
          } else {
            const why: Record<string, string> = {
              loading: "Loading the picture…",
              missing: "There is no such file in this notebook.",
              outside: "A picture outside the notebook is not loaded.",
              unsupported: "This file is not a picture the browser can show safely.",
              failed: "The picture could not be read from this browser's storage.",
            };
            replace(from, to, new ChipWidget("image", label, source.status, why[source.status] ?? ""));
          }
        }
        skipUntil = to;
        break;
      }

      case Kind.Anchor:
        if (reveal(from, to)) mark(from, to, "cm-zim-anchor-source");
        else {
          replace(from, to, new ChipWidget("anchor", state.sliceDoc(from + 5, to - 2).trim()));
          skipUntil = to;
        }
        break;

      default: {
        const cls = INLINE_CLASSES[kind];
        if (cls) mark(from, to, cls);
      }
    }
  }
  return { all: Decoration.set(all, true), atomic: Decoration.set(atomic, true) };
}

/** What to show for an image whose source is hidden: its alt text, else the file name. */
function imageLabel(source: string): string {
  const bar = source.lastIndexOf("|");
  if (bar >= 0 && bar < source.length - 1) return source.slice(bar + 1);
  const path = source.split(/[?|]/)[0] ?? source;
  return path.split("/").pop() || path;
}

export const decorationsField = StateField.define<Decorated>({
  create: (state) => buildDecorations(state, spansOf(state), state.field(showMarkupField)),
  update(value, tr) {
    const changed = tr.docChanged || tr.selection !== undefined || tr.effects.some((e) => e.is(setShowMarkup) || e.is(refreshLinks));
    return changed ? buildDecorations(tr.state, spansOf(tr.state), tr.state.field(showMarkupField)) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.all),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});
