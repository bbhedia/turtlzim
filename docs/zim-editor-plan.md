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
4. **CodeMirror line separator is `\n` only** (`EditorState.lineSeparator`). By default
   CodeMirror would normalize `\r\n` and lone `\r`, silently rewriting a CRLF page on save.
5. **Live preview, not WYSIWYG.** Syntax characters (markers) are dimmed or hidden while the caret
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

## Status

- [x] Span model in `zim-format` (this document, section above).
- [ ] `core/zim-wasm`: `highlight()` for JavaScript with UTF-16 offsets.
- [ ] `web/` package: Vite + TypeScript + CodeMirror 6.
- [ ] Editor: live formatting, live preview, widgets.
- [ ] Commands and keymap.
- [ ] Tests in a real browser on real Zim pages.
- [ ] Demo page.
