import type { EditorState, TransactionSpec } from "@codemirror/state";
import { Kind, ListMarker } from "../kinds";
import { spansOf } from "./syntax";

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
