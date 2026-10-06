import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { ListMarker } from "../kinds";

/** The glyph and a name for each checkbox state (the `detail` of a ListMarker span). */
const CHECKBOXES: Record<number, { name: string; glyph: string; label: string }> = {
  [ListMarker.UNCHECKED]: { name: "open", glyph: "☐", label: "to do" },
  [ListMarker.CHECKED]: { name: "done", glyph: "☑", label: "done" },
  [ListMarker.XCHECKED]: { name: "dropped", glyph: "☒", label: "dropped" },
  [ListMarker.MIGRATED]: { name: "moved", glyph: "▶", label: "moved to another page" },
  [ListMarker.TRANSMIGRATED]: { name: "moved-back", glyph: "◀", label: "moved back" },
};

export function isCheckbox(markerDetail: number): boolean {
  return markerDetail in CHECKBOXES;
}

export class BulletWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-zim-bullet";
    el.textContent = "•";
    return el;
  }
}

/** A checkbox in place of `[ ] `. Clicking it is handled by the editor (see index.ts). */
export class CheckboxWidget extends WidgetType {
  constructor(readonly state: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CheckboxWidget && other.state === this.state;
  }

  toDOM(): HTMLElement {
    const box = CHECKBOXES[this.state] ?? CHECKBOXES[ListMarker.UNCHECKED]!;
    const el = document.createElement("span");
    el.className = `cm-zim-checkbox cm-zim-checkbox-${box.name}`;
    el.textContent = box.glyph;
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", this.state === ListMarker.CHECKED ? "true" : "false");
    el.setAttribute("aria-label", box.label);
    return el;
  }

  // Let the editor see mouse presses on the box: the click handler in index.ts toggles it.
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}

export class RuleWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof RuleWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-zim-rule";
    return el;
  }
}

/**
 * What an anchor looks like while its `{{id: ...}}` source is hidden, and what an image looks like
 * when it can't be drawn as a picture: `state` says why (`loading`, `missing`, `outside`,
 * `unsupported`), and `title` is the explanation shown on hover.
 */
export class ChipWidget extends WidgetType {
  constructor(
    readonly kind: "image" | "anchor",
    readonly text: string,
    readonly state = "",
    readonly title = "",
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof ChipWidget && other.kind === this.kind && other.text === this.text && other.state === this.state && other.title === this.title;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `cm-zim-chip cm-zim-chip-${this.kind}${this.state ? ` cm-zim-chip-${this.state}` : ""}`;
    // The image icon is drawn in CSS (theme.ts): an emoji would need a system emoji font.
    el.textContent = this.kind === "image" ? this.text : "⚓";
    if (this.kind === "anchor") el.title = this.text;
    else if (this.title) el.title = this.title;
    return el;
  }
}

/** The pixels in an image's `width` or `height` parameter, if it is a plain number of them. */
function pixels(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,5}$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
}

/**
 * A picture in place of the `{{./a.png?width=300|alt}}` that names it. The size is the picture's
 * own unless `width` or `height` say otherwise (one of them keeps the shape), and never wider than
 * the page. Clicks are left to the editor, which puts the caret beside it; Ctrl-click follows it.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    /** The path as written, shown on hover. */
    readonly path: string,
    readonly alt: string,
    readonly width: string | undefined,
    readonly height: string | undefined,
    /** Whether it has an `href` (a click with Ctrl goes there, and the pointer says so). */
    readonly linked: boolean,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.path === this.path &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height &&
      other.linked === this.linked
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = `cm-zim-image${this.linked ? " cm-zim-image-linked" : ""}`;
    img.src = this.url;
    img.alt = this.alt || this.path;
    img.title = this.alt ? `${this.alt} (${this.path})` : this.path;
    img.draggable = false; // a picture must not be dragged out of the text by accident
    img.decoding = "async";
    const [width, height] = [pixels(this.width), pixels(this.height)];
    if (width !== undefined) img.style.width = `${width}px`;
    if (height !== undefined) img.style.height = `${height}px`;
    if (width !== undefined && height === undefined) img.style.height = "auto";
    if (height !== undefined && width === undefined) img.style.width = "auto";
    // The picture's size is known only once it has loaded: let the editor measure the line again.
    img.addEventListener("load", () => view.requestMeasure());
    return img;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
