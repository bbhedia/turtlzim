# Zim editor plan (`web/`)

The shared web UI decided on 2026-10-05 (CLAUDE.md, Open issues #1): one CodeMirror 6 editor that
edits Zim wiki text "the way Zim does", reused by the browser app, the Tauri desktop shell and the
Capacitor mobile shell. It was built first and standalone: no sync server, no account, no
`turtl_core` (those come after; the editor only needs a string in and a string out). The notebook
app built on top of it (pages, links, tree, search, import and export) is described in
`zim-web-app.md`; the notebook rules it uses, in `zim-notebook.md`.

## Decisions

1. **The editor's document is the Zim file text.** Not an AST that is serialized back. Whatever
   the user does not touch stays byte for byte, and saving is `view.state.doc.toString()`. The
   parser never writes; it only *describes* the text. This is what makes "Zim `.txt` round-trips
   must be byte-identical" hold for the editor by construction instead of by testing alone.
2. **One parser.** The syntax that drives live formatting comes from `core/zim-format` compiled to
   wasm (`core/zim-wasm`), not from a second parser written in TypeScript. Anything the format
   learns (tables, new inline kinds) reaches the editor and, later, the core's indexing and link
   extraction at the same time, and the golden test on real Zim pages covers both.
3. **Offsets are exact, not approximate.** The parsed tree carries no positions, so
   `zim_format::highlight` recovers them by adding up what each node renders to (valid because the
   round trip is exact). It returns *spans*; see below.
4. **Line breaks are exact.** By default CodeMirror turns `\r\n` and a lone `\r` into `\n` when it
   reads text, which would silently rewrite a page containing one. Pages that do contain a `\r`
   (only mixed-endings files, after the file layer) get `EditorState.lineSeparator.of("\n")`;
   all others use the default, which also turns line endings in *pasted* text into `\n` so a CRLF
   file stays consistent.
5. **The file is not the page.** A file also has a byte-order mark or not, and ends its lines with
   `\n` or `\r\n`. Left in the text they make a page unreadable (a mark in front of
   `Content-Type:` hides the header block; a `\r` before every newline stops a heading's closing
   `======` from being at the end of its line), so `zim_format::PageFile` splits them off when a
   file is opened and puts them back when it is saved: `decode(bytes).encode() == bytes` for every
   valid UTF-8 file, and the editor only ever sees clean `\n` text. A file with mixed line
   endings has no single style to restore, so it is kept raw (carriage returns visible) rather
   than normalized: exact beats pretty. Bytes that are not UTF-8 are refused, never converted. Found
   by *looking at* a screenshot of a CRLF page, which round-tripped perfectly and still rendered as
   plain text; the byte-exactness tests alone could not have shown that.
6. **Live preview, not WYSIWYG.** Syntax characters (markers) are dimmed or hidden while the caret
   is outside the construct they belong to and revealed when it enters, like Zim's own editor
   shows `**` as bold text, without ever losing the characters.

## Span model (`core/zim-format/src/highlight.rs`)

`highlight(text) -> Vec<Span>`; `Span { start, end, kind, detail }`. Byte offsets in Rust;
`to_utf16` converts for JavaScript. The list is in pre-order (sorted by `start`, outer before
inner when they start together), spans nest properly, and a `Marker` span's `detail` is the index
of the construct that owns it (always earlier in the list, and the marker is a direct child of
it). The numeric codes are an interface to JavaScript: add new kinds, never renumber.

| Kind | Covers | `detail` |
|---|---|---|
| `Header`, `HeaderKey` | the header block; `Key:` inside it | 0 |
| `Heading` | the heading line (markers `====== ` and ` ======` are `Marker`s) | level 1 to 5 |
| `IndentedParagraph` | the lines of a tab-indented paragraph (ordinary paragraphs have no span) | indent in tabs |
| `ListItem` | a whole list line, indent included | indent in tabs |
| `ListMarker` | the marker and the space after it (`* `, `1. `, `[ ] `) | `list_marker::*` (bullet, number, a., A., five checkbox states) |
| `VerbatimBlock` | opening fence line through closing fence (fences are `Marker`s) | indent, plus `VERBATIM_UNTERMINATED` if never closed |
| `HorizontalRule` | the rule line | dash count |
| `Opaque` | a table or object block, kept raw | `opaque::TABLE` or `OBJECT` |
| `Marker` | syntax characters of the owning construct | owner's index |
| `Bold` `Italic` `Underline` `Strike` `InlineVerbatim` `Superscript` `Subscript` | the construct, markers included | 0 |
| `Link` | `[[...]]` (brackets and `\|` are `Marker`s) | 0 |
| `LinkTarget` | the target text | 1 if the link has a display part (a preview hides it) |
| `LinkDisplay` | text after the `\|` | 0 |
| `Tag`, `Image`, `Anchor`, `AutoUrl`, `AutoEmail` | the whole construct (`Image` and `Anchor` have `{{`/`}}` markers) | 0 |

Verified by `core/zim-format/tests/common/mod.rs::span_problem`, applied to hand-written
expectations (`tests/highlight.rs`), to the fuzzers (`tests/fuzz_roundtrip.rs`: 80,000 random
pages, every prefix/suffix, every line dropped or doubled) and to real Zim pages
(`scripts/zim-golden.sh`: 96 pages and ~16,000 damaged variants of them): bounds and char
boundaries, pre-order, proper nesting, marker ownership, the delimiters each kind must have, and
the number of spans of each kind equal to the constructs in the parsed tree. A mutation check
(breaking the tab mapping, an image length, a heading marker) is caught by at least two tests
each.

## Editing commands and keys

All commands are pure CodeMirror `StateCommand`s over the editor state (`web/src/editor/commands.ts`),
so they are tested without a DOM, and what counts as a bold span, a list item or a heading comes from
the parser's spans, never from sniffing the text. `Mod` is Ctrl, or Cmd on a Mac.

| Keys | Does |
|---|---|
| `Mod-B` `Mod-I` `Mod-U` | bold, italic, underline |
| `Mod-Shift-X` (`Mod-T` in desktop/mobile shells) · `Mod-E` | strikethrough · inline code (`''verbatim''`) |
| `Mod-.` · `Mod-,` | superscript · subscript |
| `Mod-K` | link: wraps the selection in `[[ ]]`, or inserts an empty one |
| `Mod-Alt-1` … `5` · `Mod-Alt-0` | heading level (again: back to plain) · plain text |
| `Mod-Shift-8` · `7` · `9` | bullet · numbered · checkbox list (again: off) |
| `Mod-Enter` · `F12`; `Mod-Shift-Enter` · `F11` | tick a box; drop it (a plain line or bullet becomes a checkbox) |
| `Enter` | in a list: continue it (numbers and letters count up, boxes start open); on an empty item go out a level, then off the list |
| `Backspace` right after a marker | take the item out a level, then off the list |
| `Tab` · `Shift-Tab` | nest · un-nest the selected list items (a tab in plain text) |
| In a table: `Tab` · `Shift-Tab` | the next · previous cell, with its text selected; `Tab` after the last cell makes a row |
| In a table: `Enter` · `Shift-Enter` | the cell below (a row below the last; on an empty last row, out of the table) · a line break in the cell (`\n`) |
| In a table: `Alt-F10` | to its toolbar (the arrows between the buttons, `Escape` back) |
| `ArrowDown` · `ArrowUp` beside a table | into its first · last row (the editor's own arrows go over a table drawn as a grid) |
| `[[` and a key | the pages the link may lead to (`completeLink`): arrows and `Enter` choose, `Escape` puts the list away |
| `Ctrl/Cmd-click` | follow a link (`onNavigate`) or a tag (`onTag`), in a page or in the cell of a table |

An inline toggle takes the style off when the caret or selection is inside a construct of that kind;
otherwise it wraps the selection (trimmed, one piece per line), or the word under a bare caret, or
inserts an empty pair. Keys a browser reserves for itself cannot be bound by a page (Ctrl+1..9 switch
tabs, Ctrl+T opens one), hence Ctrl+Alt+digit for headings.

## Tables, completing a link, and tags

**A table is a grid until the caret comes into it.** A block of `|` lines that `table::parse` can read
(spec §2.7) is drawn by a block widget in place of its lines (`web/src/editor/table-widget.ts`): a grid with
the header, the columns lined up as the table says, and each cell's text *formatted* (bold, italic, code, links,
tags: the syntax characters are left out; a cell is read by the same `highlight` as a page). The document is the
same text throughout: the widget is a decoration, nothing is parsed back, and looking at a table changes no
byte. A click puts the caret at the end of that cell *in the text*, which turns the table into its lines
(`cm-zim-table`, monospace) with a toolbar widget over the first of them; once the caret is out of the block the
grid is back (*Show markup* keeps the lines). A table that can't be read (a header and nothing below it) is only
lines, as before. Ctrl/Cmd-click on a link or a tag in a cell follows it, through `followFacet` (a widget can't reach
the options the editor was made with). The editor's own up and down arrows go *over* a block widget, so the keymap has
arrows of its own that go in, when the line beside the caret is a table.

Editing is the Rust code's. Each command (`table-commands.ts`) reads the block (`tableLayout`), asks for the new
text (`tableAddRow`, `tableDeleteColumn`, `tableSetAlign`, `tableFormat` …), and puts it in as one change (one undo)
with the caret in the cell where the person goes on. The toolbar: `+ Row`, `− Row`, `+ Column`, `− Column`,
`Left`/`Center`/`Right` (the one that is the column's is pressed), `Tidy`; what can't be done is disabled (the header,
the only row below it, the only column). A button acts where the caret is and gives the focus back to the page. **Insert
table** (`ZimEditor.insertTable`, the app's **Table** button): a block of its own below the line the caret is on (or on its
empty line, with an empty line each side, and never in the header of the page), with the first header selected to be
written over. With the caret in a block that is not text of the page (another table, an object, verbatim text) it goes
*below that block*: in the middle of a table it would cut it in two, and in code it would only be code.

Three edges that a review found, with what is done about each (all have tests, `web/test/tables-edges.test.ts` and the
browser scenario "a row with fewer cells than the table"):

* **A row with fewer cells than the table.** Tab, Shift-Tab, Enter or a click that lands in a cell the row does not have
  would put the caret after the row's last pipe, where a letter typed breaks the row off the table. The table is written
  out in full first (every row with all its cells, as every edit of a table writes it), as one change, and the caret goes
  into the cell that this makes (`goToCell`; `caretToCell` is the grid's click). That is the one case where moving in a
  table rewrites its text, and it is one that is already not as a table is written.
* **Undo and redo after an edit with a range selected.** An edit of a table replaces the whole block, and Tab selects what a
  cell says. CodeMirror keeps the selection from before a change for undo and redo and maps it through the change, and
  a range that lies *inside* a replaced stretch comes out with its end before its start (`SelectionRange.map`: the start
  is mapped to the end of the replacement, the end to its start): after the redo the page was selected backwards, and the
  next key typed threw. `dispatchEdit` makes such a selection a caret first (a selection-only step, which adds no undo step);
  undo and redo then restore a caret in the cell. (Seen in the real browser: after Tab, Ctrl+Z, Ctrl+Shift+Z the selection
  was `{from: 55, to: 0}`.)
* **A line break after a backslash.** A cell is written with `\n` for a line break and `\\` for a backslash; a cell that ends
  in one lone backslash, with `\n` typed after it, read as a backslash and an `n`. Shift-Enter writes an extra backslash
  when an odd number of them come before the caret.

**Completing a link** (`completion.ts`, `@codemirror/autocomplete`): after `[[` and one key, the host's `completeLink(typed)`
is asked (in the app it is `complete_link` of `core/zim-notebook`: `zim-notebook.md`). The list is in the host's order
(`filter: false`); each entry shows the page, the link that will be written when that is not the name (`[[+Garden]]`), and
says *section* for a page that only holds pages. Choosing one writes the link and its closing brackets in one change (the
brackets already there are taken for its own; a caret in the middle of a closed link replaces its whole target) with the
caret after it. Nothing is offered in the header, in code, or in a page that can't be changed, nor after a `|` or `#`. The
keys are the library's; an Enter in the first moments after the list opens is typing, not a choice.

**Tags** are drawn as before; Ctrl/Cmd-click on one calls `onTag(name)` (the app shows the pages that have it).

## Writing on a phone: the formatting bar, taps, and the keyboard

A phone has no Ctrl, Tab or arrows, and the mobile app will reuse this editor, so the keys the editor is written
around have buttons, and the layout is made for a small screen that a keyboard covers half of. None of it changes
what a mouse and keyboard do.

**The formatting bar** (`web/src/editor/format-bar.ts`, `createFormatBar`; the app puts it under the page). One row
of real buttons, in the order of use on a phone (the first seven or eight are what 390 pixels show; the next is cut
off at the edge, which says that the row moves sideways): Undo, Redo, **B**, *I*, Heading, Bullets, To do, Link, `1.`,
Indent, Outdent, <u>U</u>, ~~S~~, `</>`, Table, Attach. Each runs the command its key runs (`toggleWrap`, `setHeading`,
`toggleList`, `indentMore`, `insertLink`, `insertTable`, undo and redo of the history), so there is one rule for each and
the same undo step. Heading opens a second row of 1 to 5 and Plain, which closes when one is chosen.

* **It never takes the focus** (on a phone that would put the keyboard away at every press): the buttons cancel
  `pointerdown` and `mousedown`, act on `click`, and give the focus back to the text (`view.focus()`).
* **It says where the caret is**: a button is drawn pressed when the selection is in that style, list, or heading
  (`styleActive`, `listKindHere`, `headingLevelHere`, from the span model; a link under the caret makes **Open**
  take the place of Link, and Open calls the host's `follow`); Undo and Redo are dimmed when the history has nothing to
  do (`undoDepth`, `redoDepth`), Outdent when no selected line is indented (`canOutdent`, the test `indentLess` uses).
  Everything is dimmed in a page that can't be changed. `onUpdate` (document, selection or focus changed) redraws it.
* **It is reached by keyboard too**: a toolbar (`role=toolbar`) with one stop for Tab and the arrows, Home and End
  between its buttons; every button has a name for a screen reader (its title).

**When it is shown.** `data-formatbar` on the app is `auto` (the default), `on` or `off`. `auto` shows it while the
text is being written in (the editor or the bar has the focus, `.app.editing`) on a screen whose main pointer is coarse
(`@media (pointer: coarse)`: a finger); a mouse and keyboard get none. The notebook menu has **Show the formatting bar** /
**Hide the formatting bar** for either, and the choice is kept as `zim:formatbar` (`on` or `off`), which is all that is
kept: nothing about a page, so an encrypted notebook is not touched by it.

**Taps** (`followOnTap`, set by the app). A finger has no Ctrl key, so *how a link is followed depends on what the
page is being used for*: while the editor does not have the focus (a page being read, no keyboard) a tap on a link, a
picture or a tag follows it, as Ctrl-click does with a mouse, and the tap does not take the focus (a keyboard would
come up and cover the page); while it has the focus (typing) a tap places the caret like any other, so that the text of
a link, or the end of a line that is one, can be reached, and the bar's **Open** follows the link the caret is in.
The pointer is known from `pointerdown` (`pointerType`, and whether the editor had the focus before this press gave
it). A mouse is as before. On a touch screen a page that was opened by a tap (a link, a search result, a day of the
calendar, a heading in the contents) is not given the focus either, except a page that is new: it is for writing.
Putting the keyboard away (the visible area grows back) takes the focus from the editor, which ends the typing on
a browser that would leave it there.

**The keyboard** (`web/src/app/viewport.ts`). An on-screen keyboard shrinks the *visual* viewport and not the layout
viewport, so a page as tall as the screen has its bottom (the bar, and the line being typed) under it. On a touch
screen the app is `--visible-height` tall (`visualViewport.height`, unless the page is zoomed in), the bar is a row of
the grid under the page, and the caret is scrolled into view when the keyboard comes. A keyboard is a loss of 120
pixels or more against the tallest the area has been at that width (the address bar that hides as a page is scrolled
is 60), and `.app.keyboard` says so (no room is kept for the device's bottom edge while it is up). A browser that pans the
visual viewport down the page to show the focused field (`offsetTop`) gets the app moved with it
(`html[data-panned]`, `--visible-top`). While typing on a phone the row with the search and *Show markup* is hidden:
what is typed on gets the room. A phone on its side (landscape, 512 pixels or less tall) with the keyboard up has 25 to 65
pixels of text left under the top bar, the bar and the status line, so there the top bar and the status line go too, until
the keyboard is put away (`.app.keyboard`), and the tree starts closed there (it would take a third of the width: a short touch
screen on its side counts as a narrow one for it). The tree and the page scroll by themselves and a pull at the top of the page does
not reload the app (`overscroll-behavior`). Measured with made-up keyboards at 320×568, 390×844, 412×915, 568×320, 844×390,
768×1024 and 1024×768: no sideways scroll, the bar above the keyboard, the caret in view (the scenario "on a small phone, and a
phone on its side…").

**Touch targets.** Under `(pointer: coarse)`: buttons at least 40 pixels high, the bar's, the table toolbar's and the
tree's rows and arrows 44, a day of the calendar 36 or more (seven to a row in a drawer 320 wide). The table
toolbar has **‹ Cell** and **Cell ›** where a screen is touched (a keyboard has Tab and Shift-Tab): the cell before, and
the next, or after the last a new row. Text is not enlarged by the browser (`text-size-adjust`).

What verifies it: `web/test/format-bar.test.ts` (the queries the bar draws itself from, on states; the visible-area
tracker with a made-up viewport, with 20 mutants checked), and in Chromium emulating a phone (`hasTouch`, `isMobile`,
touch events; the keyboard is made up by `madeUpKeyboard` in `browser.mjs`, which shrinks `visualViewport` as the real one
does): the scenarios "on a phone the formatting bar comes with the keyboard…", "…each button of the bar does what it
says…", "…a tap on a link or a tag follows it while a page is read…", "…what is tapped is big enough, and the page fits
the screen", "…a table can be written", "a browser that moves what can be seen…", "the formatting bar is not shown to a
mouse unless asked for…" and "a touch screen has the bar…", and the pictures 31–35 of `npm run screenshots` (light, dark,
the heading row, a table, the desktop with the bar).

**Not verified on a device.** No browser here has a real on-screen keyboard, so the keyboard is made up, and WebKit
(iPhone) is not installed: the panning of the visual viewport, a keyboard that resizes the layout viewport instead
(`interactive-widget=resizes-content`), the focus after a keyboard is put away, and whether a tap on a button keeps the
keyboard up (cancelling `pointerdown` and `mousedown` is what the libraries for this do) are what a real phone has to
confirm. Selecting text by touch (long press, handles) is the platform's.

## Performance

The whole page is re-parsed on every change and decorations are rebuilt on every change or caret move;
both are linear. Median time for one keystroke or caret move in the real browser, including the one
frame (about 17 ms) it takes to paint:

| Page | Lines | Load | Keystroke | Caret move |
|---|---|---|---|---|
| 14 KB | 460 | 22 ms | 17 ms | 17 ms |
| 142 KB | 4,600 | 52 ms | 21 ms | 17 ms |
| 284 KB | 9,200 | 82 ms | 35 ms | 17 ms |
| 568 KB | 18,400 | 151 ms | 61 ms | 31 ms |

Zim pages are a few KB, so there is a wide margin. If it is ever needed: parse only the changed block
(blocks are separate), and build decorations only for the viewport. (The one known super-linear case
is a single block holding thousands of *unmatched* inline openers; see the spec's known limits.)

## Layers and what verifies each

| Layer | Where | Verified by |
|---|---|---|
| File: bytes ⇄ {mark, line ending, text} | `core/zim-format/src/file.rs`, `decodePage`/`encodePage` in `core/zim-wasm` | 60,000 random files (every combination of `\r\n`, `\n`, `\r`, marks, multi-byte text) re-encode exactly; real Zim files; across the wasm boundary |
| Syntax: text → spans | `core/zim-format/src/highlight.rs`, `highlight` in `core/zim-wasm` | see the span model above; again in TypeScript on every real page |
| Editor logic: spans + selection → decorations, commands | `web/src/editor/` | Vitest, headless (CodeMirror's state layer needs no DOM) |
| Editor in a browser: rendering, keystrokes, clicks | `web/test/browser.mjs` | real Chromium: every real Zim page loads and renders; typing and undo; checkbox clicks; shortcuts and list editing; carriage returns shown and kept. The app scenarios of the same file (files in and out, links followed, saving) are listed in `zim-web-app.md` |

## Trying it from another machine

The built editor is a folder of static files (`web/dist`: a page, one script, one stylesheet, a 72 KB
wasm), so anything that serves files can host it. `web/scripts/serve.mjs` is a small server for it
that is meant to be put on a network: no dependencies, only `dist` (no directory listings, no
dotfiles, no way out of the folder through `..`, encoded or double-encoded tricks, or symlinks), GET
and HEAD only, `application/wasm` and gzip, long caching for the hashed assets, connection limits and
timeouts, an optional password, and a strict Content-Security-Policy (`script-src 'self'
'wasm-unsafe-eval'`: no inline script, no eval). The browser test runs the editor through this same
server, so any policy violation fails it.

```bash
cd web && npm run build                       # refreshes dist/; a running server serves the new files at once
scripts/serve.sh start --host :: --port 8080  # in the background, survives logout (IPv4 and IPv6)
scripts/serve.sh status | log [-f] | stop | restart
ZIM_WEB_AUTH=name:password scripts/serve.sh start --host ::   # ask visitors for a password
scripts/serve.sh start --host :: --port 8443 --tls            # https, with a certificate it makes itself (below)
npm run serve                                 # in the foreground instead (127.0.0.1:8080 unless told otherwise)
```

It listens on 127.0.0.1 unless told otherwise. Ways to reach it, easiest first:

1. **SSH tunnel** (nothing to configure, nothing exposed): `ssh -L 8080:127.0.0.1:8080 you@server`, then
   open `http://localhost:8080`. The same works for the Vite dev server (`-L 5173:127.0.0.1:5173`).
2. **Open the port.** Start with `--host ::` (or `0.0.0.0`) and let the port through the firewall:
   `sudo ufw allow 8080/tcp`, or only from your address:
   `sudo ufw allow from YOUR.IP to any port 8080 proto tcp` (undo: `sudo ufw delete allow 8080/tcp`).
   Behind a router (a private 192.168.x.x address) the router must also forward the port.
   **Encrypted notebooks need a secure page**, which `http://192.168.x.x` is not: add `--tls` (and
   `--name ADDRESS` for each address or host name that visitors type, a router's public address
   included) and the server makes a certificate for those names (needs `openssl`; kept in
   `~/.local/state/zim-web/tls`, made again if the names change). The browser warns once (Advanced, then
   Proceed), and the page is then a secure one: OPFS, and so the vault, work. The warning is that nobody
   the browser trusts signed the certificate; the app is then not saved for offline use (a browser refuses
   a service worker for such a page). To have no warning and the saved app, ask each computer to trust the
   authority file the server gives (`/ca.pem`): how, and why that is safe, is in `docs/zim-pwa.md`. Or use
   a real certificate (`--cert FILE --key FILE`), or the tunnel.
3. **Copy `web/dist` to a web server you already have** (`rsync -av web/dist/ host:/var/www/zim/`).
   The build uses relative URLs, so it works from any folder; make sure `.wasm` is served as
   `application/wasm`.
4. **Live reload:** `npm run dev -- --host 0.0.0.0` (Vite's dev server: fine on a private network,
   not something to leave on the internet).

What visiting exposes: the editor's own files, nothing else. Everything the editor does happens in the
visitor's browser; a page opened from their disk never reaches the server, and the server stores
nothing. Plain HTTP is enough for open notebooks. Basic authentication over HTTP is sent in clear, so it
keeps casual visitors out but protects nothing on an untrusted network (use the tunnel, or `--tls`).
Encrypted notebooks need HTTPS (or `localhost`): browsers only offer OPFS storage, service workers and
`crypto.subtle` to secure contexts (`localhost` counts, a bare IP address over http does not).

The built app saves itself on a visitor's device with a service worker (`dist/sw.js`, made by the build): after
the first visit it starts without the server, and a new build put on the server is **offered** to visitors,
who approve it (the page shows its id and the files that differ). Serve `sw.js` with `Cache-Control:
no-cache` (`scripts/serve.mjs` does) and `manifest.webmanifest` as `application/manifest+json`. A worker
needs a certificate the browser trusts: with `serve.sh --tls` alone the app and the encrypted notebooks
work after the warning, but the app is not saved for offline use; trusting the server's authority fixes that
(`docs/zim-pwa.md`).

## Running it

```bash
cargo test -p zim-format -p zim-wasm        # Rust side (from the repo root)
scripts/zim-golden.sh                       # real Zim pages through the parser and file layer
cd web && npm install && npm run wasm       # build the wasm into the web package
npm test                                    # Vitest (ZIM_GOLDEN_DIR=... adds the real pages)
npm run build                               # typecheck + production build
scripts/setup-browser.sh                    # once: Chromium, system libraries and a font, no root
npm run test:browser                        # the built app in a real browser
SCREENSHOTS=dir npm run test:browser        # a failing scenario leaves a screenshot of the page in dir
npm run screenshots dir                     # twelve pictures of the app (light, dark, phone, dialogs, pictures): look at them
```

**A browser needs a font to edit text.** On a machine with no fonts at all (typical for a server)
Blink cannot resolve a caret to a rendered position: typing a character into *any*
`contenteditable` replaces the element's whole content, and form controls crash the renderer. It
looks exactly like an editor bug (it cost hours of misdiagnosis here, down to a bare `<div
contenteditable>` with no editor at all). `scripts/setup-browser.sh` installs DejaVu and a
fontconfig file and `test/browser.mjs` points Chromium at it. If typing misbehaves in a browser
test, check `fc-list` before the editor; logging `beforeinput`'s `getTargetRanges()` next to the
selection shows it directly.

## Status

- [x] Span model in `zim-format` (this document, section above).
- [x] `core/zim-wasm`: `highlight()` for JavaScript with UTF-16 offsets, `decodePage`/`encodePage`.
- [x] `zim-format` file layer (`PageFile`).
- [x] `web/` package: Vite + TypeScript + CodeMirror 6, 72 KB wasm, 105 KB gzipped JS.
- [x] Editor: live formatting, live preview (markers dim or hide by caret), widgets (bullets,
      checkboxes with click-to-toggle, rules, image and anchor chips), block styling, link
      activation (Ctrl/Cmd-click), `createZimEditor` / `zimExtensions` API.
- [x] Tests in a real browser on real Zim pages.
- [x] Commands and keymap (inline toggles, headings, list continuation/indent/backspace, list kinds,
      checkboxes, links): 34 headless tests plus real key presses in the browser test.
- [x] Notebook app around it (`zim-web-app.md`): page tree, links followed and drawn as missing,
      backlinks, plain-text search, rename that keeps links intact, import and export of folders and
      zips, saving that survives a reload or a closing page, phone layout.
- [x] Tables (a grid with formatted cells, the text and a toolbar while the caret is in it, Tab/Enter/arrow keys,
      insert), completing `[[links]]`, Ctrl-click on a tag: this section and `web/test/tables.test.ts`,
      `zim-features.test.ts` and the scenarios of `browser.mjs`.
- [x] Encrypted notebooks (`zim-encrypted-notebooks.md`): the same editor over the Turtl core in a
      Worker; a notebook is open or encrypted, and an encrypted one is kept out of the address, the
      title and the browser's own storage.
- [x] Writing on a phone: a formatting bar, taps that follow links while a page is read, a layout that follows
      the part of the screen the keyboard leaves, touch-sized targets (the section above; checked in an emulated
      phone, not on a device).


## Not done yet

- **Images** are drawn as pictures when the host can say where each one comes from
  (`imageSource`, see `zim-web-app.md`): the notebook app does, and keeps them as attachments.
  Without a host, or when there is no picture to draw (no such file, outside the notebook, not a
  picture the browser draws safely, still loading), an image is a chip that says which. A picture
  stays drawn while the caret is beside it; selecting it, or placing the caret inside its source,
  shows the source, and double-clicking selects it. Pictures, drops and pastes of files are the
  host's: `onFiles`, `insert`.
- **Completing links** offers pages and sections only: not headings (`Page#`), files (`./`) or the display
  part after `|`.
- **Object blocks** (`{{{code ...}}}`) are shown raw, as the format crate keeps them opaque. **Tables** are
  drawn with each cell's text formatted, but a cell holds no pictures; there are no merged cells, no sorting, no
  drag to resize or move a row or column (the toolbar adds, deletes and aligns), and a table in a list item or
  indented is not one (the parser's rule). Moving through a table is by Tab, Enter and the arrows; there is no
  selection of cells.
- **The header block** is shown, dimmed. Zim hides it; folding it is a small follow-up.
- **Accessibility**: Tab is a list command (it traps keyboard focus, as most editors do; CodeMirror's
  tab-focus-mode toggle is not wired up), and the checkbox/bullet widgets have roles but no keyboard
  path other than the commands above.
- **Mobile**: the bar, taps and layout above, checked in an emulated phone only (see *Not verified on a
  device*). Not done: a long press on a link for a menu (follow, edit, copy), dragging a row or a column of a
  table, and a toolbar for the keys that are missing from a phone's keyboard other than the ones above (Escape,
  Alt+F10 for the table toolbar: the toolbar is on the table itself there).
- **The Zim parser's `{{{`/table support** (and any new inline kind) will need span kinds added in
  both `highlight.rs` and `web/src/kinds.ts`; `checkCodes` fails at load time if the two disagree.
