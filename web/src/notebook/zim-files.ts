// The files around a Zim notebook's pages: `notebook.zim`, the small configuration file that marks
// a folder as a notebook, and how a folder or a zip of files becomes pages.
import { pathToPage } from "../notebook-core";
import type { StoredPage } from "./store";
import { decodePage } from "../zim";

/** The `notebook.zim` of a notebook, as Zim writes one, so that an exported folder opens in Zim. */
export function notebookConfig(info: { title: string; home: string }): string {
  const clean = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
  return [
    "[Notebook]",
    "version=0.4",
    `name=${clean(info.title)}`,
    "interwiki=",
    `home=${clean(info.home)}`,
    "icon=",
    "document_root=",
    "shared=True",
    "endofline=unix",
    "disable_trash=False",
    "profile=",
    "",
  ].join("\n");
}

/** What `notebook.zim` says that matters here: the notebook's name and its home page. */
export function parseNotebookConfig(text: string): { name?: string; home?: string } {
  const found: { name?: string; home?: string } = {};
  let inNotebook = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inNotebook = line === "[Notebook]";
    else if (inNotebook) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (value && key === "name") found.name = value;
        if (value && key === "home") found.home = value;
      }
    }
  }
  return found;
}

export interface ImportedFile {
  /** The path as the browser or zip gives it: `/` between folders. */
  path: string;
  bytes: Uint8Array;
  /** When the file was last changed: ms since the epoch, or a Date. */
  modified?: number | Date;
}

export interface Imported {
  pages: StoredPage[];
  config: { name?: string; home?: string };
  /** Files that did not become pages, and why. */
  skipped: Array<{ path: string; reason: string }>;
  /** Files other than pages and `notebook.zim` (attachments), which aren't imported yet. */
  attachments: number;
}

/**
 * Turn the files of a notebook folder (or of a zip of one) into pages. Where a `notebook.zim` is,
 * that folder is the notebook; otherwise the first folder of every path (the one that was picked)
 * is dropped. Every `.txt` that is a valid page name and valid UTF-8 becomes a page, keeping its
 * byte-order mark and line endings so that it can be written back as it was; the rest is reported,
 * not guessed at.
 */
export function pagesFromFiles(files: ImportedFile[], now = Date.now()): Imported {
  const clean = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^\/+/, "") }));
  const config = clean.filter((f) => f.path === "notebook.zim" || f.path.endsWith("/notebook.zim")).sort((a, b) => a.path.length - b.path.length)[0];
  let prefix = "";
  if (config) prefix = config.path.slice(0, config.path.length - "notebook.zim".length);
  else if (clean.length > 0 && clean.every((f) => f.path.includes("/"))) {
    const first = (clean[0] as ImportedFile).path.split("/")[0] as string;
    if (clean.every((f) => f.path.startsWith(`${first}/`))) prefix = `${first}/`;
  }

  const result: Imported = { pages: [], config: {}, skipped: [], attachments: 0 };
  const seen = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const file of clean) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    if (relative.split("/").some((part) => part.startsWith("."))) continue; // hidden files and folders
    if (relative === "notebook.zim") {
      result.config = parseNotebookConfig(decoder.decode(file.bytes));
      continue;
    }
    if (!relative.endsWith(".txt")) {
      result.attachments++;
      continue;
    }
    let name: string;
    try {
      name = pathToPage(relative);
    } catch (error) {
      result.skipped.push({ path: relative, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let decoded;
    try {
      decoded = decodePage(file.bytes);
    } catch {
      result.skipped.push({ path: relative, reason: "not valid UTF-8, so not a Zim page" });
      continue;
    }
    const key = name.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      result.skipped.push({ path: relative, reason: `has the same name as ${other} (names ignore case)` });
      continue;
    }
    seen.set(key, relative);
    result.pages.push({ name, text: decoded.text, bom: decoded.bom, lineEnding: decoded.lineEnding, modified: file.modified instanceof Date ? file.modified.getTime() : (file.modified ?? now) });
  }
  return result;
}
