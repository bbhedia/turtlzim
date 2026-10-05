//! Shared test helpers. Lives under `tests/common/` (not `tests/common.rs`) so
//! cargo does not treat it as its own test binary.

#![allow(dead_code)]

use std::collections::HashMap;

use zim_format::highlight::{list_marker, opaque, VERBATIM_UNTERMINATED};
use zim_format::{Block, Inline, Page, Span, SpanKind};

/// Assert that parsing then serializing `input` reproduces it byte-for-byte
/// (the spec §4 golden-file round-trip requirement).
pub fn assert_roundtrip(input: &str) {
    let page = zim_format::parse(input);
    let output = page.serialize();
    assert_eq!(
        output, input,
        "round-trip mismatch\n--- expected ---\n{input:?}\n--- got ---\n{output:?}"
    );
}

/// Assert that `text`'s spans keep every guarantee of `zim_format::highlight`.
pub fn assert_spans_well_formed(text: &str) {
    if let Some(problem) = span_problem(text) {
        panic!("{problem}\n  text: {text:?}");
    }
}

/// What is wrong with the spans of `text`, if anything: the guarantees in the module docs of
/// `zim_format::highlight`, plus that each span's text has the delimiters of its kind and that the
/// spans agree with the parsed tree about how many constructs there are.
pub fn span_problem(text: &str) -> Option<String> {
    let page = zim_format::parse(text);
    let spans = page.spans();
    check_spans(text, &page, &spans).err()
}

fn check_spans(text: &str, page: &Page, spans: &[Span]) -> Result<(), String> {
    let mut open: Vec<usize> = Vec::new();
    for (i, s) in spans.iter().enumerate() {
        let ctx = |msg: &str| {
            let shown = text.get(s.start..s.end).unwrap_or("<not a valid slice>");
            format!(
                "span {i} {:?} {}..{} detail {} {shown:?}: {msg}",
                s.kind, s.start, s.end, s.detail
            )
        };
        if !(s.start < s.end
            && s.end <= text.len()
            && text.is_char_boundary(s.start)
            && text.is_char_boundary(s.end))
        {
            return Err(ctx("out of bounds, empty, or not on char boundaries"));
        }
        if i > 0 {
            let p = &spans[i - 1];
            if !(p.start < s.start || (p.start == s.start && p.end >= s.end)) {
                return Err(ctx("not in pre-order after the previous span"));
            }
        }
        // `open` holds the chain of spans that contain the current position.
        while open.last().is_some_and(|&top| spans[top].end <= s.start) {
            open.pop();
        }
        if let Some(&top) = open.last() {
            if s.end > spans[top].end {
                return Err(ctx(&format!("partly overlaps span {top}")));
            }
        }
        if s.kind == SpanKind::Marker {
            let owner = s.detail as usize;
            if owner >= i || open.last() != Some(&owner) {
                return Err(ctx("marker is not a direct child of its owner"));
            }
        }
        open.push(i);
        content_problem(text, spans, i).map_err(|m| ctx(&m))?;
    }
    count_problem(page, spans)
}

fn delimited(t: &str, open: &str, close: &str) -> bool {
    t.len() >= open.len() + close.len() && t.starts_with(open) && t.ends_with(close)
}

fn at_line_start(text: &str, at: usize) -> bool {
    at == 0 || text.as_bytes()[at - 1] == b'\n'
}

fn content_problem(text: &str, spans: &[Span], i: usize) -> Result<(), String> {
    let s = &spans[i];
    let t = &text[s.start..s.end];
    let ok = match s.kind {
        SpanKind::Header => s.start == 0 && at_line_start(text, s.start),
        SpanKind::HeaderKey => {
            at_line_start(text, s.start) && t.ends_with(':') && !t.contains(char::is_whitespace)
        }
        SpanKind::Heading => {
            let bars = "=".repeat(7usize.saturating_sub(s.detail as usize));
            (1..=5).contains(&s.detail)
                && at_line_start(text, s.start)
                && !t.contains('\n')
                && t.starts_with(&format!("{bars} "))
                && t.ends_with(&format!(" {bars}"))
        }
        SpanKind::IndentedParagraph => {
            s.detail > 0 && at_line_start(text, s.start) && t.lines().all(|l| l.starts_with('\t'))
        }
        SpanKind::ListItem => at_line_start(text, s.start) && !t.contains('\n'),
        SpanKind::ListMarker => list_marker_ok(t, s.detail),
        SpanKind::VerbatimBlock => {
            let first = t.lines().next().unwrap_or("").trim_start_matches('\t');
            let last = t.lines().last().unwrap_or("").trim_start_matches('\t');
            let closed = s.detail & VERBATIM_UNTERMINATED == 0;
            at_line_start(text, s.start)
                && first == "'''"
                && (!closed || (t.lines().count() >= 2 && last == "'''"))
        }
        SpanKind::HorizontalRule => t.len() == s.detail as usize && t.chars().all(|c| c == '-'),
        SpanKind::Opaque => {
            let object = t.trim_start_matches('\t').starts_with("{{{");
            (s.detail == opaque::OBJECT) == object
                && (s.detail == opaque::OBJECT || s.detail == opaque::TABLE)
        }
        SpanKind::Marker => {
            let owner = spans[s.detail as usize].kind;
            let allowed: &[&str] = match owner {
                SpanKind::Bold => &["**"],
                SpanKind::Italic => &["//"],
                SpanKind::Underline => &["__"],
                SpanKind::Strike => &["~~"],
                SpanKind::InlineVerbatim => &["''"],
                SpanKind::Superscript => &["^{", "}"],
                SpanKind::Subscript => &["_{", "}"],
                SpanKind::Link => &["[[", "|", "]]"],
                SpanKind::Image => &["{{", "}}"],
                SpanKind::Anchor => &["{{id:", "}}"],
                SpanKind::VerbatimBlock => &["'''"],
                SpanKind::Heading => &[],
                other => return Err(format!("a marker can't be owned by {other:?}")),
            };
            if owner == SpanKind::Heading {
                t.chars().filter(|&c| c != '=').count() == 1 && t.trim_matches('=') == " "
            } else {
                allowed.contains(&t)
            }
        }
        SpanKind::Bold => delimited(t, "**", "**"),
        SpanKind::Italic => delimited(t, "//", "//"),
        SpanKind::Underline => delimited(t, "__", "__"),
        SpanKind::Strike => delimited(t, "~~", "~~"),
        SpanKind::InlineVerbatim => delimited(t, "''", "''"),
        SpanKind::Superscript => delimited(t, "^{", "}"),
        SpanKind::Subscript => delimited(t, "_{", "}"),
        SpanKind::Link => delimited(t, "[[", "]]"),
        SpanKind::LinkTarget | SpanKind::LinkDisplay => !t.contains("]]") && !t.is_empty(),
        SpanKind::Tag => t.len() > 1 && t.starts_with('@'),
        SpanKind::Image => delimited(t, "{{", "}}") && !t.starts_with("{{id:"),
        SpanKind::Anchor => delimited(t, "{{id:", "}}"),
        SpanKind::AutoUrl => ["https://", "http://", "file://", "ftp://", "mailto:"]
            .iter()
            .any(|scheme| t.starts_with(scheme)),
        SpanKind::AutoEmail => t.contains('@'),
    };
    if ok {
        Ok(())
    } else {
        Err("wrong text for its kind".to_string())
    }
}

fn list_marker_ok(t: &str, detail: u32) -> bool {
    let Some(token) = t.strip_suffix(' ') else {
        return false;
    };
    match detail {
        list_marker::BULLET => token == "*",
        list_marker::NUMBER => token
            .strip_suffix('.')
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())),
        list_marker::LOWER_ALPHA => {
            token.len() == 2 && token.ends_with('.') && token.as_bytes()[0].is_ascii_lowercase()
        }
        list_marker::UPPER_ALPHA => {
            token.len() == 2 && token.ends_with('.') && token.as_bytes()[0].is_ascii_uppercase()
        }
        list_marker::UNCHECKED => token == "[ ]",
        list_marker::CHECKED => token == "[*]",
        list_marker::XCHECKED => token == "[x]",
        list_marker::MIGRATED => token == "[>]",
        list_marker::TRANSMIGRATED => token == "[<]",
        _ => false,
    }
}

/// Every kind of construct the parsed tree holds, counted, to compare with the spans.
fn count_problem(page: &Page, spans: &[Span]) -> Result<(), String> {
    let mut want: HashMap<SpanKind, usize> = HashMap::new();
    let mut add = |kind: SpanKind, n: usize| *want.entry(kind).or_default() += n;

    if let Some(fields) = page.headers.as_ref().filter(|f| !f.is_empty()) {
        add(SpanKind::Header, 1);
        add(SpanKind::HeaderKey, fields.len());
    }
    for block in &page.body.blocks {
        match block {
            Block::Blank(_) => {}
            Block::Heading(h) => {
                add(SpanKind::Heading, 1);
                add(SpanKind::Marker, 2);
                count_inlines(&h.text, &mut add);
            }
            Block::Paragraph(p) => {
                if p.indent > 0 {
                    add(SpanKind::IndentedParagraph, 1);
                }
                count_inlines(&p.text, &mut add);
            }
            Block::List(l) => {
                for item in &l.items {
                    add(SpanKind::ListItem, 1);
                    add(SpanKind::ListMarker, 1);
                    count_inlines(&item.text, &mut add);
                }
            }
            Block::Verbatim(v) => {
                add(SpanKind::VerbatimBlock, 1);
                add(SpanKind::Marker, if v.closed { 2 } else { 1 });
            }
            Block::HorizontalRule(_) => add(SpanKind::HorizontalRule, 1),
            Block::Opaque(_) => add(SpanKind::Opaque, 1),
        }
    }

    let mut got: HashMap<SpanKind, usize> = HashMap::new();
    for s in spans {
        *got.entry(s.kind).or_default() += 1;
    }
    for kind in SpanKind::ALL {
        let (w, g) = (
            want.get(kind).copied().unwrap_or(0),
            got.get(kind).copied().unwrap_or(0),
        );
        if w != g {
            return Err(format!("the tree holds {w} {kind:?}, the spans {g}"));
        }
    }
    Ok(())
}

fn count_inlines(nodes: &[Inline], add: &mut impl FnMut(SpanKind, usize)) {
    for node in nodes {
        match node {
            Inline::Text(_) => {}
            Inline::Bold(c) => {
                add(SpanKind::Bold, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Italic(c) => {
                add(SpanKind::Italic, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Underline(c) => {
                add(SpanKind::Underline, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Strike(c) => {
                add(SpanKind::Strike, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Superscript(c) => {
                add(SpanKind::Superscript, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Subscript(c) => {
                add(SpanKind::Subscript, 1);
                add(SpanKind::Marker, 2);
                count_inlines(c, add);
            }
            Inline::Verbatim(_) => {
                add(SpanKind::InlineVerbatim, 1);
                add(SpanKind::Marker, 2);
            }
            Inline::Link(l) => {
                add(SpanKind::Link, 1);
                add(SpanKind::Marker, 2 + usize::from(l.display.is_some()));
                if !l.target.is_empty() {
                    add(SpanKind::LinkTarget, 1);
                }
                if l.display.as_ref().is_some_and(|d| !d.is_empty()) {
                    add(SpanKind::LinkDisplay, 1);
                }
            }
            Inline::Tag(_) => add(SpanKind::Tag, 1),
            Inline::Image(_) => {
                add(SpanKind::Image, 1);
                add(SpanKind::Marker, 2);
            }
            Inline::Anchor(_) => {
                add(SpanKind::Anchor, 1);
                add(SpanKind::Marker, 2);
            }
            Inline::AutoUrl(_) => add(SpanKind::AutoUrl, 1),
            Inline::AutoEmail(_) => add(SpanKind::AutoEmail, 1),
        }
    }
}
