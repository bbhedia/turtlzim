import { StateEffect, StateField } from "@codemirror/state";
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
