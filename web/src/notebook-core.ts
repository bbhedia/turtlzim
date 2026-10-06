// The notebook rules (core/zim-notebook, compiled to wasm), typed: page names, where a link leads,
// the page tree, backlinks, search, and renames that rewrite links. The rules live in Rust so that
// the browser, desktop and mobile shells agree exactly; this file only gives them types and turns
// the JSON they return into objects. `initZim()` must have finished before any of it is used.
import {
  Notebook as WasmNotebook,
  anchorsIn as wasmAnchorsIn,
  classifyLink as wasmClassifyLink,
  headingId as wasmHeadingId,
  linksIn as wasmLinksIn,
  newPageText as wasmNewPageText,
  pageKey as wasmPageKey,
  pageToPath as wasmPageToPath,
  parsePageName as wasmParsePageName,
  pathToPage as wasmPathToPage,
} from "./zim-wasm/zim_wasm.js";
import { assertZimReady } from "./zim";

export type LinkKind = "page" | "anchor" | "url" | "file" | "email" | "interwiki" | "invalid";

/** Where a link leads. */
export type ResolvedLink =
  | { kind: "page"; page: string; exists: boolean; anchor: string | null }
  | { kind: "anchor"; anchor: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "email"; address: string }
  | { kind: "interwiki"; key: string; page: string }
  | { kind: "invalid"; reason: string };

/** One line of the page tree, in display order. */
export interface TreeNode {
  name: string;
  /** 0 for a page at the top. */
  depth: number;
  /** Whether the page has text; a section that only holds other pages doesn't. */
  hasPage: boolean;
  /** How many pages and sections lie directly below it. */
  children: number;
}

export interface Backlink {
  from: string;
  count: number;
  /** The line holding the first of the links. */
  context: string;
}

export interface SearchHit {
  page: string;
  snippet: string;
  inName: boolean;
}

export interface RenameReport {
  moved: Array<[from: string, to: string]>;
  /** The pages (by their new names) that had links rewritten. */
  rewritten: string[];
  linksChanged: number;
}

/** A `[[link]]` in a text. Offsets are UTF-16 units: positions in the JavaScript string. */
export interface TextLink {
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  target: string;
  display: string | null;
}

/** A place a `[[#id]]` link can lead to. */
export interface TextAnchor {
  id: string;
  at: number;
}

/**
 * The name as the notebook writes it (levels trimmed, underscores as spaces, a leading or trailing
 * colon dropped). Throws an Error whose message is ready to show if it isn't a valid page name.
 */
export function parsePageName(input: string): string {
  assertZimReady();
  return wasmParsePageName(input);
}

/** Like `parsePageName`, but null instead of an exception, with the reason on the side. */
export function checkPageName(input: string): { name: string } | { error: string } {
  try {
    return { name: parsePageName(input) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The key a page is filed under (its name in lower case): two spellings of one page share it. */
export function pageKey(input: string): string {
  assertZimReady();
  return wasmPageKey(input);
}

/** What kind of target a link target is, without a notebook to look in. */
export function classifyLink(target: string): LinkKind {
  assertZimReady();
  return wasmClassifyLink(target) as LinkKind;
}

/** The id a heading has for a `#link` to find it. */
export function headingId(text: string): string {
  assertZimReady();
  return wasmHeadingId(text);
}

/** Where a page is kept in a notebook folder: `Help:Auto Formatting` is `Help/Auto_Formatting.txt`. */
export function pageToPath(page: string): string {
  assertZimReady();
  return wasmPageToPath(page);
}

/** The page a `.txt` file in a notebook folder holds; throws for anything that isn't a page file. */
export function pathToPage(path: string): string {
  assertZimReady();
  return wasmPathToPage(path);
}

/** The text of a new page, as Zim starts one. `created` is a time like `2026-10-06T09:41:03+02:00`. */
export function newPageText(page: string, created: string): string {
  assertZimReady();
  return wasmNewPageText(page, created);
}

/** The `[[links]]` of a text. */
export function linksIn(text: string): TextLink[] {
  assertZimReady();
  return JSON.parse(wasmLinksIn(text)) as TextLink[];
}

/** The headings and `{{id: ...}}` anchors of a text. */
export function anchorsIn(text: string): TextAnchor[] {
  assertZimReady();
  return JSON.parse(wasmAnchorsIn(text)) as TextAnchor[];
}

/** The time as Zim writes a creation date: ISO 8601 with the local offset, to the second. */
export function zimTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

/**
 * A notebook: pages by name, and what follows from them (see core/zim-notebook). It holds the
 * pages in memory and does no storage: whatever keeps pages somewhere feeds them in with `put`.
 * Call `free()` when finished with it.
 */
export class NotebookModel {
  private readonly inner: WasmNotebook;

  constructor() {
    assertZimReady();
    this.inner = new WasmNotebook();
  }

  free(): void {
    this.inner.free();
  }

  /** How many pages have text. */
  get size(): number {
    return this.inner.len();
  }

  /** Set a page's text, creating the page if need be. Throws if the name isn't valid. */
  put(page: string, text: string): void {
    this.inner.put(page, text);
  }

  get(page: string): string | undefined {
    return this.inner.get(page) ?? undefined;
  }

  /** Whether the page has text. */
  has(page: string): boolean {
    return this.inner.has(page);
  }

  /** The page or section called this (ignoring case), spelled as the notebook spells it. */
  find(page: string): string | undefined {
    return this.inner.find(page) ?? undefined;
  }

  /** Remove a page; what lies below it stays. */
  remove(page: string): boolean {
    return this.inner.remove(page);
  }

  /** Remove a page and everything below it. The names removed. */
  removeTree(page: string): string[] {
    return this.inner.removeTree(page);
  }

  /** Every page with text, in name order. */
  names(): string[] {
    return this.inner.names();
  }

  tree(): TreeNode[] {
    return JSON.parse(this.inner.tree()) as TreeNode[];
  }

  /** Where the link `target`, written on page `from`, leads. */
  resolve(from: string, target: string): ResolvedLink {
    return JSON.parse(this.inner.resolve(from, target)) as ResolvedLink;
  }

  /** The shortest link text that, written on `from`, leads to `to`. */
  linkTo(from: string, to: string): string {
    return this.inner.linkTo(from, to);
  }

  backlinks(page: string): Backlink[] {
    return JSON.parse(this.inner.backlinks(page)) as Backlink[];
  }

  search(query: string, limit = 50): SearchHit[] {
    return JSON.parse(this.inner.search(query, limit)) as SearchHit[];
  }

  /**
   * Move a page and everything below it. With `updateLinks`, links are rewritten so that every
   * one still leads where it did. Throws an Error with a message ready to show if the rename
   * can't be done (and then changes nothing).
   */
  rename(from: string, to: string, updateLinks = true): RenameReport {
    return JSON.parse(this.inner.rename(from, to, updateLinks)) as RenameReport;
  }
}
