// The Zim editor: CodeMirror 6 over the Zim file text, formatted live from the Rust parser's spans.
// See docs/zim-editor-plan.md for the design.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, keymap } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { insertReference, toggleCheckboxAt } from "./commands";
import { zimKeymap } from "./keymap";
import { decorationsField } from "./decorations";
import { imageAt, linkAt } from "./links";
import type { LinkInfo } from "./links";
import { imageSourceFacet, linkStatusFacet, refreshLinks, setShowMarkup, showMarkupField, syntaxField } from "./syntax";
import type { ImageSource, LinkStatus } from "./syntax";
import { zimTheme } from "./theme";

export { buildDecorations, decorationsField } from "./decorations";
export * as commands from "./commands";
export { zimKeymap } from "./keymap";
export { classifyLink, imageAt, linkAt } from "./links";
export type { LinkInfo, LinkKind } from "./links";
export { imageSourceFacet, linkStatusFacet, refreshLinks, setShowMarkup, showMarkupField, spansOf, syntaxField } from "./syntax";
export type { ImageSource, LinkStatus } from "./syntax";

export interface ZimEditorOptions {
  /** Called after every change to the document. */
  onChange?: (update: ViewUpdate) => void;
  /** Called when the user follows a link (Ctrl/Cmd-click, or any click in a read-only editor). */
  onNavigate?: (link: LinkInfo) => void;
  /**
   * Whether a link's target leads to a page that exists (`"missing"` links are drawn differently).
   * Call `refreshLinks()` on the editor when the answers may have changed.
   */
  linkStatus?: (target: string) => LinkStatus;
  /**
   * The picture behind an image's path as written (`./a.png`), so that images are drawn as pictures;
   * without it they are chips with a name. Call `refreshLinks()` when the answers may have changed
   * (a file arrived, or was added, removed or moved).
   */
  imageSource?: (path: string) => ImageSource;
  /**
   * Files were dropped on the editor, or an image was pasted (a clipboard that holds text too is
   * pasted as text): the host decides what to do with them. `at` is where they were dropped, or the
   * caret. Without this, files are left to the browser.
   */
  onFiles?: (files: File[], at: number) => void;
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
    ...(options.linkStatus ? [linkStatusFacet.of(options.linkStatus)] : []),
    ...(options.imageSource ? [imageSourceFacet.of(options.imageSource)] : []),
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
        // Double-clicking a picture selects its source, which brings the source back to be edited. (On the second
        // press, before the editor selects a word: that would already have swapped the picture for its source.)
        const picture = (event.target as HTMLElement | null)?.closest?.(".cm-zim-image");
        if (picture && event.button === 0 && event.detail >= 2 && !view.state.readOnly) {
          const info = imageAt(view.state, view.posAtDOM(picture));
          if (info) {
            view.dispatch({ selection: { anchor: info.from, head: info.to } });
            event.preventDefault();
            return true;
          }
        }
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
        // A picture is followed as itself, not as whatever touches it.
        const picture = (event.target as HTMLElement | null)?.closest?.(".cm-zim-image");
        const pos = picture ? view.posAtDOM(picture) : view.posAtCoords({ x: event.clientX, y: event.clientY });
        const link = pos === null ? null : picture ? imageAt(view.state, pos) : linkAt(view.state, pos);
        if (!link) return false;
        options.onNavigate?.(link);
        event.preventDefault();
        return true;
      },

    }),
    ...(options.onFiles ? [fileHandlers(options.onFiles)] : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange?.(update);
    }),
    ...(options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    // The Zim keys come first so that Enter, Tab and Backspace reach the list commands before the defaults.
    Prec.high(keymap.of([...zimKeymap])),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ...(options.extensions ?? []),
  ];
}

/** Files pasted (an image, with no text beside it) or dropped become `onFiles`; the rest is the editor's. */
function fileHandlers(onFiles: (files: File[], at: number) => void): Extension {
  const filesOf = (data: DataTransfer | null): File[] => (data ? [...data.files] : []);
  const dragsFiles = (data: DataTransfer | null): boolean => !!data && [...data.types].includes("Files");
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = filesOf(event.clipboardData);
      // A clipboard with text and a picture (a spreadsheet's cells, say) is meant as text.
      if (files.length === 0 || view.state.readOnly || [...(event.clipboardData?.types ?? [])].includes("text/plain")) return false;
      event.preventDefault();
      onFiles(files, view.state.selection.main.head);
      return true;
    },
    dragover(event, view) {
      if (view.state.readOnly || !dragsFiles(event.dataTransfer)) return false;
      event.preventDefault(); // without this the browser would not let the files be dropped here
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      const files = filesOf(event.dataTransfer);
      if (files.length === 0 || view.state.readOnly) return false;
      event.preventDefault(); // (the editor's own way with a dropped file is to read it as text)
      onFiles(files, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head);
      return true;
    },
  });
}

export interface ZimEditor {
  readonly view: EditorView;
  /** The page as it would be saved: exactly the text that was loaded plus the edits made since. */
  getText(): string;
  /** Replace the whole page (the undo history starts over). */
  setText(text: string): void;
  setShowMarkup(show: boolean): void;
  /** Draw the links again (the pages they lead to were added, removed or renamed). */
  refreshLinks(): void;
  /**
   * Put the caret at `position` (a UTF-16 offset). By default the view scrolls to bring it to the
   * top (to land on a heading); `scroll: false` only moves the caret, for opening a page.
   */
  goTo(position: number, options?: { focus?: boolean; scroll?: boolean }): void;
  focus(): void;
  /**
   * Put `text` at position `at`, or in place of the selection, with the caret after it, and focus the
   * editor. A caret in the header, or at the top of the page, is no place: the text goes at the end.
   */
  insert(text: string, at?: number | "end"): void;
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
    refreshLinks() {
      view.dispatch({ effects: refreshLinks.of(null) });
    },
    goTo(position, goOptions = {}) {
      const at = Math.max(0, Math.min(position, view.state.doc.length));
      view.dispatch({ selection: { anchor: at }, ...(goOptions.scroll === false ? {} : { effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 24 }) }) });
      if (goOptions.focus) view.focus();
    },
    focus: () => view.focus(),
    insert(text, at) {
      view.dispatch(insertReference(view.state, text, typeof at === "number" ? Math.min(at, view.state.doc.length) : at));
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
