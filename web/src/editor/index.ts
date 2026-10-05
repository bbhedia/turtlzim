// The Zim editor: CodeMirror 6 over the Zim file text, formatted live from the Rust parser's spans.
// See docs/zim-editor-plan.md for the design.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, keymap } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { toggleCheckboxAt } from "./commands";
import { decorationsField } from "./decorations";
import { linkAt } from "./links";
import type { LinkInfo } from "./links";
import { setShowMarkup, showMarkupField, syntaxField } from "./syntax";
import { zimTheme } from "./theme";

export { buildDecorations, decorationsField } from "./decorations";
export { classifyLink, linkAt } from "./links";
export type { LinkInfo, LinkKind } from "./links";
export { setShowMarkup, showMarkupField, spansOf, syntaxField } from "./syntax";

export interface ZimEditorOptions {
  /** Called after every change to the document. */
  onChange?: (update: ViewUpdate) => void;
  /** Called when the user follows a link (Ctrl/Cmd-click, or any click in a read-only editor). */
  onNavigate?: (link: LinkInfo) => void;
  /** Keep every syntax character visible (the default is live preview). */
  showMarkup?: boolean;
  /**
   * Treat only "\n" as a line break, so a "\r" in the text stays a character of the page. Needed
   * for text that contains one (a file with mixed line endings, see `PageFile`); `createZimEditor`
   * sets it itself. Otherwise CodeMirror's default applies, which also turns line endings in
   * pasted text into "\n" (a page file is edited as "\n" text and its `\r\n` restored on save).
   */
  exactLineBreaks?: boolean;
  /** Browse instead of edit: no changes, and a plain click follows links. */
  readOnly?: boolean;
  /** More extensions, added last (so they can override keys). */
  extensions?: Extension[];
}

/**
 * The extensions that make a CodeMirror editor a Zim editor. Use these directly to embed Zim
 * editing in a view of your own; `createZimEditor` is the same thing with a view around it.
 *
 * The document is the page text, byte for byte. By default CodeMirror turns "\r\n" and a lone
 * "\r" into "\n" when it reads text, which would silently rewrite a page that contains one, so
 * for such text (and only such text) `exactLineBreaks` makes "\n" the only line break.
 */
export function zimExtensions(options: ZimEditorOptions = {}): Extension[] {
  return [
    ...(options.exactLineBreaks ? [EditorState.lineSeparator.of("\n")] : []),
    syntaxField,
    showMarkupField.init(() => options.showMarkup ?? false),
    decorationsField,
    zimTheme,
    history(),
    drawSelection(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      // A click on a checkbox widget toggles it (Shift-click: dropped instead of done).
      mousedown(event, view) {
        const box = (event.target as HTMLElement | null)?.closest?.(".cm-zim-checkbox");
        if (!box || event.button !== 0 || view.state.readOnly) return false;
        const spec = toggleCheckboxAt(view.state, view.posAtDOM(box), event.shiftKey);
        if (!spec) return false;
        view.dispatch(spec);
        event.preventDefault();
        return true;
      },
      click(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey || view.state.readOnly)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const link = pos === null ? null : linkAt(view.state, pos);
        if (!link) return false;
        options.onNavigate?.(link);
        event.preventDefault();
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange?.(update);
    }),
    ...(options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ...(options.extensions ?? []),
  ];
}

export interface ZimEditor {
  readonly view: EditorView;
  /** The page as it would be saved: exactly the text that was loaded plus the edits made since. */
  getText(): string;
  /** Replace the whole page (the undo history starts over). */
  setText(text: string): void;
  setShowMarkup(show: boolean): void;
  focus(): void;
  destroy(): void;
}

/** Make a Zim editor in `parent`. `initZim()` (or `initZimSync`) must have finished first. */
export function createZimEditor(parent: HTMLElement, doc = "", options: ZimEditorOptions = {}): ZimEditor {
  const stateFor = (text: string, showMarkup: boolean | undefined): EditorState =>
    EditorState.create({
      doc: text,
      extensions: zimExtensions({ ...options, showMarkup: showMarkup ?? false, exactLineBreaks: text.includes("\r") }),
    });
  const view = new EditorView({ parent, state: stateFor(doc, options.showMarkup) });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.setState(stateFor(text, view.state.field(showMarkupField)));
    },
    setShowMarkup(show) {
      view.dispatch({ effects: setShowMarkup.of(show) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
