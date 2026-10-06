import type { EditorState } from "@codemirror/state";
import { Kind } from "../kinds";
import { classifyLink } from "../notebook-core";
import type { LinkKind } from "../notebook-core";
import { spansOf } from "./syntax";

// What kind of target a link has (a page, a place on this page, an address, a file, an email address,
// an interwiki link) is decided by the notebook rules in Rust, the same ones that resolve it:
// `classifyLink` is those rules, not a second copy of them.
export { classifyLink };
export type { LinkKind };

export interface LinkInfo {
  kind: LinkKind;
  /** The link's target as written (a bare email address gets `mailto:` in front, nothing else is rewritten). */
  target: string;
  /** The text shown for it: the display part, or the target again. */
  label: string;
  /** Where the link's source sits in the document. */
  from: number;
  to: number;
}

/** A bare email address is made a `mailto:` address; anything else is left exactly as written. */
function withMailto(kind: LinkKind, target: string): string {
  return kind === "email" && !/^mailto:/i.test(target) ? `mailto:${target}` : target;
}

/**
 * The link whose source contains `pos`, if any: a `[[link]]`, or a bare URL or email address.
 * Both edges count as inside, like a caret touching it.
 */
export function linkAt(state: EditorState, pos: number): LinkInfo | null {
  const spans = spansOf(state);
  for (let i = spans.length - 1; i >= 0; i--) {
    const from = spans.start(i);
    const to = spans.end(i);
    if (pos < from || pos > to) continue;
    const kind = spans.kind(i);
    if (kind === Kind.AutoUrl || kind === Kind.AutoEmail) {
      const text = state.sliceDoc(from, to);
      const linkKind = classifyLink(text);
      return { kind: linkKind, target: withMailto(linkKind, text), label: text, from, to };
    }
    if (kind === Kind.Link) {
      const t = spans.next(Kind.LinkTarget, i, to);
      const target = t >= 0 ? state.sliceDoc(spans.start(t), spans.end(t)) : "";
      const d = spans.next(Kind.LinkDisplay, i, to);
      const label = d >= 0 ? state.sliceDoc(spans.start(d), spans.end(d)) : target;
      const linkKind = classifyLink(target);
      return { kind: linkKind, target: withMailto(linkKind, target), label, from, to };
    }
  }
  return null;
}
