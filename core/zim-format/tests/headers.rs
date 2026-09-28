//! §1.1 header block round-trip tests.

mod common;
use common::assert_roundtrip;

#[test]
fn page_with_header_block_and_continuation_line() {
    let input = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2024-01-05T10:22:00+01:00\nNotes: this is a long value that\n continues onto a second physical line\n and even a third one\n\n====== Continuation Header Test ======\n\nBody text goes here.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let headers = page.headers.expect("expected a header block");
    assert_eq!(headers.len(), 4);
    assert_eq!(headers[0].key, "Content-Type");
    assert_eq!(headers[3].key, "Notes");
    assert_eq!(headers[3].continuations.len(), 2);
    assert_eq!(headers[3].continuations[0], " continues onto a second physical line");
}

#[test]
fn page_with_no_header_block() {
    // No header lines at all: the body starts immediately.
    let input = "====== Plain Page ======\n\nJust some text, no headers here.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(page.headers.is_none());
}

#[test]
fn colon_in_first_paragraph_is_not_mistaken_for_a_header() {
    // The first line looks like "Key: value", but it is never followed by a
    // clean blank separator (the very next line is a plain continuation of
    // the paragraph, not a header continuation or a blank line) — so this
    // must NOT be parsed as a header block.
    let input = "Note: remember to buy milk\nand don't forget the eggs.\n\n====== Groceries ======\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(
        page.headers.is_none(),
        "an unterminated header-like prefix must fall back to plain body text"
    );
}

#[test]
fn header_block_with_single_field_and_empty_body() {
    let input = "Wiki-Format: zim 0.6\n\n";
    assert_roundtrip(input);
    let page = zim_format::parse(input);
    assert_eq!(page.headers.unwrap().len(), 1);
}
