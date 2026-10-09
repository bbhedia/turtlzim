// The notebook rules (core/zim-notebook, compiled to wasm), typed: page names, where a link leads,
// the page tree, backlinks, search, and renames that rewrite links. The rules live in Rust so that
// the browser, desktop and mobile shells agree exactly; this file only gives them types and turns
// the JSON they return into objects. `initZim()` must have finished before any of it is used.
import {
  Notebook as WasmNotebook,
  anchorsIn as wasmAnchorsIn,
  checkFilePath as wasmCheckFilePath,
  classifyLink as wasmClassifyLink,
  headingId as wasmHeadingId,
  imagesIn as wasmImagesIn,
  journalDayOf as wasmJournalDayOf,
  journalPage as wasmJournalPage,
  journalPageText as wasmJournalPageText,
  journalTitle as wasmJournalTitle,
  linksIn as wasmLinksIn,
  newPageText as wasmNewPageText,
  pageKey as wasmPageKey,
  pageToPath as wasmPageToPath,
  parsePageName as wasmParsePageName,
  pathToPage as wasmPathToPage,
  relativeFileText as wasmRelativeFileText,
  safeFileName as wasmSafeFileName,
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

/** A tag (`@name`) and the pages that write it. */
export interface TagInfo {
  /** The name without the `@`, as the first page (in name order) that writes it spells it. */
  name: string;
  /** In name order. */
  pages: string[];
}

/** A page that a link being typed can lead to. */
export interface LinkSuggestion {
  page: string;
  /** What to write between the brackets, on the page it was asked from, to lead there. */
  link: string;
  /** Whether the page has text of its own (a section only holds other pages). */
  exists: boolean;
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
  /** How many links and images were rewritten. */
  linksChanged: number;
  /** Every file that moved with the pages (a page's folder holds its attachments), old path to new. */
  filesMoved: Array<[from: string, to: string]>;
}

/** Where a reference to a file (an image's path, a `[[./file]]` link) leads. */
export type ResolvedFile =
  /** A path in the notebook (as the notebook spells it, if there is such a file) and whether there is one. */
  | { kind: "notebook"; path: string; exists: boolean }
  /** Not in the notebook: an absolute path, `~/...`, a drive or share, an address, or above the top. */
  | { kind: "outside" };

/** An `{{image}}` in a text. Offsets are UTF-16 units. */
export interface TextImage {
  start: number;
  end: number;
  /** Where the path text is, which is what is replaced when the image is pointed elsewhere. */
  pathStart: number;
  pathEnd: number;
  path: string;
  /** The `?key=value&flag` tokens as written. */
  query: Array<[key: string, value: string | null]>;
  alt: string | null;
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

/** The value of a parameter of an image (`width`, `height`, `href`, ...), ignoring the case of its name. */
export function imageParam(image: TextImage, key: string): string | undefined {
  const wanted = key.toLowerCase();
  return image.query.find(([k, v]) => k.toLowerCase() === wanted && v !== null)?.[1] ?? undefined;
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

/** A day of the journal: the pages of days are called `Journal:2026:10:09`. */
export interface JournalDay {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

/** The page of a day, or undefined if there is no such day (the notebook's rules: years 1 to 9999, months and days that exist). */
export function journalPage(day: JournalDay): string | undefined {
  assertZimReady();
  return wasmJournalPage(day.year, day.month, day.day) ?? undefined;
}

/** The day a page is the page of (written the way the journal writes it), or undefined if it is not one. */
export function journalDayOf(page: string): JournalDay | undefined {
  assertZimReady();
  const found = wasmJournalDayOf(page);
  return found ? { year: found[0]!, month: found[1]!, day: found[2]! } : undefined;
}

/** What a day is called at the top of its page: `Friday 09 October 2026`. */
export function journalTitle(day: JournalDay): string | undefined {
  assertZimReady();
  return wasmJournalTitle(day.year, day.month, day.day) ?? undefined;
}

/** The text a new page of a day starts with (see `newPageText`). */
export function journalPageText(day: JournalDay, created: string): string | undefined {
  assertZimReady();
  return wasmJournalPageText(day.year, day.month, day.day, created) ?? undefined;
}

/**
 * What a page that doesn't exist yet starts with: the header and a title. The page of a day of the journal
 * has the day as its title, `Friday 09 October 2026`; any other has the last part of its name.
 */
export function startingText(page: string, created: string): string {
  const day = journalDayOf(page);
  return (day && journalPageText(day, created)) || newPageText(page, created);
}

/** The `[[links]]` of a text. */
export function linksIn(text: string): TextLink[] {
  assertZimReady();
  return JSON.parse(wasmLinksIn(text)) as TextLink[];
}

/** The `{{images}}` of a text. */
export function imagesIn(text: string): TextImage[] {
  assertZimReady();
  return JSON.parse(wasmImagesIn(text)) as TextImage[];
}

/**
 * What to call a file that people call `wanted`, so that it is safe to write in a link or an image
 * (no slash, backslash, or any of ? # | [ ] { } < > : * " %, and no leading dot) and never empty.
 */
export function safeFileName(wanted: string): string {
  assertZimReady();
  return wasmSafeFileName(wanted);
}

/** Why `path` can't be the path of a file in a notebook, or undefined if it can. */
export function checkFilePath(path: string): string | undefined {
  assertZimReady();
  return wasmCheckFilePath(path) ?? undefined;
}

/**
 * The text that, written on page `from` as a file reference, leads to the file at `path` (a
 * notebook path): `./a.png` for the page's own folder, `../a.png` for the one above, and so on.
 */
export function relativeFileText(from: string, path: string, dotPrefix = true): string {
  assertZimReady();
  return wasmRelativeFileText(from, path, dotPrefix);
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

  /** The days of a month that have a journal page with text, as day numbers in order. */
  journalDays(year: number, month: number): number[] {
    return [...this.inner.journalDays(year, month)];
  }

  /** Every `@tag` of the notebook with its pages, by name (case ignored). */
  tags(): TagInfo[] {
    return JSON.parse(this.inner.tags()) as TagInfo[];
  }

  /** The pages that write a tag (named with or without the `@`, in any case), in name order. */
  pagesWithTag(tag: string): string[] {
    return this.inner.pagesWithTag(tag);
  }

  /** The tags a page writes, each once, in the order they first appear. */
  tagsOf(page: string): string[] {
    return this.inner.tagsOf(page);
  }

  /** Pages with every word of the query in their name or text, and every `@tag` in it written (see core/zim-notebook). */
  search(query: string, limit = 50): SearchHit[] {
    return JSON.parse(this.inner.search(query, limit)) as SearchHit[];
  }

  /** The pages the link `[[typed` written on page `from` can be completed to, best first (see `Notebook::complete_link`). */
  completeLink(from: string, typed: string, limit = 20): LinkSuggestion[] {
    return JSON.parse(this.inner.completeLink(from, typed, limit)) as LinkSuggestion[];
  }

  // ---- files (attachments): paths only; the bytes are for a store

  /** Record a file at `path` (relative to the notebook, `/` between folders). Throws, with a message to show, if it can't be one. */
  putFile(path: string): void {
    this.inner.putFile(path);
  }

  removeFile(path: string): boolean {
    return this.inner.removeFile(path);
  }

  hasFile(path: string): boolean {
    return this.inner.hasFile(path);
  }

  /** The path of a file as the notebook spells it (paths ignore case), if there is one. */
  filePath(path: string): string | undefined {
    return this.inner.filePath(path) ?? undefined;
  }

  /** Every file, in path order. */
  files(): string[] {
    return this.inner.files();
  }

  get fileCount(): number {
    return this.inner.fileCount();
  }

  /** The files in the folder named like `page`: its attachments. */
  filesOf(page: string): string[] {
    return this.inner.filesOf(page);
  }

  /** The files in that folder and every folder below it: what goes with the page when it is deleted. */
  filesBelow(page: string): string[] {
    return this.inner.filesBelow(page);
  }

  /** Forget the files `filesBelow` lists, and return them. */
  removeFilesBelow(page: string): string[] {
    return this.inner.removeFilesBelow(page);
  }

  /** Where a file reference (an image's path, a `[[./file]]` link) written on page `from` leads. */
  resolveFile(from: string, target: string): ResolvedFile {
    return JSON.parse(this.inner.resolveFile(from, target)) as ResolvedFile;
  }

  /** The path for a new attachment of `page` that people call `wanted`: in the page's folder, with a safe name that is not in use. */
  attachmentPath(page: string, wanted: string): string {
    return this.inner.attachmentPath(page, wanted);
  }

  /** The text that, written on `from` as a file reference, leads to the file at `path`. */
  fileLink(from: string, path: string): string {
    return this.inner.fileLink(from, path);
  }

  /**
   * Move a page and everything below it, and the files in their folders. With `updateLinks`,
   * links and images are rewritten so that every one still leads where it did. Throws an Error with
   * a message ready to show if the rename can't be done (and then changes nothing).
   */
  rename(from: string, to: string, updateLinks = true): RenameReport {
    return JSON.parse(this.inner.rename(from, to, updateLinks)) as RenameReport;
  }
}
