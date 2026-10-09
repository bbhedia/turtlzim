//! The `@tags` written in a page.
//!
//! What counts as a tag is the format crate's rule (`@` and then letters, digits or `_`, not in the
//! middle of a word, and not in a heading, a code block, a table or an object: spec 3.4), so this finds
//! exactly the tags that the editor draws as tags. Two spellings that differ only in case are the same
//! tag.

use zim_format::{highlight, SpanKind};

/// A tag as written in a page: `@name`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagRef {
    /// The name without the `@`, in the case it was written in.
    pub name: String,
    /// Where `@name` is in the text (byte offsets).
    pub start: usize,
    pub end: usize,
}

/// What two spellings of a tag have in common: the same key is the same tag. Case does not matter,
/// and a leading `@` is not part of the tag.
pub fn tag_key(tag: &str) -> String {
    tag.strip_prefix('@').unwrap_or(tag).to_lowercase()
}

/// The tags written in `text`, in order (one for every place that writes one).
pub fn tags_in(text: &str) -> Vec<TagRef> {
    highlight(text)
        .into_iter()
        .filter(|span| span.kind == SpanKind::Tag)
        .map(|span| TagRef { name: text[span.start + 1..span.end].to_string(), start: span.start, end: span.end })
        .collect()
}
