//! Block-level structure of a page body (spec §1.2 and §2).

use crate::inline::{parse_inline, render_inline, Inline};

/// One block of the page body, in original order.
///
/// The body is a strict partition of the original lines: every line belongs
/// to exactly one block (including blank lines, via [`Block::Blank`]), in
/// order, with none dropped or added. Rendering every block back to its
/// lines and joining them with `"\n"` therefore always reproduces the
/// original body text exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// A run of one or more consecutive blank lines (spec §2.2: "multiple
    /// consecutive blank lines must be preserved exactly").
    Blank(usize),
    Heading(Heading),
    Paragraph(Paragraph),
    List(ListBlock),
    Verbatim(Verbatim),
    HorizontalRule(HorizontalRule),
    /// A table or object block (spec §2.6): out of scope for v1, stored as
    /// an exact raw line span so it still round-trips losslessly.
    Opaque(Opaque),
}

/// `====== text ======` .. `== text ==` (spec §2.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    /// Heading level, 1 (page title, `======`) through 5 (`==`).
    pub level: u8,
    /// Parsed inline content between the marker runs. May itself contain an
    /// anchor (spec §2.1); tags are not recognized here (spec §3.4).
    pub text: Vec<Inline>,
}

/// A paragraph, optionally an indented paragraph (spec §2.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    /// Number of leading tabs common to every line of this paragraph (0 for
    /// an ordinary, non-indented paragraph).
    pub indent: usize,
    /// Parsed inline content of the dedented, newline-joined paragraph text.
    /// Original line breaks are preserved as literal `'\n'` characters
    /// inside [`Inline::Text`] spans.
    pub text: Vec<Inline>,
}

/// List item marker kinds (spec §2.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListMarker {
    /// `* item`
    Bullet,
    /// `1. item` / `a. item` / `A. item`. `start_token` is the exact token
    /// text before the `.` (e.g. `"1"`, `"a"`, `"C"`), stored verbatim so
    /// arbitrary starting values round-trip.
    Numbered {
        style: NumberStyle,
        start_token: String,
    },
    /// `[ ]` / `[*]` / `[x]` / `[>]` / `[<]`
    Checkbox(CheckboxState),
}

/// The numbering scheme of a [`ListMarker::Numbered`] item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumberStyle {
    Arabic,
    LowerAlpha,
    UpperAlpha,
}

/// The five distinct checkbox states (spec §2.3) — kept as a closed enum
/// rather than a boolean so all five round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckboxState {
    /// `[ ]`
    Unchecked,
    /// `[*]`
    Checked,
    /// `[x]` ("xchecked" / crossed out)
    Xchecked,
    /// `[>]` (migrated)
    Migrated,
    /// `[<]` (transmigrated)
    Transmigrated,
}

impl CheckboxState {
    fn glyph(self) -> char {
        match self {
            CheckboxState::Unchecked => ' ',
            CheckboxState::Checked => '*',
            CheckboxState::Xchecked => 'x',
            CheckboxState::Migrated => '>',
            CheckboxState::Transmigrated => '<',
        }
    }
}

/// One line of a list block.
///
/// Nesting is represented directly by `indent` (leading-tab count), per
/// spec §2.3 ("nesting ... determined by leading-tab count"), rather than by
/// an artificial tree — this is both simpler and safer for exact
/// round-trip. Consumers that want a hierarchical view can group items by
/// `indent` themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListItem {
    pub indent: usize,
    pub marker: ListMarker,
    pub text: Vec<Inline>,
}

/// A contiguous run of list items (spec §2.3). Bullet, numbered, and
/// checkbox items may be freely mixed as siblings/children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListBlock {
    pub items: Vec<ListItem>,
}

/// A `'''` ... `'''` preformatted block (spec §2.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verbatim {
    /// Leading-tab count of the opening (and, if closed, closing) delimiter.
    pub indent: usize,
    /// Content lines with the block's base `indent` stripped; any *extra*
    /// indentation on a given line beyond the base is preserved as part of
    /// its text (spec §2.4).
    pub content_lines: Vec<String>,
    /// `false` only for a malformed/unterminated block that ran to end of
    /// input without finding a matching closing `'''` line.
    pub closed: bool,
}

/// A horizontal rule: a bare line of `-` characters (spec §2.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalRule {
    /// Exact number of dashes, preserved so it round-trips byte-identical.
    pub dash_count: usize,
}

/// An opaque, not-semantically-parsed block: a table or object block
/// (spec §2.6). Stored as its exact original lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opaque {
    pub raw_lines: Vec<String>,
}

/// Minimum run length of `-` characters recognized as a horizontal rule.
/// The spec's own example uses 20; we require the same.
const HR_MIN_DASHES: usize = 20;

fn leading_tabs(line: &str) -> usize {
    line.chars().take_while(|&c| c == '\t').count()
}

/// Strip up to `n` leading tab characters from `line`. Returns the remainder
/// and how many tabs were actually stripped (fewer than `n` only for
/// malformed/under-indented input, which well-formed Zim files never
/// produce).
fn strip_leading_tabs(line: &str, n: usize) -> (&str, usize) {
    let mut count = 0usize;
    let mut idx = 0usize;
    for c in line.chars() {
        if count >= n || c != '\t' {
            break;
        }
        count += 1;
        idx += c.len_utf8();
    }
    (&line[idx..], count)
}

fn is_blank(line: &str) -> bool {
    line.is_empty()
}

fn is_heading_line(line: &str) -> Option<(u8, &str)> {
    let lead_eq = line.chars().take_while(|&c| c == '=').count();
    if !(2..=6).contains(&lead_eq) {
        return None;
    }
    let rest = &line[lead_eq..];
    let rest = rest.strip_prefix(' ')?;
    let trail_eq = rest.chars().rev().take_while(|&c| c == '=').count();
    if trail_eq != lead_eq {
        return None;
    }
    let rest2 = &rest[..rest.len() - trail_eq];
    let text = rest2.strip_suffix(' ')?;
    // Spec §2.1: "the remaining text is non-blank" -- not merely non-empty.
    // With more than one space of padding between the two marker runs, the
    // single strip_prefix/strip_suffix(' ') calls above only remove one
    // space from each side, so e.g. "===   ===" (three spaces) leaves one
    // literal space in `text`; that must still be rejected as a heading.
    if text.trim().is_empty() {
        return None;
    }
    let level = 7 - lead_eq as u8;
    Some((level, text))
}

fn is_verbatim_start(line: &str) -> Option<usize> {
    let indent = leading_tabs(line);
    if &line[indent..] == "'''" {
        Some(indent)
    } else {
        None
    }
}

fn is_object_block_start(line: &str) -> Option<usize> {
    let indent = leading_tabs(line);
    if line[indent..].starts_with("{{{") {
        Some(indent)
    } else {
        None
    }
}

fn is_table_line(line: &str) -> bool {
    line.len() >= 2 && line.starts_with('|') && line.ends_with('|')
}

fn is_horizontal_rule(line: &str) -> Option<usize> {
    if !line.is_empty() && line.chars().all(|c| c == '-') && line.len() >= HR_MIN_DASHES {
        Some(line.len())
    } else {
        None
    }
}

fn parse_list_item_line(line: &str) -> Option<(usize, ListMarker, &str)> {
    let indent = leading_tabs(line);
    let rest = &line[indent..];
    if rest.is_empty() {
        return None;
    }

    if let Some(t) = rest.strip_prefix("* ") {
        return Some((indent, ListMarker::Bullet, t));
    }

    const CHECKS: &[(&str, CheckboxState)] = &[
        ("[ ] ", CheckboxState::Unchecked),
        ("[*] ", CheckboxState::Checked),
        ("[x] ", CheckboxState::Xchecked),
        ("[>] ", CheckboxState::Migrated),
        ("[<] ", CheckboxState::Transmigrated),
    ];
    for (lit, state) in CHECKS {
        if let Some(t) = rest.strip_prefix(lit) {
            return Some((indent, ListMarker::Checkbox(*state), t));
        }
    }

    let digit_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digit_len > 0 {
        let after = &rest[digit_len..];
        if let Some(t) = after.strip_prefix(". ") {
            return Some((
                indent,
                ListMarker::Numbered {
                    style: NumberStyle::Arabic,
                    start_token: rest[..digit_len].to_string(),
                },
                t,
            ));
        }
    }

    let mut chars = rest.char_indices();
    if let Some((_, c)) = chars.next() {
        if c.is_ascii_alphabetic() {
            let clen = c.len_utf8();
            let after = &rest[clen..];
            if let Some(t) = after.strip_prefix(". ") {
                let style = if c.is_ascii_lowercase() {
                    NumberStyle::LowerAlpha
                } else {
                    NumberStyle::UpperAlpha
                };
                return Some((
                    indent,
                    ListMarker::Numbered {
                        style,
                        start_token: c.to_string(),
                    },
                    t,
                ));
            }
        }
    }

    None
}

fn is_special_line(line: &str) -> bool {
    is_blank(line)
        || is_heading_line(line).is_some()
        || is_verbatim_start(line).is_some()
        || is_object_block_start(line).is_some()
        || is_table_line(line)
        || is_horizontal_rule(line).is_some()
        || parse_list_item_line(line).is_some()
}

/// Find the end (inclusive index) of a `'''`-delimited block or `{{{`
/// object block, whichever `closer` is used, honoring the "same indent"
/// nesting-safety rule (spec §2.4): a candidate closing line only closes the
/// block if, after stripping exactly `indent` leading tabs, its text is
/// exactly `closer`.
fn find_block_end(lines: &[&str], start: usize, indent: usize, closer: &str) -> Option<usize> {
    let mut j = start + 1;
    while j < lines.len() {
        let (stripped, n) = strip_leading_tabs(lines[j], indent);
        if n == indent && stripped == closer {
            return Some(j);
        }
        j += 1;
    }
    None
}

/// Parse a page body into blocks.
pub fn parse_blocks(lines: &[&str]) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];

        if is_blank(line) {
            let start = i;
            while i < lines.len() && is_blank(lines[i]) {
                i += 1;
            }
            blocks.push(Block::Blank(i - start));
            continue;
        }

        if let Some((level, text)) = is_heading_line(line) {
            blocks.push(Block::Heading(Heading {
                level,
                text: parse_inline(text, false),
            }));
            i += 1;
            continue;
        }

        if let Some(indent) = is_verbatim_start(line) {
            match find_block_end(lines, i, indent, "'''") {
                Some(end) => {
                    let content_lines = lines[i + 1..end]
                        .iter()
                        .map(|l| strip_leading_tabs(l, indent).0.to_string())
                        .collect();
                    blocks.push(Block::Verbatim(Verbatim {
                        indent,
                        content_lines,
                        closed: true,
                    }));
                    i = end + 1;
                }
                None => {
                    let content_lines = lines[i + 1..]
                        .iter()
                        .map(|l| strip_leading_tabs(l, indent).0.to_string())
                        .collect();
                    blocks.push(Block::Verbatim(Verbatim {
                        indent,
                        content_lines,
                        closed: false,
                    }));
                    i = lines.len();
                }
            }
            continue;
        }

        if is_object_block_start(line).is_some() {
            let indent = leading_tabs(line);
            let end = find_block_end(lines, i, indent, "}}}").unwrap_or(lines.len() - 1);
            let end = end.min(lines.len() - 1);
            let raw_lines = lines[i..=end].iter().map(|l| l.to_string()).collect();
            blocks.push(Block::Opaque(Opaque { raw_lines }));
            i = end + 1;
            continue;
        }

        if is_table_line(line) {
            let start = i;
            while i < lines.len() && is_table_line(lines[i]) {
                i += 1;
            }
            let raw_lines = lines[start..i].iter().map(|l| l.to_string()).collect();
            blocks.push(Block::Opaque(Opaque { raw_lines }));
            continue;
        }

        if let Some(n) = is_horizontal_rule(line) {
            blocks.push(Block::HorizontalRule(HorizontalRule { dash_count: n }));
            i += 1;
            continue;
        }

        if parse_list_item_line(line).is_some() {
            let start = i;
            let mut items = Vec::new();
            while i < lines.len() {
                match parse_list_item_line(lines[i]) {
                    Some((indent, marker, text)) => {
                        items.push(ListItem {
                            indent,
                            marker,
                            text: parse_inline(text, true),
                        });
                        i += 1;
                    }
                    None => break,
                }
            }
            debug_assert!(i > start);
            blocks.push(Block::List(ListBlock { items }));
            continue;
        }

        // Default: a paragraph run — consecutive lines matching none of the
        // more specific block types above.
        {
            let start = i;
            while i < lines.len() && !is_special_line(lines[i]) {
                i += 1;
            }
            let run = &lines[start..i];
            let indent = run.iter().map(|l| leading_tabs(l)).min().unwrap_or(0);
            let dedented: Vec<&str> = run
                .iter()
                .map(|l| strip_leading_tabs(l, indent).0)
                .collect();
            let joined = dedented.join("\n");
            blocks.push(Block::Paragraph(Paragraph {
                indent,
                text: parse_inline(&joined, true),
            }));
        }
    }
    blocks
}

/// Render all blocks back to the original body lines, in order.
pub fn render_blocks(blocks: &[Block]) -> Vec<String> {
    let mut lines = Vec::new();
    for b in blocks {
        render_block(b, &mut lines);
    }
    lines
}

fn render_block(b: &Block, lines: &mut Vec<String>) {
    match b {
        Block::Blank(n) => {
            for _ in 0..*n {
                lines.push(String::new());
            }
        }
        Block::Heading(h) => {
            let marker = "=".repeat(7 - h.level as usize);
            lines.push(format!("{marker} {} {marker}", render_inline(&h.text)));
        }
        Block::Paragraph(p) => {
            let flat = render_inline(&p.text);
            let tabs = "\t".repeat(p.indent);
            for line in flat.split('\n') {
                lines.push(format!("{tabs}{line}"));
            }
        }
        Block::List(lb) => {
            for item in &lb.items {
                let tabs = "\t".repeat(item.indent);
                let marker = match &item.marker {
                    ListMarker::Bullet => "*".to_string(),
                    ListMarker::Numbered { start_token, .. } => format!("{start_token}."),
                    ListMarker::Checkbox(state) => format!("[{}]", state.glyph()),
                };
                lines.push(format!("{tabs}{marker} {}", render_inline(&item.text)));
            }
        }
        Block::Verbatim(v) => {
            let tabs = "\t".repeat(v.indent);
            lines.push(format!("{tabs}'''"));
            for l in &v.content_lines {
                lines.push(format!("{tabs}{l}"));
            }
            if v.closed {
                lines.push(format!("{tabs}'''"));
            }
        }
        Block::HorizontalRule(hr) => {
            lines.push("-".repeat(hr.dash_count));
        }
        Block::Opaque(op) => {
            lines.extend(op.raw_lines.iter().cloned());
        }
    }
}
