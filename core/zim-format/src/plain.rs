//! A page as the plain text a person reads: for searching it and for showing a line of it.
//!
//! The header block, the syntax characters (`**`, `[[`, the `======` around a heading, list
//! markers, code fences), a link's target when it has display text, and images and anchors are left
//! out; everything else, links' visible text and the content of code blocks included, is kept
//! as written. What is left of a page is what shows when its markup is tidied away.

use crate::highlight::{highlight, SpanKind};

/// `text` without its header block and syntax characters (see the module docs).
pub fn plain_text(text: &str) -> String {
    let mut skip = vec![false; text.len()];
    fn hide(skip: &mut [bool], from: usize, to: usize) {
        let to = to.min(skip.len());
        for byte in &mut skip[from..to] {
            *byte = true;
        }
    }
    for span in highlight(text) {
        match span.kind {
            SpanKind::Header => {
                // the blank line that ends the header block goes with it
                let mut to = span.end;
                if text[to..].starts_with("\n\n") {
                    to += 2;
                } else if text[to..].starts_with('\n') {
                    to += 1;
                }
                hide(&mut skip, span.start, to);
            }
            SpanKind::Marker | SpanKind::ListMarker | SpanKind::HorizontalRule | SpanKind::Image | SpanKind::Anchor => hide(&mut skip, span.start, span.end),
            // `[[Target|shown]]` shows "shown"; the target is source, not text
            SpanKind::LinkTarget if span.detail == 1 => hide(&mut skip, span.start, span.end),
            _ => {}
        }
    }
    text.char_indices().filter(|(at, _)| !skip[*at]).map(|(_, c)| c).collect()
}
