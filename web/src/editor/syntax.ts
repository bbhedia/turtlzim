import { Facet, StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { highlight } from "../zim";
import type { Spans } from "../spans";

/**
 * The syntax spans of the document, computed by the Rust parser (compiled to wasm) and recomputed
 * whenever the document changes. Offsets are UTF-16 units, which are CodeMirror positions because
 * the editor's line separator is "\n" (see index.ts): the document is the file text, unchanged.
 */
export const syntaxField = StateField.define<Spans>({
  create: (state) => highlight(state.doc.toString()),
  update: (spans, tr) => (tr.docChanged ? highlight(tr.newDoc.toString()) : spans),
});

export function spansOf(state: EditorState): Spans {
  return state.field(syntaxField);
}

/** Show every syntax character, always (the "view source" switch of live preview). */
export const setShowMarkup = StateEffect.define<boolean>();

export const showMarkupField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setShowMarkup)) value = effect.value;
    return value;
  },
});

/** What a link's target turns out to be, as far as drawing it goes. */
export type LinkStatus = "exists" | "missing" | "other";

/**
 * Asks the host whether a `[[link]]`'s target leads to a page that exists, so links to pages that
 * don't can be drawn differently. Without a notebook behind the editor there is no answer, and
 * every link is drawn the same.
 */
export const linkStatusFacet = Facet.define<(target: string) => LinkStatus, ((target: string) => LinkStatus) | undefined>({
  combine: (values) => values[0],
});

/** Dispatch this when the answer of the link-status function may have changed (pages were added, removed or renamed). */
export const refreshLinks = StateEffect.define<null>();
