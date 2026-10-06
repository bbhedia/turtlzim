# The notebook app (`web/src/app`, `web/src/notebook`)

The browser app that puts the pieces together: the Zim editor (`web/src/editor`, see
`zim-editor-plan.md`), the notebook rules (`core/zim-notebook` through wasm, see `zim-notebook.md`)
and a place to keep pages. It is the *open notebook* half of roadmap step 4: pages are Zim text kept
in the browser. There is no sync, no account and no encryption in it yet; those come with
`turtl_core` (CLAUDE.md, Open issues #5), and a notebook's `kind` field (`"open"` today) is where
that choice will live.

## What it does

* **Notebooks.** Several, in one browser profile. The first start makes a sample notebook; the
  notebook menu makes an empty one, renames, deletes (the last one deleted is replaced by an empty
  one, so there is always somewhere to write), imports a folder or a zip, and exports a zip.
* **Pages.** A tree of sections and pages (folding, arrow-key navigation, a breadcrumb, Back and
  Forward, an address per page: `#/Projects%3AGarden`), new page and new sub-page, rename (with
  "update the links"), delete, download one page as its `.txt`. Writing is saved by itself 700 ms
  after the last keystroke, at once with Ctrl+S, and when the page is left or hidden.
* **Links.** Ctrl/Cmd-click follows one: to a page (found as Zim finds it), to a heading or anchor
  (the caret goes there), to a web address (only `http`, `https` and `ftp`, in a window with no way
  back to the app). A link to a page that doesn't exist is drawn differently, and following it shows
  the page as a new page would start; it is only *made* when something is typed in it.
* **Backlinks** under every page: the pages whose links lead to it, with the line the first one is on.
* **Search** (`/` focuses it): every word has to be in the page's name or in its text *as a person
  reads it*: `**bold**` is searched as `bold`, `[[Projects:Garden|the garden]]` as `the garden`, a
  heading without its `======`, a code block exactly as written. A snippet shows the words found in
  context, with the same markup left out.
* **A phone-sized screen** gets the tree as a drawer, and the top bar wraps.

## Layers

| Layer | Where | Does |
|---|---|---|
| Rules | `core/zim-notebook` (Rust) | names, link resolution, tree, backlinks, search, rename that keeps links intact |
| Bindings | `core/zim-wasm`, `web/src/notebook-core.ts` | `NotebookModel` (wasm `Notebook`), page names, `plain` text, `newPageText`, paths |
| Store | `web/src/notebook/store.ts`, `idb.ts` | where pages are kept: `MemoryStore`, `IndexedDbStore` |
| Session | `web/src/notebook/session.ts` | an open notebook: the model over a store; every change is written to the store before it is announced |
| Files | `web/src/notebook/zim-files.ts`, `web/src/zip.ts` | `notebook.zim`; folders and zips ⇄ pages |
| App | `web/src/app/` | the interface: tree, dialogs, search, import and export, saving |

The app holds no notebook rules of its own: what a link means, what a rename must rewrite and what
search finds are the Rust ones, so desktop and mobile shells get them unchanged.

## Decisions

1. **A store is replaceable and atomic.** `NotebookStore.replacePages(id, {remove, put})` happens
   entirely or not at all: a rename moves and rewrites many pages, and half of one would lose links.
   `IndexedDbStore` does it in one transaction (an error while queueing aborts it) and checks the
   notebook exists *inside* that transaction. One contract test suite runs against `MemoryStore` and
   `IndexedDbStore`; a store for a folder of `.txt` files (desktop) or encrypted records has to pass
   it too. IndexedDB layout: database `zim-notebooks`, stores `notebooks` (key `id`) and `pages` (key
   `[notebook, pageKey]`, so a notebook is one key range); `pageKey` is the case-folded name.
2. **A page remembers its file.** A byte-order mark and CRLF line endings belong to the file, not
   the page (`PageFile` in `zim-format`); a page is stored with both, and export and download write
   them back, so a notebook that came from Windows goes out as it came in with only the edits
   changed. Mixed line endings are kept raw. Files that aren't UTF-8 are refused, not converted.
3. **Looking at a page does not make it.** A page that doesn't exist (a link's target, a section)
   is shown from a template and exists once it is written in. So following links around never
   litters the notebook.
4. **Saving cannot lose typing.** Writes to the store are asynchronous and serialized (one chain),
   and a failed write is shown ("Not saved", the reason in the status line) while the text stays in
   the editor and the session reads the store back, so what is shown for the notebook is what is
   kept. Because a closing page can be gone before a write finishes, a page that is being left with
   typing not yet in the store also writes it to `localStorage` (`zim:draft`, synchronous), and the
   next start puts it in the notebook, unless the notebook already has the page *newer* than the
   draft (another tab, say) or the draft isn't valid. The browser's "leave this page?" question is
   asked only when the store has refused a write.
5. **Link colours are asked of the rules, from the page they are on.** The editor draws a link to a
   missing page differently (`linkStatusFacet`); the app answers by resolving the target with the
   wasm rules from the open page and re-asks (`refreshLinks`) whenever pages come, go or move, and
   after a rename moves the open page itself.
6. **Search is plain text** (`zim_format::plain_text`, kept next to each page in the model), so
   typing a word finds it even when it is inside `**`, and typing `**` finds nothing. The text
   hidden is exactly what the editor hides when the caret is elsewhere; a code block is shown, so
   it is searched as written.
7. **Import never guesses.** `notebook.zim` marks the notebook's folder (otherwise the folder that
   was picked is dropped from every path); hidden files and folders are ignored; a `.txt` becomes a
   page if its path is a valid page name and it is UTF-8; everything else that is not `notebook.zim`
   is counted as an attachment (not imported yet) and every file that *should* have been a page but
   was not is listed with the reason, in the import dialog, before anything is written. Pages come
   in as a new notebook, or into the open one (the dialog says how many would be replaced).
8. **Zip files, written by us and read from anyone.** The writer stores files uncompressed (short
   enough to verify; pages are small); the reader also inflates (`DecompressionStream`), because
   other programs compress. No Zip64: fewer than 65,535 files and under 4 GB, checked. Every entry's
   size and CRC-32 are checked, and a damaged zip is refused with the entry's name. A zip path is
   never used as a file path: an entry becomes a page only if it is a valid page name (a level that
   starts with a dot, `..` included, is not), so there is nothing to escape from.
9. **No framework.** The interface is about 1,300 lines of DOM code over native elements: `<dialog>`
   (focus trap, Escape and the backdrop for free), `<details>` for the backlinks, `role=tree`,
   `role=combobox` for search. Nothing user-written ever goes through `innerHTML`.
10. **Security.** Only `http`, `https` and `ftp` addresses are opened from a page, with
    `noopener,noreferrer`; `javascript://…` and `file:` links are refused with a message. The
    server's Content-Security-Policy (`script-src 'self' 'wasm-unsafe-eval'`) applies to the whole
    app, and the browser test runs under it, so a violation fails the test.

## What verifies each layer

| Layer | Verified by |
|---|---|
| Rules | `cargo test -p zim-notebook` (49 tests, property tests on random colliding notebooks) and, with `scripts/zim-golden.sh`, Zim's own manual: all 301 links resolve; renames keep every link leading where it did |
| Plain text | `cargo test -p zim-format` (`tests/plain.rs`): every construct, and that what is hidden is hidden by the span model |
| Bindings | `cargo test -p zim-wasm` (8) and `web/test/notebook-core.test.ts` (16) |
| Stores | `web/test/store.test.ts`: the same contract on both stores, including atomicity under failure (`fake-indexeddb`) |
| Session, files, zip | `web/test/session.test.ts` (rename/delete/failed write/export paths/import rules/zip round trips and damage) |
| **The app in Chromium** | `web/test/browser.mjs`: the scenarios below, on the built app, served by the same server `npm run serve` runs |
| How it looks | `npm run screenshots <dir>`: nine screenshots (light, dark, phone, dialogs, search, menu) to look at |

The browser scenarios, each in a fresh profile (so a fresh IndexedDB): the editor (rendering, markup
shown where the caret is, typing, undo, checkbox clicks, shortcuts, list editing, carriage returns,
every real Zim page loaded); starting on the sample; tree and Back/Forward and remembered folding;
the tree by keyboard (focus stays in it); Ctrl-click, anchors and plain names; missing links and
creating a page by typing; backlinks; new page and sub-page with name checks; rename (links follow;
after a reload everything is as renamed; without link updates; refused names); delete; sections;
search; autosave and Ctrl+S across a reload; typing kept when the page closes in the middle of a
write, and an old draft not overwriting a newer page; a failing store; a browser that keeps nothing
(the app runs from memory, says so, and can still export); notebooks (new, switch,
rename, delete, delete the last); download and zip export read back by Python's `zipfile`; import of
a folder with Windows files (BOM, CRLF, mixed endings, a Latin-1 file, case-clashing names, an
invalid name, attachments, hidden files) edited and exported again; import into the open notebook;
**the real Zim manual (81 pages) imported through the file chooser, searched and followed, exported
and every page compared byte for byte, then imported again from our zip and from a deflate zip that
Python made**; links that could run code; deep links; a phone-sized screen.

## Running it

```bash
cd web && npm install && npm run wasm && npm run build
ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm test
scripts/setup-browser.sh                        # once
ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm run test:browser
ONLY="rename" npm run test:browser              # just the scenarios whose name has "rename"
SCREENSHOTS=dir npm run test:browser            # a failing scenario leaves a screenshot of the page in dir
npm run screenshots dir                         # the nine pictures of the app
scripts/serve.sh start --host :: --port 8080    # serve it (docs/zim-editor-plan.md: trying it from another machine)
```

Typing in the browser tests is sent with no pause between keys, as a program does. Put the caret
somewhere and let the editor finish scrolling before typing (`ui.caretTo` does); keys that arrive
while CodeMirror is scrolling a caret into view can land in the middle of it, which no person
typing can reproduce (found as a rare flake, bisected, and the stress loop went from 12 failures in
80 to 0 in 120 with that one change).

## Not done yet

* **Images and attachments** are neither imported nor exported: they are counted in the import
  dialog and left behind. `{{./pictures/a.png}}` stays a chip. Storing them (as blobs beside the
  pages) and resolving `./` against the page's folder is the next layer.
* **Two tabs on one notebook** do not see each other's changes until reload (no `BroadcastChannel`),
  and the last write to a page wins. The draft rule above keeps an old draft from replacing a newer
  page, but two tabs open on the same page can still overwrite each other.
* **No undo for rename and delete** other than exporting first (the delete dialog says so).
* **Persistence is the browser's to give.** `navigator.storage.persist()` is requested, but a browser
  may refuse, and a user can clear site data; export is the backup. Where a profile will not store
  anything (some private windows) the app runs from memory and says so.
* **Not yet Zim features:** journal pages and a calendar, a tag list, a table of contents, templates,
  page properties, the header block hidden (it is shown, dimmed), tables.
* **Everything encrypted, synced or shared** (the point of the project): the store interface is the
  seam; the encrypted kind of notebook, `turtl_core` and the sync server come next (CLAUDE.md, Open
  issues #2, #5, #6).
