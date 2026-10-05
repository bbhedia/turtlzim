# Zim editor plan (`web/`)

The shared web UI decided on 2026-10-05 (CLAUDE.md, Open issues #1): one CodeMirror 6 editor that
edits Zim wiki text "the way Zim does", reused by the browser app, the Tauri desktop shell and the
Capacitor mobile shell. It is built first and standalone: no sync server, no account, no
`turtl_core` (those come after; this package only needs a string in and a string out).

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

## Layers and what verifies each

| Layer | Where | Verified by |
|---|---|---|
| File: bytes ⇄ {mark, line ending, text} | `core/zim-format/src/file.rs`, `decodePage`/`encodePage` in `core/zim-wasm` | 60,000 random files (every combination of `\r\n`, `\n`, `\r`, marks, multi-byte text) re-encode exactly; real Zim files; across the wasm boundary |
| Syntax: text → spans | `core/zim-format/src/highlight.rs`, `highlight` in `core/zim-wasm` | see the span model above; again in TypeScript on every real page |
| Editor logic: spans + selection → decorations, commands | `web/src/editor/` | Vitest, headless (CodeMirror's state layer needs no DOM) |
| Editor in a browser: rendering, keystrokes, clicks, open/save | `web/test/browser.mjs` | real Chromium: every real Zim page loads and renders; typing and undo; checkbox clicks; Ctrl-click links; a CRLF+BOM file opened, edited and saved byte for byte; a mixed-endings file; a non-UTF-8 file refused |

## Running it

```bash
cargo test -p zim-format -p zim-wasm        # Rust side (from the repo root)
scripts/zim-golden.sh                       # real Zim pages through the parser and file layer
cd web && npm install && npm run wasm       # build the wasm into the web package
npm test                                    # Vitest (ZIM_GOLDEN_DIR=... adds the real pages)
npm run build                               # typecheck + production build
scripts/setup-browser.sh                    # once: Chromium, system libraries and a font, no root
npm run test:browser                        # the built editor in a real browser
SCREENSHOTS=dir npm run test:browser        # also writes screenshots: look at them
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
- [x] Tests in a real browser on real Zim pages; demo page (open, save, show markup).
- [ ] Commands and keymap (bold/italic/... toggles, list continuation, indent, headings).
