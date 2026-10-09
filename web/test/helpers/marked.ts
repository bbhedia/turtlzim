// Editor states written as text with the selection in it: ¦ is a caret, ⟨…⟩ a selection.
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Extension, StateCommand } from "@codemirror/state";
import { zimExtensions } from "../../src/editor";

export const CARET = "¦";
export const OPEN = "⟨";
export const CLOSE = "⟩";

export function parseMarked(text: string): { doc: string; from: number; to: number } {
  let doc = "";
  let from = -1;
  let to = -1;
  for (const ch of text) {
    if (ch === CARET) from = to = doc.length;
    else if (ch === OPEN) from = doc.length;
    else if (ch === CLOSE) to = doc.length;
    else doc += ch;
  }
  if (from < 0 || to < 0) throw new Error(`no selection in ${JSON.stringify(text)}`);
  return { doc, from, to };
}

export function showMarked(state: EditorState): string {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  if (from === to) return doc.slice(0, from) + CARET + doc.slice(from);
  return doc.slice(0, from) + OPEN + doc.slice(from, to) + CLOSE + doc.slice(to);
}

export function stateOf(marked: string, extra: Extension[] = []): EditorState {
  const { doc, from, to } = parseMarked(marked);
  return EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [zimExtensions(), ...extra] });
}

/** Run `command` on `marked` and show the result in the same notation, or null if it declined. */
export function runMarked(command: StateCommand, marked: string, extra: Extension[] = []): string | null {
  let state = stateOf(marked, extra);
  let ran = false;
  const handled = command({
    state,
    dispatch: (tr) => {
      ran = true;
      state = tr.state;
    },
  });
  return handled && ran ? showMarked(state) : handled ? showMarked(state) : null;
}
