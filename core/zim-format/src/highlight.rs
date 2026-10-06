//! Where each construct of a page sits in its text, for editors.
//!
//! A live editor has to know which characters are a heading, which are bold, and which of those
//! are the `**` that make them bold. The parsed [`Page`] is a lossless tree but carries no
//! positions, so this module recovers them: it walks the tree in source order and adds up the
//! length of what each node renders to. That is exact because `parse(text).serialize() == text`
//! for every text (spec §4), and it leaves the parser untouched.
//!
//! [`highlight`] returns a flat list of [`Span`]s. Tests check these guarantees on fuzzed text and
//! on real notebooks:
//!
//! * offsets are byte offsets into the text, on `char` boundaries, with `start <= end <= len`
//!   ([`to_utf16`] converts them for JavaScript, whose strings count UTF-16 units);
//! * the list is in *pre-order*: sorted by `start`, and where two spans start together the outer
//!   (longer) one comes first;
//! * spans nest properly: any two are either disjoint or one contains the other;
//! * a [`SpanKind::Marker`] is the syntax characters of the construct that owns it (`**`, `[[`,
//!   the `======` around a heading ...). Its `detail` is the index in the list of that owner,
//!   always smaller than the marker's own, so an editor can dim or hide exactly those characters
//!   when the caret is elsewhere.
//!
//! The numeric codes of [`SpanKind`] and the `detail` values are an interface to JavaScript
//! (`core/zim-wasm` exports them, `web/src/kinds.ts` mirrors them, and a test keeps the two in
//! step): add new ones, never renumber.

use crate::block::{self, Block, CheckboxState, ListMarker, NumberStyle};
use crate::inline::{render_inline, rendered_len, rendered_len_one, Inline};
use crate::{parse, Page};

macro_rules! span_kinds {
    ($($(#[$doc:meta])* $name:ident = $code:expr,)*) => {
        /// What a [`Span`] covers.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[repr(u8)]
        pub enum SpanKind {
            $($(#[$doc])* $name = $code,)*
        }

        impl SpanKind {
            /// Every kind, in code order.
            pub const ALL: &'static [SpanKind] = &[$(SpanKind::$name,)*];

            /// The kind's name, as `core/zim-wasm` exports it to JavaScript.
            pub fn name(self) -> &'static str {
                match self {
                    $(SpanKind::$name => stringify!($name),)*
                }
            }

            /// The numeric code (what crosses to JavaScript).
            pub fn code(self) -> u8 {
                self as u8
            }
        }
    };
}

span_kinds! {
    /// The header block: all header lines, not the blank line after them.
    Header = 1,
    /// `Content-Type:`: a header's key and its colon. Lies inside a [`SpanKind::Header`].
    HeaderKey = 2,
    /// A heading, whole line. `detail` is the level, 1 to 5.
    Heading = 3,
    /// The lines of an indented paragraph. `detail` is the indent in tabs. Ordinary paragraphs
    /// have no span.
    IndentedParagraph = 4,
    /// One list item, whole line. `detail` is its indent in tabs.
    ListItem = 5,
    /// A list item's marker and the space after it: `* `, `1. `, `[ ] `. `detail` is one of
    /// [`list_marker`].
    ListMarker = 6,
    /// From the opening `'''` line through the closing one (or to the end of the page when it
    /// never closes). `detail` is the indent in tabs, plus [`VERBATIM_UNTERMINATED`] when there
    /// is no closing fence.
    VerbatimBlock = 7,
    /// A horizontal rule. `detail` is the number of dashes.
    HorizontalRule = 8,
    /// A table or an object block, kept as raw lines. `detail` is one of [`opaque`].
    Opaque = 9,
    /// The syntax characters of a construct, owned by the span at index `detail`.
    Marker = 10,
    /// `**bold**`, markers included.
    Bold = 11,
    /// `//italic//`
    Italic = 12,
    /// `__underline__`
    Underline = 13,
    /// `~~strikethrough~~`
    Strike = 14,
    /// `''verbatim''`
    InlineVerbatim = 15,
    /// `^{superscript}`
    Superscript = 16,
    /// `_{subscript}`
    Subscript = 17,
    /// `[[target|display]]`, brackets included.
    Link = 18,
    /// A link's target text. `detail` is 1 when the link has a display part, so a preview shows
    /// the display and hides this.
    LinkTarget = 19,
    /// A link's display text (after the `|`).
    LinkDisplay = 20,
    /// `@tag`
    Tag = 21,
    /// `{{path?query|alt}}`, braces included.
    Image = 22,
    /// `{{id: name}}`, braces included.
    Anchor = 23,
    /// A bare URL, autolinked.
    AutoUrl = 24,
    /// A bare email address, autolinked.
    AutoEmail = 25,
}

/// `detail` values of a [`SpanKind::ListMarker`].
pub mod list_marker {
    pub const BULLET: u32 = 1;
    /// `1.`
    pub const NUMBER: u32 = 2;
    /// `a.`
    pub const LOWER_ALPHA: u32 = 3;
    /// `A.`
    pub const UPPER_ALPHA: u32 = 4;
    /// `[ ]`
    pub const UNCHECKED: u32 = 10;
    /// `[*]`
    pub const CHECKED: u32 = 11;
    /// `[x]`
    pub const XCHECKED: u32 = 12;
    /// `[>]`
    pub const MIGRATED: u32 = 13;
    /// `[<]`
    pub const TRANSMIGRATED: u32 = 14;
}

/// `detail` values of a [`SpanKind::Opaque`].
pub mod opaque {
    pub const TABLE: u32 = 1;
    pub const OBJECT: u32 = 2;
}

/// Set in the `detail` of a [`SpanKind::VerbatimBlock`] that has no closing fence.
pub const VERBATIM_UNTERMINATED: u32 = 1 << 16;

/// One construct (or its syntax characters) and where it sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    /// First byte (UTF-16 unit after [`to_utf16`]).
    pub start: usize,
    /// One past the last.
    pub end: usize,
    pub kind: SpanKind,
    /// Kind-specific, see [`SpanKind`].
    pub detail: u32,
}

/// Parse `text` and return its spans (byte offsets).
pub fn highlight(text: &str) -> Vec<Span> {
    let spans = parse(text).spans();
    debug_assert!(spans.iter().all(|s| s.end <= text.len()));
    spans
}

impl Page {
    /// The spans of this page. Offsets are into `self.serialize()`, which is the text the page
    /// was parsed from.
    pub fn spans(&self) -> Vec<Span> {
        let mut walker = Walker {
            out: Vec::new(),
            pos: 0,
        };
        walker.page(self);
        walker.out
    }
}

/// For every byte offset of `text` (and the end), the matching offset in UTF-16 units, the unit of
/// JavaScript strings and CodeMirror positions. A byte inside a character maps to where that
/// character starts.
pub fn utf16_offsets(text: &str) -> Vec<usize> {
    let mut table = vec![0usize; text.len() + 1];
    let mut units = 0usize;
    for (b, ch) in text.char_indices() {
        for slot in &mut table[b..b + ch.len_utf8()] {
            *slot = units;
        }
        units += ch.len_utf16();
    }
    table[text.len()] = units;
    table
}

/// Convert byte offsets into UTF-16 offsets, the unit of JavaScript strings and CodeMirror
/// positions. `text` must be the text the spans were made from.
pub fn to_utf16(text: &str, spans: &[Span]) -> Vec<Span> {
    if spans.is_empty() {
        return Vec::new();
    }
    let table = utf16_offsets(text);
    spans.iter().map(|s| Span { start: table[s.start], end: table[s.end], ..*s }).collect()
}

/// Maps offsets in a block's inline text to offsets in the page.
///
/// The inline text of a paragraph is its lines with the common indent removed and joined by
/// `\n`; in the page every line carries those tabs again. Heading and list-item text sits on one
/// line, so it needs only a base.
struct Mapper {
    /// Page offset of the start of the block's first line (a paragraph) or of its text (others).
    base: usize,
    indent: usize,
    /// Offset in the inline text where each line starts.
    line_starts: Vec<usize>,
}

impl Mapper {
    fn flat(base: usize) -> Mapper {
        Mapper {
            base,
            indent: 0,
            line_starts: vec![0],
        }
    }

    fn paragraph(base: usize, indent: usize, text: &[Inline]) -> Mapper {
        let flat = render_inline(text);
        let mut line_starts = vec![0];
        line_starts.extend(flat.match_indices('\n').map(|(i, _)| i + 1));
        Mapper {
            base,
            indent,
            line_starts,
        }
    }

    /// The page offset of `offset` in the inline text: every line up to and including the one it
    /// is on contributes its leading tabs.
    fn at(&self, offset: usize) -> usize {
        let line = self.line_starts.partition_point(|&s| s <= offset) - 1;
        self.base + offset + (line + 1) * self.indent
    }
}

struct Walker {
    out: Vec<Span>,
    /// Page offset of the start of the next line.
    pos: usize,
}

impl Walker {
    fn push(&mut self, start: usize, end: usize, kind: SpanKind, detail: u32) -> usize {
        self.out.push(Span {
            start,
            end,
            kind,
            detail,
        });
        self.out.len() - 1
    }

    fn marker(&mut self, owner: usize, start: usize, end: usize) {
        self.push(start, end, SpanKind::Marker, owner as u32);
    }

    fn page(&mut self, page: &Page) {
        if let Some(fields) = &page.headers {
            if !fields.is_empty() {
                let header = self.push(self.pos, self.pos, SpanKind::Header, 0);
                let mut last_end = self.pos;
                for field in fields {
                    self.push(
                        self.pos,
                        self.pos + field.key.len() + 1,
                        SpanKind::HeaderKey,
                        0,
                    );
                    let first_line = field.key.len() + 1 + field.value_first_line.len();
                    last_end = self.pos + first_line;
                    self.pos += first_line + 1;
                    for continuation in &field.continuations {
                        last_end = self.pos + continuation.len();
                        self.pos += continuation.len() + 1;
                    }
                }
                self.out[header].end = last_end;
            }
            // The blank line between the header block and the body.
            self.pos += 1;
        }
        for b in &page.body.blocks {
            self.block(b);
        }
    }

    fn block(&mut self, b: &Block) {
        match b {
            Block::Blank(n) => self.pos += n,
            Block::Heading(h) => {
                let start = self.pos;
                let bars = 7 - h.level as usize;
                let idx = self.push(start, start, SpanKind::Heading, u32::from(h.level));
                self.marker(idx, start, start + bars + 1);
                let m = Mapper::flat(start + bars + 1);
                let mut cur = 0;
                self.inline(&h.text, &mut cur, &m);
                let text_end = m.at(cur);
                let end = text_end + 1 + bars;
                self.marker(idx, text_end, end);
                self.out[idx].end = end;
                self.pos = end + 1;
            }
            Block::Paragraph(p) => {
                let start = self.pos;
                let m = Mapper::paragraph(start, p.indent, &p.text);
                let block = (p.indent > 0)
                    .then(|| self.push(start, start, SpanKind::IndentedParagraph, p.indent as u32));
                let mut cur = 0;
                self.inline(&p.text, &mut cur, &m);
                let end = m.at(cur);
                if let Some(i) = block {
                    self.out[i].end = end;
                }
                self.pos = end + 1;
            }
            Block::List(list) => {
                for item in &list.items {
                    let line = self.pos;
                    let marker_len = match &item.marker {
                        ListMarker::Bullet => 1,
                        ListMarker::Numbered { start_token, .. } => start_token.len() + 1,
                        ListMarker::Checkbox(_) => 3,
                    };
                    let text_at = line + item.indent + marker_len + 1;
                    let end = text_at + rendered_len(&item.text);
                    self.push(line, end, SpanKind::ListItem, item.indent as u32);
                    self.push(
                        line + item.indent,
                        text_at,
                        SpanKind::ListMarker,
                        list_marker_code(&item.marker),
                    );
                    let m = Mapper::flat(text_at);
                    let mut cur = 0;
                    self.inline(&item.text, &mut cur, &m);
                    self.pos = end + 1;
                }
            }
            Block::Verbatim(v) => {
                let start = self.pos;
                let Some(end) = self.end_of_rendered(b) else {
                    return;
                };
                let unterminated = if v.closed { 0 } else { VERBATIM_UNTERMINATED };
                let idx = self.push(
                    start,
                    end,
                    SpanKind::VerbatimBlock,
                    v.indent as u32 | unterminated,
                );
                self.marker(idx, start + v.indent, start + v.indent + 3);
                if v.closed {
                    self.marker(idx, end - 3, end);
                }
                self.pos = end + 1;
            }
            Block::HorizontalRule(hr) => {
                let start = self.pos;
                self.push(
                    start,
                    start + hr.dash_count,
                    SpanKind::HorizontalRule,
                    hr.dash_count as u32,
                );
                self.pos = start + hr.dash_count + 1;
            }
            Block::Opaque(op) => {
                let start = self.pos;
                let Some(end) = self.end_of_rendered(b) else {
                    return;
                };
                let is_object = op
                    .raw_lines
                    .first()
                    .is_some_and(|l| l.trim_start_matches('\t').starts_with("{{{"));
                let detail = if is_object {
                    opaque::OBJECT
                } else {
                    opaque::TABLE
                };
                self.push(start, end, SpanKind::Opaque, detail);
                self.pos = end + 1;
            }
        }
    }

    /// Where the lines of a block that has no inline content end (the end of its last line), or
    /// `None` for a block with no lines (only possible for a hand-built one).
    fn end_of_rendered(&self, b: &Block) -> Option<usize> {
        let mut lines = Vec::new();
        block::render_block(b, &mut lines);
        let last = lines.len().checked_sub(1)?;
        Some(self.pos + lines.iter().map(|l| l.len()).sum::<usize>() + last)
    }

    /// Spans for inline `nodes` whose text starts at offset `*cur` of the block's inline text;
    /// leaves `*cur` just past them.
    fn inline(&mut self, nodes: &[Inline], cur: &mut usize, m: &Mapper) {
        for node in nodes {
            match node {
                Inline::Text(t) => *cur += t.len(),
                Inline::Bold(c) => self.paired(SpanKind::Bold, 2, c, 2, cur, m),
                Inline::Italic(c) => self.paired(SpanKind::Italic, 2, c, 2, cur, m),
                Inline::Underline(c) => self.paired(SpanKind::Underline, 2, c, 2, cur, m),
                Inline::Strike(c) => self.paired(SpanKind::Strike, 2, c, 2, cur, m),
                Inline::Superscript(c) => self.paired(SpanKind::Superscript, 2, c, 1, cur, m),
                Inline::Subscript(c) => self.paired(SpanKind::Subscript, 2, c, 1, cur, m),
                Inline::Verbatim(_) => self.fenced(SpanKind::InlineVerbatim, 2, node, 2, cur, m),
                Inline::Image(_) => self.fenced(SpanKind::Image, 2, node, 2, cur, m),
                Inline::Anchor(_) => self.fenced(SpanKind::Anchor, 5, node, 2, cur, m),
                Inline::Link(l) => {
                    let start = *cur;
                    let end = start + rendered_len_one(node);
                    let idx = self.push(m.at(start), m.at(end), SpanKind::Link, 0);
                    self.marker(idx, m.at(start), m.at(start + 2));
                    let mut at = start + 2;
                    if !l.target.is_empty() {
                        let has_display = u32::from(l.display.is_some());
                        self.push(
                            m.at(at),
                            m.at(at + l.target.len()),
                            SpanKind::LinkTarget,
                            has_display,
                        );
                    }
                    at += l.target.len();
                    if let Some(display) = &l.display {
                        self.marker(idx, m.at(at), m.at(at + 1));
                        at += 1;
                        if !display.is_empty() {
                            self.push(m.at(at), m.at(at + display.len()), SpanKind::LinkDisplay, 0);
                        }
                        at += display.len();
                    }
                    self.marker(idx, m.at(at), m.at(at + 2));
                    *cur = end;
                }
                Inline::Tag(_) => self.leaf(SpanKind::Tag, node, cur, m),
                Inline::AutoUrl(_) => self.leaf(SpanKind::AutoUrl, node, cur, m),
                Inline::AutoEmail(_) => self.leaf(SpanKind::AutoEmail, node, cur, m),
            }
        }
    }

    /// A construct with nested inline content between an opening and a closing marker.
    fn paired(
        &mut self,
        kind: SpanKind,
        open: usize,
        children: &[Inline],
        close: usize,
        cur: &mut usize,
        m: &Mapper,
    ) {
        let start = *cur;
        let idx = self.push(m.at(start), m.at(start), kind, 0);
        self.marker(idx, m.at(start), m.at(start + open));
        *cur = start + open;
        self.inline(children, cur, m);
        let close_at = *cur;
        *cur += close;
        self.marker(idx, m.at(close_at), m.at(*cur));
        self.out[idx].end = m.at(*cur);
    }

    /// A construct with raw (not nested) content between an opening and a closing marker.
    fn fenced(
        &mut self,
        kind: SpanKind,
        open: usize,
        node: &Inline,
        close: usize,
        cur: &mut usize,
        m: &Mapper,
    ) {
        let start = *cur;
        let end = start + rendered_len_one(node);
        let idx = self.push(m.at(start), m.at(end), kind, 0);
        self.marker(idx, m.at(start), m.at(start + open));
        self.marker(idx, m.at(end - close), m.at(end));
        *cur = end;
    }

    fn leaf(&mut self, kind: SpanKind, node: &Inline, cur: &mut usize, m: &Mapper) {
        let start = *cur;
        *cur += rendered_len_one(node);
        self.push(m.at(start), m.at(*cur), kind, 0);
    }
}

fn list_marker_code(marker: &ListMarker) -> u32 {
    match marker {
        ListMarker::Bullet => list_marker::BULLET,
        ListMarker::Numbered {
            style: NumberStyle::Arabic,
            ..
        } => list_marker::NUMBER,
        ListMarker::Numbered {
            style: NumberStyle::LowerAlpha,
            ..
        } => list_marker::LOWER_ALPHA,
        ListMarker::Numbered {
            style: NumberStyle::UpperAlpha,
            ..
        } => list_marker::UPPER_ALPHA,
        ListMarker::Checkbox(CheckboxState::Unchecked) => list_marker::UNCHECKED,
        ListMarker::Checkbox(CheckboxState::Checked) => list_marker::CHECKED,
        ListMarker::Checkbox(CheckboxState::Xchecked) => list_marker::XCHECKED,
        ListMarker::Checkbox(CheckboxState::Migrated) => list_marker::MIGRATED,
        ListMarker::Checkbox(CheckboxState::Transmigrated) => list_marker::TRANSMIGRATED,
    }
}
