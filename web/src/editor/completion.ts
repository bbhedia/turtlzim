// Completing a link as it is typed: after `[[`, the pages that the text so far may mean, from the notebook.
// Which pages, in what order, and what to write for each is the notebook's rule (`complete_link` in
// core/zim-notebook); this is how the editor offers them.
import { autocompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";
import { Kind, Opaque } from "../kinds";
import type { LinkSuggestion } from "../notebook-core";
import { spansOf } from "./syntax";

/** A link being typed: its `[[`, and after it up to the caret nothing that ends the target (a bracket, the `|` of the text to show, a `#`). */
const OPEN_LINK = /\[\[[^\[\]|\n#]*$/;

/** The most offered at once. */
const MOST_OFFERED = 20;

/** Whether `pos` is in text that is not for a link to be typed in: a header, a verbatim block or span, an object (the text that follows one is not). */
function inCode(state: EditorState, pos: number): boolean {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) < pos; i++) {
    const kind = spans.kind(i);
    const code = kind === Kind.Header || kind === Kind.VerbatimBlock || kind === Kind.InlineVerbatim || (kind === Kind.Opaque && spans.detail(i) === Opaque.OBJECT);
    if (code && pos < spans.end(i)) return true;
  }
  return false;
}

/** Put `link` where the text typed after `[[` is, and close the brackets (the ones already there, if any, are the ones that close it). */
export function applyLink(view: { state: EditorState; dispatch: (spec: TransactionSpec) => void }, from: number, to: number, link: string): void {
  const closing = /^\]{0,2}/.exec(view.state.sliceDoc(to, to + 2))?.[0].length ?? 0;
  view.dispatch({
    changes: { from, to: to + closing, insert: `${link}]]` },
    selection: { anchor: from + link.length + 2 },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
}

function optionFor(suggestion: LinkSuggestion): Completion {
  const notes = [suggestion.exists ? "" : "section", suggestion.link === suggestion.page ? "" : `[[${suggestion.link}]]`].filter(Boolean);
  return {
    label: suggestion.page,
    type: suggestion.exists ? "page" : "section",
    ...(notes.length ? { detail: notes.join(" · ") } : {}),
    apply: (view, _completion, from, to) => applyLink(view, from, to, suggestion.link),
  };
}

/**
 * What offers pages for the text typed after `[[`: `suggest` is asked for the text so far, and answers best first.
 * Nothing is offered for a bare `[[` until a key is typed after it (or the completion is asked for), nor in a header or code.
 */
export function linkSource(suggest: (typed: string) => LinkSuggestion[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const open = context.matchBefore(OPEN_LINK);
    if (!open || context.state.readOnly || inCode(context.state, open.from)) return null;
    const typed = open.text.slice(2);
    if (typed === "" && !context.explicit) return null;
    const found = suggest(typed).slice(0, MOST_OFFERED);
    if (found.length === 0) return null;
    // A caret in the middle of a link that is closed replaces all of its target (it is one name), up to where it ends.
    // (Without a closing `]]`, `|` or `#` after it the text that follows is not known to be part of it.)
    const rest = /^[^\[\]|\n#]*(?=\]\]|[|#])/.exec(context.state.sliceDoc(context.pos, context.state.doc.lineAt(context.pos).to))?.[0].length ?? 0;
    // (the notebook has put them in the order it wants: they are not filtered or ordered again by what was typed)
    return { from: open.from + 2, to: context.pos + rest, filter: false, options: found.map(optionFor) };
  };
}

export function linkCompletion(suggest: (typed: string) => LinkSuggestion[]): Extension {
  return autocompletion({ override: [linkSource(suggest)], icons: false, maxRenderedOptions: MOST_OFFERED });
}
