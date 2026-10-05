import { WidgetType } from "@codemirror/view";
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

/** What an image or an anchor looks like while its `{{...}}` source is hidden. */
export class ChipWidget extends WidgetType {
  constructor(
    readonly kind: "image" | "anchor",
    readonly text: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof ChipWidget && other.kind === this.kind && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `cm-zim-chip cm-zim-chip-${this.kind}`;
    // The image icon is drawn in CSS (theme.ts): an emoji would need a system emoji font.
    el.textContent = this.kind === "image" ? this.text : "⚓";
    if (this.kind === "anchor") el.title = this.text;
    return el;
  }
}
