// The files around a Zim notebook's pages: `notebook.zim`, the small configuration file that marks
// a folder as a notebook, and how a folder or a zip of files becomes pages.
import { NotebookModel, pathToPage } from "../notebook-core";
import { typed } from "./media";
import type { StoredFile, StoredPage } from "./store";
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
  /** The contents, for the files that have to be read to be understood: pages and `notebook.zim`. */
  bytes?: Uint8Array;
  /** The file itself, for attachments: it is not read until it is stored. (`bytes` do as well.) */
  blob?: Blob;
  /** When the file was last changed: ms since the epoch, or a Date. */
  modified?: number | Date;
}

export interface Imported {
  pages: StoredPage[];
  /** The attachments: every other file that is not hidden and not `notebook.zim`. */
  files: StoredFile[];
  config: { name?: string; home?: string };
  /** Files that did not become pages or attachments, and why. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Whether the importer has to read this file to understand it (rather than keep it as it is). */
export function isReadToImport(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "notebook.zim" || name.endsWith(".txt");
}

/**
 * Turn the files of a notebook folder (or of a zip of one) into pages. Where a `notebook.zim` is,
 * that folder is the notebook; otherwise the first folder of every path (the one that was picked)
 * is dropped. Every `.txt` that is a valid page name and valid UTF-8 becomes a page, keeping its
 * byte-order mark and line endings so that it can be written back as it was. Every other file that
 * isn't hidden becomes an attachment at its path (the folder named like a page holds that page's
 * attachments), unless its path can't be a file in a notebook or another file has the same path
 * ignoring case. What isn't taken in is reported, not guessed at.
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

  const result: Imported = { pages: [], files: [], config: {}, skipped: [] };
  const seen = new Map<string, string>();
  const seenFiles = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  // The notebook rules say which paths can be files together (not a path that is both a file and a folder, nor a name Zim would read as a page).
  const rules = new NotebookModel();
  try {
    readFiles();
  } finally {
    rules.free();
  }
  return result;

  function readFiles(): void {
    for (const file of clean) {
      if (!file.path.startsWith(prefix)) continue;
      const relative = file.path.slice(prefix.length);
      if (relative.split("/").some((part) => part.startsWith("."))) continue; // hidden files and folders
      if (relative === "notebook.zim") {
        if (file.bytes) result.config = parseNotebookConfig(decoder.decode(file.bytes));
        continue;
      }
      if (!relative.endsWith(".txt")) {
        const key = relative.toLowerCase();
        const other = seenFiles.get(key);
        if (other !== undefined) {
          result.skipped.push({ path: relative, reason: `has the same name as ${other} (names ignore case)` });
          continue;
        }
        try {
          rules.putFile(relative);
        } catch (error) {
          result.skipped.push({ path: relative, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        seenFiles.set(key, relative);
        const blob = file.blob ?? new Blob([(file.bytes ?? new Uint8Array()) as BlobPart]);
        result.files.push({ path: relative, blob: typed(blob, relative), modified: file.modified instanceof Date ? file.modified.getTime() : (file.modified ?? now) });
        continue;
      }
      if (!file.bytes) {
        result.skipped.push({ path: relative, reason: "was not read" });
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
  }
}
