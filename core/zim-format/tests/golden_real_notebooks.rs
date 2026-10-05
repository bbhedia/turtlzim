//! Golden-file round trips against REAL Zim notebooks (CLAUDE.md: "Zim `.txt` round-trips must be
//! byte-identical -- write a golden-file test against real Zim notebooks early").
//!
//! Every other test in this crate uses fixtures composed for the purpose. This one reads pages
//! that Zim itself wrote, or that people wrote for Zim, so it finds what nobody thought to write
//! a fixture for.
//!
//! **The pages are not in this repository, on purpose.** Zim is GPLv2 and this project never
//! copies Zim material into the tree (CLAUDE.md). The corpus is whatever directories the
//! `ZIM_GOLDEN_DIR` environment variable names (a list separated like `PATH`); every `*.txt`
//! file below them is checked. Good corpora:
//!
//! * a checkout of the Zim project (`git clone --depth 1
//!   https://github.com/zim-desktop-wiki/zim-desktop-wiki`): `data/manual` is the user manual, a
//!   real notebook of 81 pages, and `tests/data` holds the edge cases its authors collected (a
//!   byte-order mark, a file that is not UTF-8);
//! * your own notebook.
//!
//! ```text
//! ZIM_GOLDEN_DIR=$HOME/.cache/turtlzim-labs/zim-desktop-wiki \
//!     cargo test -p zim-format --test golden_real_notebooks -- --ignored --nocapture
//! ```
//!
//! The tests are `#[ignore]`d rather than skipped when the variable is unset, so a plain `cargo
//! test` never reports a pass it didn't earn, and asking for them without a corpus is an error.
//!
//! What a page that is not valid UTF-8 means here: `parse` takes a `&str`, so such a file can't
//! reach the parser at all. Zim's pages are UTF-8 by definition, so the layer that reads
//! notebook files must refuse (or repair, visibly) a file that isn't; it must never lossily
//! convert and write it back. The census below lists these files so they are not silently lost.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

mod common;

use zim_format::{Block, Inline, Page};

/// Every `*.txt` file below the directories in `ZIM_GOLDEN_DIR`, in a stable order.
fn corpus() -> Vec<PathBuf> {
    let var = std::env::var_os("ZIM_GOLDEN_DIR").expect(
        "ZIM_GOLDEN_DIR is not set: point it at a directory of real Zim pages (see this file's \
         module docs)",
    );
    let mut files = Vec::new();
    for dir in std::env::split_paths(&var) {
        assert!(
            dir.is_dir(),
            "ZIM_GOLDEN_DIR entry {} is not a directory",
            dir.display()
        );
        collect_txt_files(&dir, &mut files);
    }
    assert!(
        !files.is_empty(),
        "no .txt files below ZIM_GOLDEN_DIR={var:?} -- wrong path?"
    );
    files
}

fn collect_txt_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        // `file_type` does not follow symlinks, so a link can neither loop nor leave the corpus.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            // `.git`, `.hg` and friends hold no pages.
            if !entry.file_name().to_string_lossy().starts_with('.') {
                collect_txt_files(&path, out);
            }
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "txt") {
            out.push(path);
        }
    }
}

/// Where `got` first departs from `expected`, for a failure message a person can act on.
fn first_difference(expected: &str, got: &str) -> String {
    for (i, (e, g)) in expected.split('\n').zip(got.split('\n')).enumerate() {
        if e != g {
            return format!("line {}: expected {e:?}, got {g:?}", i + 1);
        }
    }
    format!(
        "the common lines agree, but the line counts differ: expected {}, got {}",
        expected.split('\n').count(),
        got.split('\n').count()
    )
}

/// What the real pages contain, so "it round-trips" can be read next to "how much of it did the
/// parser actually understand". A lossless parser that files everything under `Opaque` would pass
/// the round-trip checks too; the numbers here are what show whether it does.
#[derive(Default)]
struct Census {
    files: usize,
    bytes: usize,
    lines: usize,
    with_headers: usize,
    with_byte_order_mark: usize,
    not_utf8: Vec<PathBuf>,
    blocks: BTreeMap<&'static str, usize>,
    inlines: BTreeMap<&'static str, usize>,
    opaque_lines: usize,
    unterminated_verbatim: usize,
    /// Files holding opaque blocks, with how many lines, so the next piece of the format to
    /// support can be chosen from evidence.
    opaque_in: BTreeMap<String, usize>,
}

impl Census {
    fn add(&mut self, path: &Path, text: &str, page: &Page) {
        self.lines += text.split('\n').count();
        self.with_headers += usize::from(page.headers.is_some());
        self.with_byte_order_mark += usize::from(text.starts_with('\u{feff}'));
        for block in &page.body.blocks {
            let (kind, spans): (&'static str, Vec<&[Inline]>) = match block {
                Block::Blank(_) => ("blank run", vec![]),
                Block::Heading(h) => ("heading", vec![&h.text]),
                Block::Paragraph(p) => (
                    if p.indent > 0 {
                        "indented paragraph"
                    } else {
                        "paragraph"
                    },
                    vec![&p.text],
                ),
                Block::List(l) => ("list", l.items.iter().map(|i| &i.text[..]).collect()),
                Block::Verbatim(v) => {
                    self.unterminated_verbatim += usize::from(!v.closed);
                    ("verbatim block", vec![])
                }
                Block::HorizontalRule(_) => ("horizontal rule", vec![]),
                Block::Opaque(o) => {
                    self.opaque_lines += o.raw_lines.len();
                    *self
                        .opaque_in
                        .entry(path.display().to_string())
                        .or_default() += o.raw_lines.len();
                    ("opaque block (table/object)", vec![])
                }
            };
            *self.blocks.entry(kind).or_default() += 1;
            for spans in spans {
                tally_inlines(spans, &mut self.inlines);
            }
        }
    }
}

fn tally_inlines(spans: &[Inline], into: &mut BTreeMap<&'static str, usize>) {
    for span in spans {
        let (name, children): (&'static str, &[Inline]) = match span {
            Inline::Text(_) => ("text", &[]),
            Inline::Bold(c) => ("bold", c),
            Inline::Italic(c) => ("italic", c),
            Inline::Underline(c) => ("underline", c),
            Inline::Strike(c) => ("strike", c),
            Inline::Verbatim(_) => ("verbatim", &[]),
            Inline::Superscript(c) => ("superscript", c),
            Inline::Subscript(c) => ("subscript", c),
            Inline::Link(_) => ("link", &[]),
            Inline::Tag(_) => ("tag", &[]),
            Inline::Image(_) => ("image", &[]),
            Inline::Anchor(_) => ("anchor", &[]),
            Inline::AutoUrl(_) => ("bare url", &[]),
            Inline::AutoEmail(_) => ("bare email", &[]),
        };
        *into.entry(name).or_default() += 1;
        tally_inlines(children, into);
    }
}

impl fmt::Display for Census {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "\n=== census of the real pages ===\n{} files read ({} bytes, {} lines); {} with a header \
             block, {} starting with a byte-order mark",
            self.files, self.bytes, self.lines, self.with_headers, self.with_byte_order_mark
        )?;
        for path in &self.not_utf8 {
            writeln!(f, "not UTF-8 (cannot reach the parser): {}", path.display())?;
        }
        writeln!(f, "blocks:")?;
        for (kind, n) in &self.blocks {
            writeln!(f, "  {n:>6}  {kind}")?;
        }
        writeln!(
            f,
            "  ({} unterminated verbatim)",
            self.unterminated_verbatim
        )?;
        writeln!(f, "inline spans:")?;
        for (kind, n) in &self.inlines {
            writeln!(f, "  {n:>6}  {kind}")?;
        }
        writeln!(f, "lines kept as opaque blocks: {}", self.opaque_lines)?;
        for (path, n) in &self.opaque_in {
            writeln!(f, "  {n:>6}  {path}")?;
        }
        Ok(())
    }
}

#[test]
#[ignore = "needs a corpus of real Zim pages: set ZIM_GOLDEN_DIR (see the module docs)"]
fn real_notebooks_round_trip_byte_for_byte() {
    let mut census = Census::default();
    let mut failures = Vec::new();
    let files = corpus();
    for path in &files {
        let bytes =
            std::fs::read(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        census.files += 1;
        census.bytes += bytes.len();
        let Ok(text) = String::from_utf8(bytes) else {
            census.not_utf8.push(path.clone());
            continue;
        };

        let page = zim_format::parse(&text);
        let again = page.serialize();
        if again != text {
            failures.push(format!(
                "{}: {}",
                path.display(),
                first_difference(&text, &again)
            ));
            continue;
        }
        // Parsing what we wrote must give the same page: otherwise one save would change what
        // the next load understands, even though the bytes happened to agree.
        if zim_format::parse(&again) != page {
            failures.push(format!(
                "{}: parse(serialize(parse(text))) != parse(text)",
                path.display()
            ));
        }
        census.add(path, &text, &page);
    }
    println!("{census}");
    assert!(
        failures.is_empty(),
        "{} of {} real pages did not round-trip:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n")
    );
}

/// Real pages, broken in the ways an interrupted save or a half-typed edit breaks them: cut off
/// after any line or in the middle of one, with any line gone, with any line doubled (which
/// flips every `'''` fence it touches). The parser has to stay lossless on all of these, because
/// the editor hands it exactly this kind of text between keystrokes.
#[test]
#[ignore = "needs a corpus of real Zim pages: set ZIM_GOLDEN_DIR (see the module docs)"]
fn real_notebooks_stay_lossless_when_damaged() {
    /// At most this many positions per page and kind of damage (long pages are sampled evenly).
    const MAX_POSITIONS: usize = 120;

    let mut checked = 0usize;
    let mut failures = Vec::new();
    for path in corpus() {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let lines: Vec<&str> = text.split('\n').collect();
        let stride = lines.len().div_ceil(MAX_POSITIONS).max(1);

        let mut check = |damage: &str, at: usize, variant: String| {
            checked += 1;
            let page = zim_format::parse(&variant);
            let again = page.serialize();
            if again != variant {
                failures.push(format!(
                    "{} ({damage} at line {}): {}",
                    path.display(),
                    at + 1,
                    first_difference(&variant, &again)
                ));
            } else if zim_format::parse(&again) != page {
                failures.push(format!(
                    "{} ({damage} at line {}): unstable parse",
                    path.display(),
                    at + 1
                ));
            } else if let Some(problem) = common::span_problem(&variant) {
                failures.push(format!(
                    "{} ({damage} at line {}): spans: {problem}",
                    path.display(),
                    at + 1
                ));
            }
        };

        for at in (0..=lines.len()).step_by(stride) {
            check("cut after", at, lines[..at].join("\n"));
            if let Some(line) = lines.get(at) {
                let mut half = line.len() / 2;
                while !line.is_char_boundary(half) {
                    half -= 1;
                }
                let mut cut = lines[..at].join("\n");
                if at > 0 {
                    cut.push('\n');
                }
                cut.push_str(&line[..half]);
                check("cut in the middle of", at, cut);
            }
        }
        for at in (0..lines.len()).step_by(stride) {
            let mut dropped = lines.clone();
            dropped.remove(at);
            check("line dropped", at, dropped.join("\n"));
            let mut doubled = lines.clone();
            doubled.insert(at, lines[at]);
            check("line doubled", at, doubled.join("\n"));
        }
    }
    println!("{checked} damaged variants of real pages checked");
    assert!(checked > 0, "no readable UTF-8 pages in the corpus");
    assert!(
        failures.is_empty(),
        "{} of {checked} damaged variants did not round-trip (first 20):\n{}",
        failures.len(),
        failures
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// The syntax spans an editor draws from, on real pages: bounds, order, nesting, marker ownership,
/// the delimiters of each kind, and counts that agree with the parsed tree
/// (`common::span_problem`). Also tallies what the pages contain, so a kind that never occurs in
/// real notebooks is visible.
#[test]
#[ignore = "needs a corpus of real Zim pages: set ZIM_GOLDEN_DIR (see the module docs)"]
fn real_notebooks_have_well_formed_spans() {
    let mut problems = Vec::new();
    let mut tally: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut files = 0usize;
    for path in corpus() {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        files += 1;
        if let Some(problem) = common::span_problem(&text) {
            problems.push(format!("{}: {problem}", path.display()));
            continue;
        }
        for span in zim_format::highlight(&text) {
            *tally.entry(span.kind.name()).or_default() += 1;
        }
    }
    println!("\nspans in {files} real pages:");
    for (kind, n) in &tally {
        println!("  {n:>6}  {kind}");
    }
    assert!(files > 0, "no readable UTF-8 pages in the corpus");
    assert!(
        problems.is_empty(),
        "{} pages have malformed spans:\n{}",
        problems.len(),
        problems.join("\n")
    );
}
