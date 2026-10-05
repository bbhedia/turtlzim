// Test helpers shared by the unit tests and the browser test.
import { readFileSync, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { Kind } from "../src/kinds";
import type { Spans } from "../src/spans";

const DELIMITERS: Record<number, [string, string]> = {
  [Kind.Bold]: ["**", "**"],
  [Kind.Italic]: ["//", "//"],
  [Kind.Underline]: ["__", "__"],
  [Kind.Strike]: ["~~", "~~"],
  [Kind.InlineVerbatim]: ["''", "''"],
  [Kind.Superscript]: ["^{", "}"],
  [Kind.Subscript]: ["_{", "}"],
  [Kind.Link]: ["[[", "]]"],
  [Kind.Image]: ["{{", "}}"],
  [Kind.Anchor]: ["{{id:", "}}"],
};

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * What is wrong with `spans` as a description of `text`, or null: the guarantees of
 * core/zim-format/src/highlight.rs, re-checked on this side of the wasm boundary (offsets are
 * UTF-16 units that must not split a surrogate pair, the list is in pre-order and properly
 * nested, every marker is a direct child of its owner, and each kind has its delimiters).
 */
export function spanProblem(text: string, spans: Spans): string | null {
  const open: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const [a, b, kind, detail] = [spans.start(i), spans.end(i), spans.kind(i), spans.detail(i)];
    const where = `span ${i} (kind ${kind}) ${a}..${b} ${JSON.stringify(text.slice(a, b))}`;
    if (!(a < b && b <= text.length)) return `${where}: empty or out of bounds (text has ${text.length} units)`;
    for (const edge of [a, b]) {
      if (edge > 0 && edge < text.length && isHigh(text.charCodeAt(edge - 1)) && isLow(text.charCodeAt(edge))) {
        return `${where}: splits a surrogate pair at ${edge}`;
      }
    }
    if (i > 0) {
      const [pa, pb] = [spans.start(i - 1), spans.end(i - 1)];
      if (!(pa < a || (pa === a && pb >= b))) return `${where}: not in pre-order`;
    }
    while (open.length && spans.end(open[open.length - 1] as number) <= a) open.pop();
    const top = open[open.length - 1];
    if (top !== undefined && b > spans.end(top)) return `${where}: partly overlaps span ${top}`;
    if (kind === Kind.Marker && (detail >= i || top !== detail)) return `${where}: not a direct child of its owner`;
    open.push(i);

    const slice = text.slice(a, b);
    const delimiters = DELIMITERS[kind];
    if (delimiters && !(slice.length >= delimiters[0].length + delimiters[1].length && slice.startsWith(delimiters[0]) && slice.endsWith(delimiters[1]))) {
      return `${where}: missing its delimiters ${JSON.stringify(delimiters)}`;
    }
    if (kind === Kind.Heading && (/\n/.test(slice) || !/^=+ .* =+$/.test(slice))) return `${where}: not a heading line`;
    if (kind === Kind.ListItem && /\n/.test(slice)) return `${where}: a list item spans lines`;
    if (kind === Kind.Tag && !slice.startsWith("@")) return `${where}: a tag without its @`;
  }
  return null;
}

/** Every `*.txt` file below the directories named by ZIM_GOLDEN_DIR, or [] when it isn't set. */
export function corpusFiles(): string[] {
  const dirs = (process.env.ZIM_GOLDEN_DIR ?? "").split(delimiter).filter(Boolean);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".txt")) files.push(join(dir, entry.name));
    }
  };
  dirs.forEach(walk);
  return files;
}

/** The text of a corpus file, or null when it isn't valid UTF-8 (such a file can't be a page). */
export function readPage(file: string): string | null {
  const bytes = readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** One line per span, like core/zim-format/tests/highlight.rs's `dump`. */
export function dump(text: string, spans: Spans): string[] {
  const names = Object.fromEntries(Object.entries(Kind).map(([name, code]) => [code, name]));
  const lines: string[] = [];
  for (let i = 0; i < spans.length; i++) {
    const slice = JSON.stringify(text.slice(spans.start(i), spans.end(i)));
    const kind = spans.kind(i);
    if (kind === Kind.Marker) lines.push(`Marker(${names[spans.kind(spans.owner(i))]}) ${slice}`);
    else lines.push(`${names[kind]} ${slice}${spans.detail(i) ? ` #${spans.detail(i)}` : ""}`);
  }
  return lines;
}
