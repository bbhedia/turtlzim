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
| `Ctrl/Cmd-click` | follow a link (`onNavigate`) |

An inline toggle takes the style off when the caret or selection is inside a construct of that kind;
otherwise it wraps the selection (trimmed, one piece per line), or the word under a bare caret, or
inserts an empty pair. Keys a browser reserves for itself cannot be bound by a page (Ctrl+1..9 switch
tabs, Ctrl+T opens one), hence Ctrl+Alt+digit for headings.

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
npm run serve                                 # in the foreground instead (127.0.0.1:8080 unless told otherwise)
```

It listens on 127.0.0.1 unless told otherwise. Ways to reach it, easiest first:

1. **SSH tunnel** (nothing to configure, nothing exposed): `ssh -L 8080:127.0.0.1:8080 you@server`, then
   open `http://localhost:8080`. The same works for the Vite dev server (`-L 5173:127.0.0.1:5173`).
2. **Open the port.** Start with `--host ::` (or `0.0.0.0`) and let the port through the firewall:
   `sudo ufw allow 8080/tcp`, or only from your address:
   `sudo ufw allow from YOUR.IP to any port 8080 proto tcp` (undo: `sudo ufw delete allow 8080/tcp`).
   Behind a router (a private 192.168.x.x address) the router must also forward the port.
3. **Copy `web/dist` to a web server you already have** (`rsync -av web/dist/ host:/var/www/zim/`).
   The build uses relative URLs, so it works from any folder; make sure `.wasm` is served as
   `application/wasm`.
4. **Live reload:** `npm run dev -- --host 0.0.0.0` (Vite's dev server: fine on a private network,
   not something to leave on the internet).

What visiting exposes: the editor's own files, nothing else. Everything the editor does happens in the
visitor's browser; a page opened from their disk never reaches the server, and the server stores
nothing. Plain HTTP is enough for this editor. Basic authentication over HTTP is sent in clear, so it
keeps casual visitors out but protects nothing on an untrusted network (use the tunnel, or TLS in
front). The real app will need HTTPS: browsers only offer OPFS storage, service workers and
`crypto.subtle` to secure contexts (`localhost` counts, a bare IP address does not).

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
npm run screenshots dir                     # nine pictures of the app (light, dark, phone, dialogs): look at them
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

## Not done yet

- **Images** are drawn as pictures when the host can say where each one comes from
  (`imageSource`, see `zim-web-app.md`): the notebook app does, and keeps them as attachments.
  Without a host, or when there is no picture to draw (no such file, outside the notebook, not a
  picture the browser draws safely, still loading), an image is a chip that says which. A picture
  stays drawn while the caret is beside it; selecting it, or placing the caret inside its source,
  shows the source, and double-clicking selects it. Pictures, drops and pastes of files are the
  host's: `onFiles`, `insert`.
- **Completing page names** (typing `[[` to get a list of pages) is not there; following and
  drawing links is (the editor raises `onNavigate`, the app resolves it with the notebook rules).
- **Tables and object blocks** (`{{{code ...}}}`) are shown raw, as the format crate keeps them opaque.
- **The header block** is shown, dimmed. Zim hides it; folding it is a small follow-up.
- **Accessibility**: Tab is a list command (it traps keyboard focus, as most editors do; CodeMirror's
  tab-focus-mode toggle is not wired up), and the checkbox/bullet widgets have roles but no keyboard
  path other than the commands above.
- **Mobile**: nothing touch-specific yet (long-press link follow, a formatting toolbar). The editor
  itself is a plain CodeMirror view, which works with touch and IME input.
- **The Zim parser's `{{{`/table support** (and any new inline kind) will need span kinds added in
  both `highlight.rs` and `web/src/kinds.ts`; `checkCodes` fails at load time if the two disagree.
