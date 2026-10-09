import type { EditorState } from "@codemirror/state";
import { Kind } from "../kinds";
import { classifyLink, imageParam, imagesIn } from "../notebook-core";
import type { LinkKind } from "../notebook-core";
import { spansOf } from "./syntax";

// What kind of target a link has (a page, a place on this page, an address, a file, an email address,
// an interwiki link) is decided by the notebook rules in Rust, the same ones that resolve it:
// `classifyLink` is those rules, not a second copy of them.
export { classifyLink };
export type { LinkKind };

export interface LinkInfo {
  /** What the target is; an `{{image}}` is its own kind, with the path in `target`. */
  kind: LinkKind | "image";
  /** The link's target as written (a bare email address gets `mailto:` in front, nothing else is rewritten). */
  target: string;
  /** The text shown for it: the display part, or the target again (for an image, its alt text or path). */
  label: string;
  /** Where the link's source sits in the document. */
  from: number;
  to: number;
  /** For an image: where its `href` parameter says a click leads, if it has one. */
  href?: string;
}

/** A bare email address is made a `mailto:` address; anything else is left exactly as written. */
function withMailto(kind: LinkKind, target: string): string {
  return kind === "email" && !/^mailto:/i.test(target) ? `mailto:${target}` : target;
}

/** The image whose source is the span `[from, to)`, as something to follow. */
function imageInfo(state: EditorState, from: number, to: number): LinkInfo | null {
  const image = imagesIn(state.sliceDoc(from, to))[0];
  if (!image) return null;
  const href = imageParam(image, "href");
  return { kind: "image", target: image.path, label: image.alt || image.path, from, to, ...(href ? { href } : {}) };
}

/** A link to follow, made from its target as it is written somewhere that is not the page's own text (a cell of a table, drawn as a grid): `from` and `to` say where that is. */
export function linkToFollow(target: string, from: number, to: number): LinkInfo {
  const kind = classifyLink(target);
  return { kind, target: withMailto(kind, target), label: target, from, to };
}

/** The image that starts at `pos` (where a picture drawn in its place sits). */
export function imageAt(state: EditorState, pos: number): LinkInfo | null {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= pos; i++) {
    if (spans.kind(i) === Kind.Image && spans.start(i) === pos) return imageInfo(state, spans.start(i), spans.end(i));
  }
  return null;
}

/**
 * The link whose source contains `pos`, if any: a `[[link]]`, an `{{image}}`, or a bare URL or
 * email address. Both edges count as inside, like a caret touching it.
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
    if (kind === Kind.Image) return imageInfo(state, from, to);
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

/** A tag in the text: its name (without the `@`) and where it is written. */
export interface TagAt {
  name: string;
  from: number;
  to: number;
}

/** The tag whose source contains `pos` (both edges count as inside, like a caret touching it). */
export function tagAt(state: EditorState, pos: number): TagAt | null {
  const spans = spansOf(state);
  for (let i = 0; i < spans.length && spans.start(i) <= pos; i++) {
    if (spans.kind(i) === Kind.Tag && spans.end(i) >= pos) return { name: state.sliceDoc(spans.start(i) + 1, spans.end(i)), from: spans.start(i), to: spans.end(i) };
  }
  return null;
}
