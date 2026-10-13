# The notebook app (`web/src/app`, `web/src/notebook`)

The browser app that puts the pieces together: the Zim editor (`web/src/editor`, see
`zim-editor-plan.md`), the notebook rules (`core/zim-notebook` through wasm, see `zim-notebook.md`)
and a place to keep pages. A notebook is either **open** (Zim text kept in the browser's IndexedDB:
this document) or **encrypted** (kept as ciphertext by the Turtl core, unlocked with a passphrase:
`zim-encrypted-notebooks.md`); a notebook's `kind` field says which. There is no sync and no account
yet (CLAUDE.md, Open issues #5).

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
* **Contents** (a list in the sidebar): the headings of the page that is open, as a person reads them
  (no `======`, no `**`), indented by level; a click takes the caret to one. It follows what is typed.
* **Journal and calendar** (a calendar in the sidebar, Monday first): a day's page is `Journal:YYYY:MM:DD`
  (`zim-notebook.md`); the days that have one are in bold with a dot, today is outlined, the open page's day is
  filled. A click on a day opens its page (a day with none is shown as a new page: it starts with the day as its
  title, and is only made when something is written in it); **Today**, and *Today's journal* in the notebook
  menu, open today's.
* **Tags** (a list in the sidebar, closed until opened): every `@tag` of the notebook with the number of pages
  that write it. A click on one, or a Ctrl-click on a tag in a page, shows the pages that have it as search
  results; the search takes `@tag` words (a tag exactly) together with ordinary ones. The list shows the first
  500 (a page can write thousands, and the list is drawn again when a save changed it) and says how many more
  there are; those are found by the search. It is not drawn again when a save changed none of it.
* **Completing a link**: type `[[` and a letter or two of a page's name; Enter writes the shortest link that
  leads there from the page you are on (`zim-editor-plan.md`).
* **Tables**: drawn as a grid, written as lines with a toolbar while the caret is in them; the **Table**
  button makes one (`zim-editor-plan.md`).
* **The page's header** (Zim's `Content-Type`, `Wiki-Format`, `Creation-Date` lines) is folded into one line, as Zim hides it; a press on the
  line shows it. **On a narrow screen** the page's actions (Rename, New sub-page, Attach…, Table, Download, Delete) are behind one button (`⋯`) that opens
  them over the page, which puts the page's title in the upper third of a phone's first screen instead of the middle.
* **Formatting bar** (under the page): buttons for what the keys do (bold, lists, headings, links, tables, undo,
  attach), shown while writing on a touch screen, or from the notebook menu (*Show the formatting bar*) on any.
  On a phone the layout follows the part of the screen that the keyboard leaves, a tap follows a link while a page is
  read and places the caret while it is written, and what is tapped is 44 pixels or more (`zim-editor-plan.md`,
  *Writing on a phone*).
* **Backlinks** under every page: the pages whose links lead to it, with the line the first one is on.
* **Search** (`/` focuses it): every word has to be in the page's name or in its text *as a person
  reads it* (and every `@tag` in the query has to be written, exactly): `**bold**` is searched as `bold`, `[[Projects:Garden|the garden]]` as `the garden`, a
  heading without its `======`, a code block exactly as written. A snippet shows the words found in
  context, with the same markup left out.
* **Attachments and pictures.** A page's attachments live in the folder named like it, as in Zim
  (`Usage/GTD_flowchart.png` belongs to the page `Usage`). Attach files with the **Attach…** button,
  by dropping them on the page (where they land, the reference goes there; elsewhere on the page, at
  the end) or by pasting a picture (a clipboard that also holds text is pasted as text). A picture
  is referred to as `{{./name.png}}` and drawn in the page, at its own size or the `width` and
  `height` given; any other file as `[[./name.pdf|name.pdf]]`. Ctrl-click a picture to see it large
  (or follow its `href`), double-click it to bring its source back; Ctrl-click a link to a file to
  download it. A panel under the page lists its attachments, with thumbnails, and inserts,
  downloads and deletes them. Attachments go with their page when it is renamed or deleted, and in
  and out with import and export.
* **Encrypted notebooks.** New notebook (or Import) can make one; they are listed with the open ones
  and behave the same, but are kept as ciphertext, need a passphrase, and are locked away with the
  Lock button (see `zim-encrypted-notebooks.md` for how, what it protects, and its limits).
* **A phone-sized screen** gets the tree (with the lists below it) as a drawer, and the top bar wraps; while the
  text is being written in, on a touch screen, the search row goes (the room is for the text). A touch screen on its
  side and short (512 pixels or less: a phone) starts with the tree closed, puts it away when a page is chosen, and
  with the keyboard up shows only the text and the formatting bar (`compactScreen` in `app.ts`).
* **What is remembered** about the lists: whether Contents, Calendar and Tags are open (`zim:panel:*` in
  `localStorage`: a setting of the app, not of a notebook), and whether the formatting bar was asked for or put away
  (`zim:formatbar`). In an encrypted notebook the lists show its
  headings, days and tags while it is open and are emptied when it is locked, like everything else on the screen
  (`isPrivate`; the scan of the browser's files covers a heading, a table cell, a day's page and its text, a tag and
  a link being completed).

## Layers

| Layer | Where | Does |
|---|---|---|
| Rules | `core/zim-notebook` (Rust) | names, link resolution, file references (`files.rs`), tree, backlinks, search (with tags), the journal's days, link completion, rename that keeps links and file references intact |
| Bindings | `core/zim-wasm`, `web/src/notebook-core.ts` | `NotebookModel` (wasm `Notebook`), page names, `plain` text, `newPageText`, paths |
| Store | `web/src/notebook/store.ts`, `idb.ts` | where pages are kept: `MemoryStore`, `IndexedDbStore` |
| Encrypted store | `web/src/vault/` | `TurtlStore` (a store over the Turtl core in a Worker), the `Vault` that a passphrase unlocks: `zim-encrypted-notebooks.md` |
| Router | `web/src/notebook/routed-store.ts` | open and encrypted notebooks as one list (encrypted ids start with `vault:`; nothing of them is there while the vault is locked) |
| Session | `web/src/notebook/session.ts` | an open notebook: the model over a store; every change is written to the store before it is announced |
| Files | `web/src/notebook/zim-files.ts`, `media.ts`, `web/src/zip.ts` | `notebook.zim`; folders and zips ⇄ pages and attachments; media types |
| Pictures | `web/src/notebook/file-urls.ts`, `web/src/editor/` | object URLs for stored pictures; the editor draws `{{images}}` from them |
| App | `web/src/app/` | the interface: tree, the lists beside it (`contents.ts`, `calendar.ts`, `tags.ts`), dialogs, search, import and export, saving |
| On the device | `web/pwa/sw.js`, `web/src/pwa/`, `web/scripts/pwa.mjs`, `web/public/` | the service worker that saves the app and pins its files, its registration and the offers of a new version, the manifest and icons: `zim-pwa.md` |

The app holds no notebook rules of its own: what a link means, what a rename must rewrite and what
search finds are the Rust ones, so desktop and mobile shells get them unchanged.

## Decisions

1. **A store is replaceable and atomic.** `NotebookStore.replacePages(id, {remove, put, files})`
   happens entirely or not at all: a rename moves and rewrites many pages and moves their files, and
   half of one would lose links. `IndexedDbStore` does it in one transaction (an error while queueing
   aborts it) and checks the notebook exists *inside* that transaction. One contract test suite runs
   against `MemoryStore` and `IndexedDbStore`; a store for a folder of `.txt` files (desktop) or
   encrypted records has to pass it too. IndexedDB layout: database `zim-notebooks`, stores
   `notebooks` (key `id`), `pages` (key `[notebook, pageKey]`, so a notebook is one key range) and
   `files` (key `[notebook, lower-case path]`); `pageKey` is the case-folded name.
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
   page if its path is a valid page name and it is UTF-8; every other file that is not `notebook.zim`
   becomes an attachment at its path (a folder named like a page holds that page's), unless its path
   can't be a file or differs from another's only in case. Whatever is not taken in is listed with the
   reason, in the import dialog, before anything is written. Attachments from a folder are not read
   into memory until they are stored. Everything comes in as a new notebook, or into the open one
   (the dialog says how many pages and files would be replaced).
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
11. **Attachments are Blobs beside the pages.** The store keeps each file as a `Blob` under its
    notebook path (IndexedDB version 2 adds the `files` store; an older database is upgraded in
    place), `listFiles` says what there is without reading bytes, and one atomic change covers pages
    and files: *moves* first (a rename moves a folder with its pages; the bytes stay with each file),
    then removals, then writes. The rules know only paths; where a reference leads, what a new
    attachment is called, and what a rename must rewrite are in Rust (`zim-notebook`, `files.rs`).
    In IndexedDB a moved file is written again **from its bytes, read into memory before the transaction** (a rename reads the page's
    attachments once; one that can't be read is moved as it was, and one that changed meanwhile is written as the transaction reads it):
    written from the Blob that the database handed out, WebKit failed to draw the picture in 6 renames of 42 (`zim-editor-plan.md`, *Other engines*).
12. **An attachment can't run.** A notebook can come from anywhere, so a file in it is treated as
    hostile. Pictures (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG) are shown only in an `<img>`,
    where not even an SVG can run a script, and the large view is an `<img>` in a dialog; every other
    file is *downloaded*, never opened as a page (an attached `.html` or `.svg` page would run in
    the app's own origin). A picture outside the notebook (`https://…`, `/etc/…`) is never loaded:
    a page could otherwise report that you read it.
    **An SVG's address is a `data:` address, not a `blob:` one.** The address of a picture can also
    be opened as a page of its own (the browser's "Open image in new tab", dragging a picture onto
    the tab strip), and an SVG opened like that is a document that runs its scripts *as the site that
    made the address*: found by an adversarial review, and reproduced (an SVG whose script opened
    the database the notebooks are kept in did so, from a new tab). A `blob:` address belongs to this
    site; a `data:` address has no site to run as, so the same SVG's script is refused the database.
    Other pictures are images whatever they hold, and keep the cheaper `blob:` address
    (`pictureAddress`). The browser test opens every address a picture is given in a new tab.
13. **Changes to a notebook happen one at a time.** A change decides things (a free name for a
    file, which pages a rename moves) and then waits for the store; another change in between would
    make that decision untrue. Two files attached at the same moment, or a rename that arrives while
    a file is being stored, used to end with two files on one name, or a file in a folder that had
    moved. The session runs every change after the one before it; several files attached together
    are stored in *one* write (all or none); closing a session lets what it is doing finish and
    refuses anything asked after that; and attaching files is bound to the notebook and the page it
    started on, whatever the person opens meanwhile.
14. **A file dropped anywhere is not shown by the browser.** The page takes any dropped file as an
    attachment (the editor takes those dropped on the text, and says where), and the window refuses
    the rest, so a slip of the mouse cannot make the browser leave the app for a file.
15. **Nothing goes above the header.** With no caret placed (a page just opened), a reference
    to a new attachment is added at the end of the page, on a line of its own, not at position 0: that
    would be above the header block, which would then no longer be one. This holds for a page with
    carriage returns in it too (the parser sees no header there; the page's own first lines are
    recognized instead).
16. **An upgrade of the stored data waits politely.** Opening the database in a newer version waits
    for every other tab that has it open to let go. This version lets go as soon as it is asked, and
    says so ("reload this page"); a tab that opens the app while an older tab still holds the database
    says why it is waiting, and goes on when that tab is closed or reloaded.

17. **An encrypted notebook leaves nothing in the browser's own places.** The address, the tab's
    title, `history.state`, `localStorage` (drafts, folded sections) and translation all carry page
    names or text, and the browser keeps them. While an encrypted notebook is open the app keeps
    each of them blank (`App.isPrivate`, `locate()`): the history entries hold a number and the names
    stay in memory. A browser test scans IndexedDB, both storages, the Cache API and every private
    file after a notebook with distinctive contents (accented, Chinese and emoji text too, and what
    was typed in the search box and in dialogs that were given up) has been written and locked, and
    again after locks that were not the ordinary kind (typing that could not be saved, a question left
    open). A lock leaves nothing of the notebook on the screen either: the status line and notices are
    cleared, and the app is hidden while it happens and when the browser keeps the page away.
18. **Open and encrypted notebooks are one list, from two stores.** `RoutedStore` sends each request
    to the store its id belongs to; an encrypted notebook's id starts with `vault:` (ids of open ones
    are UUIDs, so they can't). While the vault is locked its notebooks aren't listed at all and any
    request for one is refused (a rejected promise, not a thrown error: a test found one that threw).
19. **The app has to start on any address.** `crypto.randomUUID()` exists only on secure pages, and
    the app used to fail to start on `http://192.168.10.10:8080` because of it (found by the test
    that opens it there for the encrypted notebooks). Notebook ids now come from `getRandomValues`.
    Only encrypted notebooks need a secure page.

## What verifies each layer

| Layer | Verified by |
|---|---|
| Rules | `cargo test -p zim-notebook` (unit tests, and property tests on random colliding notebooks with files and every style of reference) and, with `scripts/zim-golden.sh`, Zim's own manual: all 301 links and 25 image references resolve; renames keep every one leading where it did |
| Plain text | `cargo test -p zim-format` (`tests/plain.rs`): every construct, and that what is hidden is hidden by the span model |
| Bindings | `cargo test -p zim-wasm` and `web/test/notebook-core.test.ts` (also run against the real manual) |
| Stores | `web/test/store.test.ts`: the same contract on both stores, including files, moves (swaps, case-only), atomicity under failure, and opening a database made before files existed (`fake-indexeddb`); and that a moved file is written from bytes of its own (a spy on what IndexedDB hands out and what is put), that one that can't be read is moved as it is, and that one that changed is not overwritten with the old bytes |
| Session, files, zip | `web/test/session.test.ts` (rename/delete/failed write/export paths/import rules/zip round trips and damage; attachments through rename, delete and export; Zim's manual in and out, every file byte for byte) |
| The app on the device | `zim-pwa.md` (what verifies what): `web/test/pwa-worker.test.ts` (the worker, in a pretend browser), `pwa-page.test.ts`, `pwa-build.test.ts`, and the scenarios "The app on the device" in `browser.mjs` |
| Encrypted notebooks | `zim-encrypted-notebooks.md` (what verifies what); `web/test/{vault,engine-failures,cut-off,turtl-store,routed-store}.test.ts`, `store.test.ts` (the shared contract), `vault-browser.mjs` (`npm run test:vault`) |
| Contents, calendar, tags, link completion | `cargo test -p zim-notebook` (`tags`, `journal`, `complete`), `web/test/zim-features.test.ts` (the shapes across wasm, the calendar against the browser's own dates for every day of two centuries, headings as people read them, the completion source and what choosing writes), and in Chromium the scenarios "the contents list…", "the calendar marks…", "tags are listed…", "a link is completed…" |
| Tables | `cargo test -p zim-format` (`tests/table.rs`: reading, escapes, every edit, byte-exact round trip), `web/test/tables.test.ts` (where the caret is, each edit and where the caret goes, Tab/Enter/arrows, insert, how a table is drawn and when), and in Chromium "a table is drawn as a grid…", "in a table Tab…", "the toolbar of a table…", "the Table button…" |
| Writing on a phone | `web/test/format-bar.test.ts` (what the bar asks of the editor; the tracker of the visible area, with a made-up `visualViewport`), and in Chromium, emulating a phone with touch events and a made-up keyboard, the scenarios "on a phone …" (the bar with the keyboard, each button, taps on links and tags, touch targets and no sideways scroll, a table), "a browser that moves what can be seen…", "the formatting bar is not shown to a mouse…", "a touch screen has the bar…". Not on a device: `zim-editor-plan.md`, *Writing on a phone* |
| Pictures | `web/test/editor.test.ts` (images with a host: pictures, chips and why, caret and selection rules, Ctrl-click), `commands.test.ts` (where a reference goes), `file-urls.test.ts` (loading, stale addresses, failures not retried) |
| **The app in Chromium** | `web/test/browser.mjs`: the scenarios below, on the built app, served by the same server `npm run serve` runs |
| How it looks | `npm run screenshots <dir>`: screenshots (light, dark, phone, a phone with the keyboard up and the bar, dialogs, search, menu, pictures, the viewer, tables as a grid and as text, the journal and tags, completing a link) to look at |

The browser scenarios, each in a fresh profile (so a fresh IndexedDB): the editor (rendering, markup
shown where the caret is, typing, undo, checkbox clicks, shortcuts, list editing, carriage returns,
every real Zim page loaded); starting on the sample; tree and Back/Forward and remembered folding;
the tree by keyboard (focus stays in it); Ctrl-click, anchors and plain names; missing links and
creating a page by typing; backlinks; new page and sub-page with name checks; rename (links follow;
after a reload everything is as renamed; without link updates; refused names); delete; sections;
search; the contents of a page (its headings as people read them, a click that goes there, what is typed, open or closed
remembered); the calendar (a month, the days that have a page, a day opened, today's page started with the day as its
title, other months, Today and the menu, the arrow keys and the one stop for Tab); tags (listed, shown by a click or a
Ctrl-click, searched for exactly, the list following what is written); completing a link (the best first, the shortest
link written, the mouse, the arrows, Escape, nothing in code); tables (a grid with its cells formatted, the text and a
toolbar while the caret is in it, the arrows into it, Tab and Enter and Shift+Enter, the toolbar's buttons and Alt+F10,
the Table button); autosave and Ctrl+S across a reload; typing kept when the page closes in the middle of a
write, and an old draft not overwriting a newer page; a failing store; a browser that keeps nothing
(the app runs from memory, says so, and can still export); attachments (the button, paste, drop on
text, on a bullet, on the page and outside it; the panel; pictures at their sizes; the viewer; chips
that say why a picture isn't shown; renaming and deleting a page with its files; SVG and HTML that
must not run); notebooks (new, switch, rename, delete, delete the last); download and zip export
read back by Python's `zipfile`; import of
a folder with Windows files (BOM, CRLF, mixed endings, a Latin-1 file, case-clashing names, an
invalid name, attachments, hidden files) edited and exported again; import into the open notebook;
**the real Zim manual (81 pages and 34 attachments) imported through the file chooser, searched
and followed, exported and every file compared byte for byte, then imported again from our zip and
from a deflate zip that Python made**; links that could run code; deep links; a phone-sized screen;
and encrypted notebooks through the interface: made with a passphrase and written in, locked and
unlocked after a reload, Back and Forward and the address and tab title saying nothing, no draft
left behind, export with its warning, import as encrypted, rename, delete, a lost passphrase erased,
a short passphrase refused, the lists beside the page and a table and a link being completed leaving nothing
in what the browser keeps, auto-lock, the browser's promise to keep the data (also when it comes
late), a page that isn't secure, the passphrase changed from the menu (and a lock that comes in the
middle of it), the encrypted notebooks backed up from the menu and restored in another browser, and a
scan of everything the browser keeps for a notebook's contents;
and what the review of them found: a question asked on one notebook can't change another, a lock
closes questions and asks before it loses typing, a page the browser kept is hidden and locks when
it comes back, a lock that can't switch the screen starts the page again, a dead engine, an unlock
that Escape can't give up, a page nobody asked to test having no handle on the app.

The scenarios run with service workers blocked, except those about the app being saved on the device
(see `zim-pwa.md`: ten of them, each with its own copy of the built app on a server of its own, so that a
second version can be put on it).

The app offers a test hook, `window.__zim` (the app and its editor), only to a page that was asked
for one: the test sets `window.__ZIM_TEST__` before the page's own scripts run (an init script of the
browser context). A page without that has no handle on the notebook that is open, an unlocked
encrypted one included.

## Running it

```bash
cd web && npm install && npm run wasm && npm run core && npm run build   # `core` builds the Turtl core for encrypted notebooks (a few minutes the first time)
ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm test
npm run test:vault                              # the vault in Chromium (needs the browser setup below)
scripts/setup-browser.sh                        # once
ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm run test:browser
ONLY="rename" npm run test:browser              # just the scenarios whose name has "rename"
SCREENSHOTS=dir npm run test:browser            # a failing scenario leaves a screenshot of the page in dir
npm run screenshots dir                         # the pictures of the app
scripts/serve.sh start --host :: --port 8080    # serve it (docs/zim-editor-plan.md: trying it from another machine)
```

Typing in the browser tests is sent with no pause between keys, as a program does. Put the caret
somewhere and let the editor finish scrolling before typing (`ui.caretTo` does); keys that arrive
while CodeMirror is scrolling a caret into view can land in the middle of it, which no person
typing can reproduce (found as a rare flake, bisected, and the stress loop went from 12 failures in
80 to 0 in 120 with that one change).

## Not done yet

* **Big attachments** are held in memory while a notebook is exported (a zip is built whole), and the
  zip has no Zip64, so a notebook over 4 GB can't be exported as one. Files are not streamed.
* **Attachments of a page that has no text** (a folder of files with no `.txt` beside it) are kept,
  moved with their section and exported, but don't make a section of their own in the tree.
* **Rewriting an image's `href` when its page is renamed**: `{{pic.png?href=Page}}` is followed, but a
  rename doesn't update the page named there (`[[links]]` are).
* **Pictures are not resized or cached**: a 20 MB photo is a 20 MB `<img>`. No thumbnails are made.
* **Two tabs on one notebook** do not see each other's changes until reload (no `BroadcastChannel`),
  and the last write to a page wins. The draft rule above keeps an old draft from replacing a newer
  page, but two tabs open on the same page can still overwrite each other.
* **No undo for rename and delete** other than exporting first (the delete dialog says so).
* **Persistence is the browser's to give.** `navigator.storage.persist()` is requested, but a browser
  may refuse, and a user can clear site data; export is the backup. Where a profile will not store
  anything (some private windows) the app runs from memory and says so.
* **Not yet Zim features:** templates, page properties, the header block hidden (it is shown, dimmed),
  journals of weeks and months (only days), a calendar in a language but English (the titles of days and the
  names of months), tags that are pages or nest, pictures in the cells of a table, and the other lists
  of Zim's side pane (the index of tagged pages is the search).
* **Synced or shared notebooks** (and lazy indexing, replacing the notebooks' keys when the passphrase
  changes, and the other limits of the encrypted kind: `zim-encrypted-notebooks.md`): the sync server comes next (CLAUDE.md, Open issues
  #3, #5, #6).
