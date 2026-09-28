//! Parser and serializer for the Zim wiki text format.
//!
//! See `docs/zim-wiki-format-spec.md` at the repo root for the format spec this
//! implementation follows. Reimplemented from documented syntax; no Zim source is copied
//! (see CLAUDE.md).
//!
//! This crate is pure text parsing/serialization: no I/O, no crypto, no network. Its two
//! entry points are [`parse`] and [`Page::serialize`], and the round-trip
//! `Page::serialize(&parse(text)) == text` holds byte-for-byte for any input (see
//! `docs/zim-wiki-format-spec.md` §4).
//!
//! ```
//! let text = "Content-Type: text/x-zim-wiki\n\n====== Title ======\nHello //world//.\n";
//! let page = zim_format::parse(text);
//! assert_eq!(page.serialize(), text);
//! ```

pub mod block;
pub mod header;
pub mod inline;

pub use block::{
    Block, CheckboxState, Heading, HorizontalRule, ListBlock, ListItem, ListMarker, NumberStyle,
    Opaque, Paragraph, Verbatim,
};
pub use header::HeaderField;
pub use inline::{Image, Inline, Link};

/// A parsed Zim wiki `.txt` page: an optional header block plus a body of
/// blocks (spec §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// `None` if the page has no header block at all (a page with no headers
    /// is valid and common); `Some(fields)` if a header block was present —
    /// `fields` may be empty only in the degenerate case of an explicitly
    /// constructed page (parsing never produces `Some(vec![])`, since a
    /// header block requires at least one header line to be recognized).
    pub headers: Option<Vec<HeaderField>>,
    /// The page body: an ordered sequence of blocks.
    pub body: Body,
}

/// The body of a page: an ordered, exhaustive partition of its lines into
/// blocks (see [`Block`]).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Body {
    pub blocks: Vec<Block>,
}

/// Parse a Zim wiki page from its raw `.txt` file text.
///
/// Never fails and never panics on malformed input: unrecognized constructs
/// fall back to plain text or opaque blocks so that `serialize` can always
/// reproduce the original bytes exactly (spec §4).
pub fn parse(text: &str) -> Page {
    let lines: Vec<&str> = text.split('\n').collect();
    let (headers, body_start) = match header::parse_headers(&lines) {
        Some((fields, body_start)) => (Some(fields), body_start),
        None => (None, 0),
    };
    let body_lines = &lines[body_start..];
    let blocks = block::parse_blocks(body_lines);
    Page {
        headers,
        body: Body { blocks },
    }
}

impl Page {
    /// Serialize this page back to `.txt` file text.
    ///
    /// For any `text`, `parse(text).serialize() == text` (spec §4).
    pub fn serialize(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        if let Some(fields) = &self.headers {
            lines.extend(header::render_headers(fields));
            // The mandatory blank separator line between headers and body
            // (spec §1: "a blank line, only if a header block is present").
            lines.push(String::new());
        }
        lines.extend(block::render_blocks(&self.body.blocks));
        lines.join("\n")
    }
}

impl Body {
    /// Render this body back to its exact original text (no header block).
    pub fn serialize(&self) -> String {
        block::render_blocks(&self.blocks).join("\n")
    }
}
