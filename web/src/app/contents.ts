// The contents of the page that is open: its headings in order, each a place to go to.
import type { EditorState } from "@codemirror/state";
import { spansOf } from "../editor/syntax";
import { Kind } from "../kinds";
import { clear, h } from "./dom";

/** A heading of a page. */
export interface Heading {
  /** 1 (the biggest) to 5. */
  level: number;
  /** What the heading says, without its `=` marks and the markup in it (`**` of bold text, `[[` of a link). */
  text: string;
  /** Where it starts in the document. */
  from: number;
}

/** The headings of the document: where the parser says they are, and what they say as a person reads them. */
export function headingsOf(state: EditorState): Heading[] {
  const spans = spansOf(state);
  const found: Heading[] = [];
  for (let i = 0; i < spans.length; i++) {
    if (spans.kind(i) !== Kind.Heading) continue;
    const from = spans.start(i);
    const to = spans.end(i);
    let text = "";
    let at = from;
    for (let j = i + 1; j < spans.length && spans.start(j) < to; j++) {
      const syntax = spans.kind(j) === Kind.Marker || (spans.kind(j) === Kind.LinkTarget && spans.detail(j) === 1);
      if (!syntax) continue;
      if (spans.start(j) > at) text += state.sliceDoc(at, spans.start(j));
      at = Math.max(at, spans.end(j));
    }
    text += state.sliceDoc(at, to);
    found.push({ level: spans.detail(i), text: text.replace(/\s+/g, " ").trim(), from });
  }
  return found;
}

/** The sidebar's list of the open page's headings. */
export class ContentsPanel {
  readonly element: HTMLDetailsElement;
  private readonly count = h("span", { class: "count" });
  private readonly list = h("ul", { class: "panel-list contents-list" });

  /** `jump` is told where a heading is, to take the caret there. */
  constructor(
    private readonly jump: (from: number) => void,
    open = true,
  ) {
    this.element = h("details", { class: "panel contents", open }, h("summary", {}, "Contents ", this.count), this.list);
    this.show([]);
  }

  show(headings: Heading[]): void {
    clear(this.list);
    this.count.textContent = headings.length ? `(${headings.length})` : "";
    if (headings.length === 0) {
      this.list.append(h("li", { class: "none", text: "This page has no headings." }));
      return;
    }
    const top = Math.min(...headings.map((heading) => heading.level));
    for (const heading of headings) {
      this.list.append(
        h(
          "li",
          { style: `--level: ${heading.level - top}` },
          h("button", { type: "button", class: "link-button", title: heading.text, text: heading.text || "(no title)", on: { click: () => this.jump(heading.from) } }),
        ),
      );
    }
  }
}
