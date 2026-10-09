# Notebook semantics (`core/zim-notebook`)

A Zim notebook is a set of pages with names; what the names mean, where a link leads, what the page
tree looks like and what a rename must do to the links are rules, and they live in one pure Rust
crate that every shell uses (the browser through wasm, the desktop and mobile shells natively). The
crate does **no I/O**: a storage backend (a folder of `.txt` files, a database in the browser,
encrypted records on a server) feeds it pages, so this layer does not decide *where* pages are kept
or whether they are encrypted. The rules are Zim's, taken from its manual ("Pages", "Links"); no Zim
source was read or copied.

## Names (`name.rs`)

`:` separates levels: `Projects:Garden:Plan` is the page `Plan` in the section `Garden` of `Projects`.
Forbidden in a name: `? # / \ * " < > | %`, control characters, and a level starting with a dot (a
hidden file, and `..` would leave the folder). Names compare **without regard to case** (two files
differing only in case could not coexist on a case-insensitive file system) but keep their spelling,
and an **underscore is a space** (`Auto_Formatting.txt` is `Auto Formatting`; this alone decides 161
of the 301 links in Zim's manual). A section holding pages exists as a page too, with no text of its
own. On disk a page is `Help/Auto_Formatting.txt`, and the folder `Help/Auto_Formatting/` holds its
sub-pages and attachments.

## Links (`link.rs`)

| Target | Means |
|---|---|
| `scheme://...`, `mailto:...` | an address (`file://` is a file) |
| contains `/` or `\` | a file (`./pictures/a.png`, `~/notes`, `/etc/hosts`) |
| `#id` | a heading or anchor on the same page |
| contains `?` | interwiki: `wp?wiki` |
| `:Foo:Bar` | a page, from the top of the notebook |
| `+Bar` | a sub-page of the page holding the link |
| `Foo#id`, `:Foo#id` | a place in that page |
| `Bar`, `Foo:Bar` | looked up **beside the page, then beside each of its parents**: the first section above the page that has a page named like the first part wins, and the rest follows it |

A link to a page that doesn't exist yet still says which page it means: the one that would be
created beside the page holding the link (or where the first part was found). `link_to(from, to)`
writes the shortest text that resolves to `to` (`+Sub`, then the shortest tail of the name, then
`:Full:Name`), *checking each candidate by resolving it*, because a short name can be shadowed by
another page found nearer. A heading's id is its text in lower case, spaces as `-`, everything else
but letters, digits, `_` and `-` dropped (`Link to a heading or object` is `link-to-a-heading-or-object`,
the manual's own example).

## Files (`files.rs`)

Zim keeps a page's attachments in the folder named like the page: `Usage/GTD_flowchart.png` is an
attachment of `Usage`, and the same folder holds the page's sub-pages. A reference to a file in a
page (`{{./a.png}}`, `[[../report.pdf]]`) is a path relative to *that folder*, so `./` is the page's
own attachments and `../` is the folder above, where its text file is. (Zim's manual does exactly
this: `Usage:Getting Things Done` has `{{../GTD_flowchart.png}}`; of the manual's 25 image
references, all lead to a file that is there.) The crate knows paths only, never bytes.

| Reference | Leads to |
|---|---|
| `./a.png`, `a.png`, `sub/a.png`, `../a.png`, `.\a.png` | the file in the page's folder (or below, or above it), compared without regard to case; `%20`-style escapes are decoded if the path as written isn't there |
| `/abs`, `~/x`, `C:\x`, `\\host\share`, `https://…`, `file://…` | outside the notebook |
| `../..` past the top of the notebook | outside the notebook |

A reference to a file that isn't there still says where it would be. `relative_file_text` writes
the text that leads to a file from a page (`./a.png`, `../a.png`), checked by resolving it.
`safe_file_name` and `Notebook::attachment_path` name a new attachment so that it can't break a
link or an image (no `/ \ ? # | [ ] { } < > : * " %`, no leading dot) and doesn't clash with another
file, a folder or a page (`a.png`, `a 2.png`, …). `images_in` reads `{{path?query|alt}}` (the
parser's own reading, `zim_format::inline::parse_image`).

Three things a notebook of files has to keep true, because Zim and a file system would not:

* **No file ends in `.txt`.** Zim reads every `.txt` in a notebook folder as a page, so an attachment
  with that name would come back as a page (or be dropped as one that isn't UTF-8) after an export.
  `check_file_path` refuses such a path and `safe_file_name` gives it `.text` after it
  (`notes.txt` is stored as `notes.txt.text`).
* **A path is not both a file and a folder.** `put_file` refuses a path that has a file above it or
  files below it; `attachment_path` never picks the name of a folder some file is in, nor of a page
  or section below the page (an attachment `Sub` beside the page `A:Sub`), and refuses a page whose
  folder would be a file; a rename that would put a moved file on a folder of files that stay (or a
  page's folder on a file that stays) is refused, changing nothing (`FileAndFolder`).
* **What is written to refer to a file refers to it.** `relative_file_text` writes the characters
  that would break a reference (`% ? | # [ ] { }`) as `%XX`, which resolution reads back, and a name
  that would read as something else (`~x`, `C:x`) gets `./`. A link needs a `/` in it to be a file
  link at all, so a link rewritten by a rename keeps one (`../a.pdf` becomes `./a.pdf`, never
  `a.pdf`, which would be a link to a page); an image may stay bare. (A file named like another's
  escaped name, `a%7Cb.png` beside `a|b.png`, is found as written first, which hides the other from
  references; only an import can make such a pair.)

**Rename moves the folder too**: a page and everything below it take the files in their folders
along (`Foo/a.png` to `Bar/a.png`), also those of a section with no text of its own, and a move that
would put a file on another one is refused, changing nothing. With `update_links`, **every
reference that led to a file still does**: `./` references move with their page and need nothing,
`../` references (and references on other pages to files that moved) are rewritten as the shortest
`./` or `../` path that leads there from the page's new place, keeping the style it had (`a.png`
stays without `./`). References to nothing, or outside the notebook, are left as written.

## Notebook (`notebook.rs`)

`Notebook` holds `name -> text` and derives the rest: `tree()` (sections and pages in display order,
case-insensitive, sections with no text marked), `backlinks(page)` (pages with a link that *resolves*
to it, with the line of the first), `search(words)` (every word in the name or in the text as a
person reads it, name matches first), `resolve`, `link_to`, and `rename(old, new, update_links)`.

**Search reads the page, not its markup.** Each page keeps `plain_text(text)` (`zim-format`,
`plain.rs`): the text without what the editor hides when the caret is elsewhere (heading markers and
the header block, `**`, `//`, link brackets and the target of `[[target|shown]]`, bullets and
checkbox glyphs, rules, image and anchor sources). Searching for `bold` finds `**bold**`; searching
for `**` finds nothing; a code block is searched as written because it is shown as written. Snippets
and backlink contexts are cut from the same text, so they read as prose.

**Rename** moves the page and everything below it (`Foo` and `Foo:Bar` become `Baz` and `Baz:Bar`).
With `update_links`, **every link that led to an existing page still leads to it afterwards**:
links to moved pages are rewritten, and so are relative links on moved pages and any link whose
meaning changed because a moved page now shadows (or no longer shadows) a name. A link keeps its
character where it can (`:Absolute` stays absolute, `+Child` stays a child link) and its `#anchor`;
links that led nowhere are left exactly as written; only link *targets* are edited. A section that
only existed because of the pages that moved away is gone, and a link to it names a missing page.
A rename that can't be done (nothing there, onto a page that exists, below itself) changes nothing.

## Tags (`tags.rs`)

Every page keeps the `@tags` it writes, found once when its text is set (`tags_in`, which is the format
crate's own spans: a tag is wherever the parser says one is, see the spec §3.4). `Notebook::tags()` lists every
tag with its pages (by name, case ignored: `@Garden` and `@garden` are one tag, spelled as the first page that
has it, in name order, spells it), `pages_with_tag(tag)` and `tags_of(page)` answer for one tag and one page,
and **`search` takes `@tag` words**: `@garden beans` is the pages that write exactly `@garden` (not
`@gardening`: a part of a tag is no tag) and have the word `beans`; a tag found scores above a word, and its
snippet is cut where the tag is. A bare `@` is an ordinary word.

## The journal (`journal.rs`)

A day of the journal is the page `Journal:YYYY:MM:DD` (four, two and two digits, zero-filled, a day that exists,
`Journal` in any case: `Journal:2026:1:9` and `Journal:2026:02:30` are pages, not days, and so is anything below a
day: `Journal:2026:10:09:Notes`). `Day::new` checks the date (leap years by the Gregorian rule), `Day::page()` names it,
`Day::of_page(name)` is its inverse, `Day::weekday()` (Monday is 0) and `Day::title()` (`Friday 09 October 2026`, in
English) say which day it is, and `Day::page_text(created)` is the text a page of that day starts with: the header
and the title as its heading. `Notebook::journal_days(year, month)` lists the days of a month that have a page with
text (a section only holds pages: `Journal:2026:10:05:Child` does not make the 5th a day). The calendar in the web app
only draws this; its grid of weeks uses the browser's own dates and a test checks the two agree on every day from
1900 to 2100.

## Completing a link (`complete.rs`)

`Notebook::complete_link(from, typed, limit)`: the pages (and sections: a link to one is a link) that the link
`[[typed` written on page `from` can be completed to, best first. Ranked by how the typed text (case ignored) meets
the name: it is the last part of the name, the name's last part starts with it, the whole name does, a part of it does,
it is somewhere in it; ties go to the page nearer the top of the notebook, then to the name. `+typed` looks only below
`from` (named from there), `:typed` only for names that start with it, and a bracket in the text gets nothing (it can't be
written in a link's target; a `#` or `|` is in no page's name, so it finds nothing by itself). A page is not offered a
link to itself, nor one whose name has a bracket in it (no link to it can be written: the link text would end where the
bracket is), and such a page does not take the place of one that can be linked to. Each answer comes with **the text to write**:
`link_to(from, page)`, the shortest link that leads there from `from`, checked and not guessed (`+Garden`, `Garden`,
`Projects:Garden`, `:Full:Name`), so what is inserted always leads to the page that was chosen: a property test
resolves every suggestion over random notebooks from random pages.

## What verifies it

* Tests: hand-written cases, including the manual's own worked example of relative links, search
  and snippets over text with markup in it, and `tests/files.rs` (resolution, relative text,
  attachment names, images, and every rename behaviour for files).
* The random rename test (6,000 notebooks) now also has files in the page folders, in folders no page
  has, and at the top, with names that would break a reference if written as they are (`w?.png`,
  `p|q.png`, `~t.png`, …), and pages that refer to them in every style (right, wrong, outside, shouting
  in capitals). The references are written by a function in the test itself, not by the library's
  (a test that generates its inputs with the code under test cannot see that code's mistakes: this one
  did not, at first, see references that were not escaped). After each rename it checks that every
  reference that led to a file still does, that a rewritten link is still a file link, that the files
  moved are exactly those in the renamed folder, and that a refused rename moved nothing. Breaking the
  rewrite, losing a moved file, not refusing a file clash, not escaping, or letting a link lose its
  slash each fail it.
* **Zim's own manual notebook** (81 pages): all 301 page links resolve to existing pages. Weakening
  the lookup to "beside the page only" breaks 79 of them, and dropping underscore-as-space breaks
  161, so the test does discriminate.
* Tags, journal days and link completion have tests of their own (`tests/tags.rs`, `tests/journal.rs` (every day from
  1900 to 2100 follows the one before, checked without the code's own calendar), `tests/complete.rs`).
* Property tests on random notebooks of colliding names (`a:b:c`, `a:c`, ...): `link_to` always
  leads to the page asked for (20,000 cases); after a random rename every link still leads to the
  same (renamed) page, pages change in nothing but link targets, refused renames change nothing
  (6,000 cases); backlinks equal a brute-force count (300 notebooks).
* The same rename invariant on the real manual for eight renames (a section moving down a level, a
  nested page to the top, ...): `Help` to `Docs:Handbook` moves 27 pages and rewrites 77 links, and
  every link still leads where it did; `Plugins` to `Addons` moves 40 pages and 32 files and
  rewrites 43 links. Every one of the manual's 25 image references leads to a file that is there.
  Run with `scripts/zim-golden.sh`.

## Not covered yet

Unicode normalization (macOS file systems return decomposed names), Windows reserved names (`CON`),
a folder that holds only attachments as a section of the tree (the files are kept and moved with
their section; the folder is not a page), the `href` of an image when its page is renamed, the
tag hierarchies and pages for tags, a journal of weeks or months (only days), titles of days in other
languages than English, and full-text search beyond word matching (the core's SQLite FTS covers
encrypted notebooks). The notebook's `home` page is the web app's business (`zim-web-app.md`): it
comes from `notebook.zim` and follows the page when it is renamed.
