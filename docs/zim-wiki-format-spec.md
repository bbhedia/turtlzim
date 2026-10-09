# Zim Wiki Text Format — Implementation Spec (v1 scope)

Written from Zim's public syntax documentation (zim-wiki.org/manual/Help/Wiki_Syntax.html) and
by cross-checking real `.txt` page files and round-trip behavior in the zim-desktop-wiki
project. This is an original description of the format for reimplementation purposes — no
Zim source or documentation text is copied. Per CLAUDE.md, the goal is byte-identical
round-trip (`parse` then `serialize` reproduces the original file exactly) for everything in
scope, and a *safe, lossless passthrough* for anything out of scope so round-trip is never
broken by content we don't yet understand semantically.

---

## 1. Page file structure

A `.txt` page file is:

```
<optional RFC822-style header block>
<blank line, only if a header block is present>
<body: the page content, normally starting with a level-1 heading>
```

### 1.1 Header block

Zero or more header lines in RFC822 form, each `Key: value\n`. A header value may continue
onto following lines: any line that starts with whitespace (space or tab, not newline) is a
continuation of the previous header's value. Header keys use `[\w-]+` (word chars and
hyphens). Common keys seen in real notebooks: `Content-Type`, `Wiki-Format`, `Creation-Date`,
`Modification-Date`. Values are opaque strings to us — we never parse `Creation-Date` as a
real date, we store and re-emit the raw text.

For round-trip fidelity: preserve headers as an **ordered list of (key, raw-value) pairs**,
including exact continuation-line text, and preserve whether a header block was present at
all (a page with no headers is valid and common in test fixtures / hand-written notebooks).

### 1.2 Body

The body is a sequence of **blocks**, separated by blank lines in the usual "block" sense
(heading, paragraph, list, verbatim block, horizontal rule, or — out of scope — table /
object block). Blocks are parsed line-oriented; inline markup is parsed within a block's
text.

---

## 2. Block-level elements (in scope for v1)

### 2.1 Headings

```
====== Head 1 ======
===== Head 2 =====
==== Head 3 ====
=== Head 4 ===
== Head 5 ==
```

- Marker is `=` repeated N times on both sides of the heading text, with **exactly one space**
  between the markers and the text on each side.
- N=6 → level 1 (page title), N=5 → level 2, N=4 → level 3, N=3 → level 4, N=2 → level 5.
  (Level = 7 − N, valid for N in 2..=6.)
- Both the opening and closing marker must have the **same** N.
- The heading text must be non-empty. A line like `====\nThis is not a header` — four equals
  with nothing else on the line — is **not** a heading; it is ordinary paragraph text (the
  line just happens to consist of `=` characters). Concretely: a candidate heading line only
  parses as a heading if, after both marker runs are stripped, the remaining text is
  non-blank.
- A heading's text may itself contain an inline anchor (§3.7), e.g.
  `=== My Section {{id: my-anchor}} ===`.

### 2.2 Paragraphs and indented paragraphs

- A paragraph is one or more consecutive non-blank lines that aren't consumed by a more
  specific block type (heading, list, verbatim, horizontal rule).
- A paragraph whose lines all share a **leading tab** is an *indented paragraph* (rendered
  historically as a blockquote-like offset). Track the indent depth (count of leading tabs
  common to every line) and strip exactly that many tabs from each line for the text content;
  re-add them on serialize.
- Blank lines separate blocks; **multiple consecutive blank lines must be preserved exactly**
  (don't collapse them) for byte-identical round-trip.

### 2.3 Lists

Three list-item styles, distinguished by the token right after the leading whitespace:

- **Bullet:** `* item text`
- **Numbered:** `1. item`, `a. item`, or `A. item` — i.e. an arabic number, lowercase letter,
  or uppercase letter, followed by `.` and a space. The *first* item in a list run fixes the
  numbering scheme (numeric / lower-alpha / upper-alpha) and starting value (lists may start
  at any value, e.g. `C.`, `D.`, `E.`); store the starting token verbatim so serialization
  reproduces it. Nested numbered sub-lists restart their own counter/scheme independently
  (e.g. a nested list can start at `3.` under a parent that started at `1.`).
- **Checkbox:** `[ ] item` (unchecked), `[*] item` (checked), `[x] item` (crossed-out /
  "xchecked"), `[>] item` (migrated), `[<] item` (transmigrated). Five distinct states —
  keep them as a closed enum, not a boolean, so all five round-trip.
- **Nesting:** determined by leading-tab count relative to the parent item (one extra tab per
  nesting level, same as Zim's outline indentation). Bullet, numbered, and checkbox items can
  be mixed as siblings/children of each other (a checkbox list can contain a plain bullet
  child, etc. — see the reference fixture's TODO-list example).

### 2.4 Verbatim (preformatted) blocks

```
'''
raw content, no inline markup parsing at all
'''
```

- The opening line, once its leading indentation is stripped, must be **exactly** `'''` with
  nothing else (no trailing text, no trailing whitespace beyond the newline).
- The block's indentation level is fixed by the opening line's leading-tab count. The closing
  delimiter must be a line whose text, after stripping **that same** number of leading tabs,
  is exactly `'''` — a line with *more* leading tabs than the block's base indent (e.g. a
  `'''` that is part of indented code content, such as a nested docstring delimiter) does
  **not** close the block; it is literal content. This matters: a code sample containing its
  own triple-quoted docstring must not truncate the outer block. Only the first line at the
  block's own indent level that is bare `'''` closes it (first match wins).
- Content lines have the block's base indent stripped for storage and re-added verbatim
  (including each line's own *extra* indentation beyond the base) on serialize. No inline
  markup is parsed inside — the raw text is stored as-is.
- A content line with **fewer** leading tabs than the base indent (an empty line inside an
  indented block is the everyday case: real notebooks have them) has nothing to strip. It must
  come back with exactly the tabs it had — never padded to the base indent — so the parsed block
  records which lines were short (`Verbatim::under_indented`).
- An opening fence that never finds its closing line makes the block run to the end of the page
  (`closed == false`), the same way an unterminated fenced block does in CommonMark. This is the
  lossless choice; it is also what a live editor sees between typing the opening fence and the
  closing one.

### 2.5 Horizontal rule

A line consisting of `-` repeated at least some minimum run (Zim's own example uses 20
dashes: `--------------------`) on its own, surrounded by blank lines, is a horizontal rule.
Store the exact dash count so it round-trips byte-identical; don't normalize it.

### 2.6 Out of scope for v1 (must still round-trip losslessly)

- **Tables** (`Table_Editor`-style `|...|` grid with an alignment separator row) — a plugin
  feature, not in the base Wiki_Syntax page. (Still one opaque block here; §2.7 says how one is
  *read* as a table without parsing ever changing it.)
- **Object blocks** (`{{{objecttype: params\n...\n}}}`, e.g. code blocks with syntax
  highlighting, equations) — plugin-provided.

These are **not parsed semantically** in v1. The block-level scanner must still recognize
their outer shape well enough to treat them as a single **opaque block**: capture the exact
raw text span (from the block's start line to its end line, inclusive) and re-emit it
unchanged. Do not let an unrecognized block corrupt surrounding block boundaries (blank-line
separation before/after must still be tracked normally).

### 2.7 Tables, read as a grid (`core/zim-format/src/table.rs`)

A run of lines that all start and end with `|` is one opaque block (§2.6): **parsing never changes
it** (`parse(text).serialize() == text`, golden-tested). `table::parse(block)` *reads* such a block as a
table, to draw it as a grid and to edit it, from the syntax Zim writes and reads:

```text
| Name  | Count | Note     |      the first line is the header row
|:------|------:|:--------:|      optional: `:---` left, `---:` right, `:---:` centred, `---` as it comes
| apple |     3 | a\|b     |      one line for each row; `\|` is a bar in a cell, `\n` a line break in one
| pear  |    12 |          |
```

* The **alignment row**, if there is one, is the second line and has nothing but `|`, `-`, `:` and
  spaces, with at least one `-`; it is not a row. A table has at least one row below its header: a
  block with a header and nothing else is not a table, and stays lines of text.
* A line is split into cells at every `|` that is not written `\|`; a cell is what is between two bars,
  without the spaces round it. In a cell `\n`, `\t`, `\\` and `\|` stand for a line break, a tab, a
  backslash and a bar; any other backslash is itself. A line with fewer cells than the widest has empty
  ones after its last.
* A header cell that ends with `<` marks a column whose cells wrap.
* **Editing** (`Table::add_row`, `delete_row`, `add_column`, `delete_column`, `set_align`, `render`)
  writes the whole table again: every column as wide as its widest cell (at least three characters),
  text kept as written (escapes included), the alignment row only if the table had one or a column is
  aligned. Nothing but an edit does this: reading, drawing and moving a caret in a table leave its
  bytes alone. The header can't be deleted, nor the only row below it, nor the only column. A first row below the
  header that is only dashes, colons and blanks (`| - | - |`) would be read as the alignment row, so a table written
  out with such a row gets the alignment row above it (found by the fuzz test below: an edit that deleted the row
  above it made a table whose first row stopped being one). The reader is tested on 600,000 texts made to break it
  (bars, backslashes, dashes, blanks of every kind, NUL, characters of one to four bytes): no panic, every cell where it
  says it is, and what is written out is read back as the same table, after every edit at every place and past the end.

---

## 3. Inline elements (parsed inside paragraph / heading / list-item text; **not** inside
verbatim blocks or opaque blocks)

All inline markers use at least two characters, specifically so a single stray `*` or `/` in
normal prose is never misparsed (see §3.1).

| Element | Marker | Example | Notes |
|---|---|---|---|
| Bold | `**text**` | `**bold**` | |
| Italic | `//text//` | `//italic//` | |
| Underline | `__text__` | `__underline__` | |
| Strikethrough | `~~text~~` | `~~strike~~` | |
| Verbatim (inline) | `''text''` | `''code''`| Suppresses all further inline parsing of its contents (the one exception to "can combine all markup") |
| Superscript | `^{text}` | `x^{2}` | Immediately follows the preceding text, no space |
| Subscript | `_{text}` | `H_{2}O` | Immediately follows the preceding text, no space |

### 3.1 Non-matches

A single `*` or `/` (etc.) is never markup on its own — only the doubled marker triggers
parsing. E.g. `*bold*` and `/italic/` and stray `*`, `#`, `@`, `<>`, `""` in prose are literal
text. Markers only pair up within the same block; an unmatched opening marker (e.g. one `**`
with no closing `**` before the block ends) should fall back to literal text rather than
erroring, to keep round-trip total (never crash the parser on real notebooks).

### 3.2 Nesting

All inline styles combine freely (bold-inside-strike-inside-italic, etc.) **except**
verbatim (`''...''`), which is opaque: once you're inside `''...''`, nothing else is parsed
until the closing `''`.

### 3.3 Links

```
[[foo]]        same-level-or-parent page link, display text defaults to the target ("foo")
[[:foo]]       absolute (root-of-notebook) page link
[[+foo]]       sub-page link
[[foo|bar]]    link to "foo", displayed as "bar"
[[foo#anchor]] link to an anchor within another page
[[#anchor]]    link to an anchor within the current page
[[wp?Test]]    interwiki link (shorthand key + "?" + interwiki page name) — kept as an opaque
               href, not resolved
```

Also auto-linked **without** brackets, wherever they appear in text:
- Bare URLs recognized by scheme (`http://`, `https://`, `file://`, …).
- Bare email addresses (`foo@bar.org`).
- `mailto:` URIs.

A single-bracket form like `[not:a:link]` is **not** a link — only doubled `[[...]]`
triggers link parsing.

### 3.4 Tags

`@word` anywhere in body text (not inside headings — Zim's own known limitation, which we
preserve for compatibility) is a tag. Name is `[A-Za-z0-9_]+` immediately after `@`,
case-insensitive for matching purposes but store the original casing for round-trip.

As implemented (`highlight.rs`, and the index in `core/zim-notebook/src/tags.rs`): the `@` must not
follow a letter, digit or `_` (so `user@example.org` has no tag), and a tag is not found in a heading,
a code block or span, a table or object block, or the header. Two spellings that differ only in case
are one tag (`tag_key`); a notebook's list shows the spelling of the first page, in name order,
that has it.

### 3.5 Images / embeds

```
{{./relative/path.png}}
{{./path.png?height=50}}
{{../path.png?width=600|Alt text}}
{{path.png?href=SomePage}}
```

- Path is relative (resolved against the containing page's location) or absolute.
- Optional query string after `?`, `&`-separated `key=value` pairs. Recognized keys include
  `height`, `width`, `href` (makes the image also a link), and values may be percent-encoded
  (e.g. `%3A` for `:`) — store the raw encoded string, don't decode/re-encode it ourselves.
  Unknown keys must still round-trip (store as opaque key/value pairs, not a fixed struct).
  A `?` with nothing after it (`{{pic.png?}}`) is a query consisting of one empty token, so that
  the `?` survives; "no query" means no `?` at all.
- Optional trailing `|Alt text` sets the alt/label text, same pipe convention as links.
- A `type=` param (e.g. `?type=equation`) selects a richer embed kind in real Zim (backed by
  a plugin). v1 treats this the same as any other query param — store it, don't act on it.

### 3.6 Anchors

- `{{id: name}}` defines an anchor at that point in the text (distinguished from an image
  embed by the literal `id:` keyword right after `{{`).
- Referenced via a link's `#name` suffix (§3.3).

---

## 4. Golden-file round-trip requirement

For every fixture in scope (v1 block/inline elements above, including the opaque-passthrough
requirement for tables/objects and the nested-verbatim-block edge case in §2.4), the pipeline

```
bytes -> parse() -> AST -> serialize() -> bytes
```

must reproduce the exact original bytes. Fixtures are original test files we author
ourselves (not copied from any Zim repository) covering each row of §2 and §3, plus a
combined "everything at once" fixture exercising nesting and adjacency edge cases.

### 4.1 Verification status (2026-10-05)

Fixtures we author only test what we thought of, so three further checks stand behind the
requirement (all in `core/zim-format/tests/`):

| Check | What it covers | How to run |
|---|---|---|
| `golden_real_notebooks.rs` | **Real pages**: every `*.txt` below `ZIM_GOLDEN_DIR` must round-trip byte for byte, and `parse(serialize(parse(t))) == parse(t)`; the same for ~16,000 damaged variants of those pages (cut off after or inside any line, any line dropped, any line doubled). Prints a census of what the pages contain. The pages are never copied into this repo (Zim is GPLv2). | `scripts/zim-golden.sh` (shallow-clones Zim into `~/.cache/turtlzim-labs/` once; or pass your own notebook directories) |
| `fuzz_roundtrip.rs` | **Arbitrary text**: 80,000 fixed-seed random strings of format punctuation (shrunk to a minimal case on failure), every prefix and suffix of a page using every construct, every single line dropped or doubled, and inline-level round trips. Needs no corpus. | `cargo test -p zim-format` |
| unit/regression files | the constructs of §2 and §3, plus a regression test for each bug the two checks above found | `cargo test -p zim-format` |

Result on Zim's own repository (the user manual, a real 81-page notebook, its website pages,
its format test pages and templates): 96 of 96 UTF-8 pages round-trip byte for byte. The one
page that is not UTF-8 (`tests/data/non-utf8.txt`) cannot reach `parse(&str)` at all; the layer
that reads notebook files must refuse it, or repair it visibly, and never convert and write back.
A byte-order mark round-trips as ordinary text of the first line (so headers on such a page are
not recognized: strip the mark in the file layer and write it back).

Bugs these checks found on their first run, both fixed: an indented verbatim block gained tabs on
its short or empty lines (§2.4, found on a real Zim test page), and `{{pic.png?}}` lost its `?`
(§3.5, found by the fuzzer).

Known limits: tables and `{{{object}}}` blocks stay opaque (§2.6; 16 lines in the whole Zim
corpus), and the inline matcher is quadratic in the length of a *single block* when that block
holds thousands of unmatched openers (e.g. 100 KB of `^{` takes tens of seconds). Blocks are
parsed one at a time and no real page looks like that; `fuzz_roundtrip.rs` pins that nothing is
worse than quadratic.
