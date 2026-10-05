import { Kind } from "./kinds";

/**
 * The syntax spans of a page: a view over the flat array the wasm module returns, four words per
 * span. Offsets are UTF-16 units into the text they were made from, which is also what
 * CodeMirror positions are as long as the document's line separator is "\n" (see editor/).
 *
 * Spans are in pre-order (sorted by start, outer before inner) and nest properly; a Marker's
 * `detail` is the index of the construct that owns it. The full guarantees are documented in
 * core/zim-format/src/highlight.rs.
 */
export class Spans {
  constructor(readonly words: Uint32Array) {}

  get length(): number {
    return this.words.length >>> 2;
  }

  start(i: number): number {
    return this.words[i * 4] as number;
  }

  end(i: number): number {
    return this.words[i * 4 + 1] as number;
  }

  kind(i: number): number {
    return this.words[i * 4 + 2] as number;
  }

  detail(i: number): number {
    return this.words[i * 4 + 3] as number;
  }

  /** The owner of a Marker span (its `detail`). */
  owner(i: number): number {
    return this.detail(i);
  }

  /** Index of the construct that directly contains span `i`, or -1. Linear in the nesting depth. */
  parent(i: number): number {
    for (let j = i - 1; j >= 0; j--) {
      if (this.end(j) >= this.end(i) && this.start(j) <= this.start(i)) return j;
    }
    return -1;
  }

  /**
   * Indices of spans (of `kind`, if given) that contain `pos`, outermost first. Both edges count as
   * inside (start <= pos <= end): a caret touching a construct is in it, which is what live preview
   * needs to reveal its markers. So a construct's own markers are listed too unless `kind` filters
   * them out.
   */
  enclosing(pos: number, kind?: number): number[] {
    const found: number[] = [];
    for (let i = 0; i < this.length && this.start(i) <= pos; i++) {
      if (this.end(i) >= pos && (kind === undefined || this.kind(i) === kind)) found.push(i);
    }
    return found;
  }

  /** Index of the first span of `kind` after `from`, within `until`, or -1. */
  next(kind: number, from: number, until: number): number {
    for (let i = from + 1; i < this.length && this.start(i) < until; i++) {
      if (this.kind(i) === kind) return i;
    }
    return -1;
  }

  isMarker(i: number): boolean {
    return this.kind(i) === Kind.Marker;
  }
}
