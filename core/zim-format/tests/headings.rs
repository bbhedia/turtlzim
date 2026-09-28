//! §2.1 heading round-trip tests.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline};

#[test]
fn all_five_heading_levels() {
    let input = "====== Top Level Title ======\n\n===== Second Level =====\n\n==== Third Level ====\n\n=== Fourth Level ===\n\n== Fifth Level ==\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let levels: Vec<u8> = page
        .body
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Heading(h) => Some(h.level),
            _ => None,
        })
        .collect();
    assert_eq!(levels, vec![1, 2, 3, 4, 5]);
}

#[test]
fn heading_with_anchor_and_inline_markup() {
    let input = "====== Report ======\n\n=== Planning {{id: planning}} ===\n\n== Team **Alpha** and [[Team Beta|Beta Team]] ==\n";
    assert_roundtrip(input);
}

#[test]
fn four_bare_equals_is_not_a_heading() {
    // A line of nothing but four '=' characters looks like a truncated
    // heading marker but has no text and no surrounding spaces: per spec
    // §2.1 this must parse as ordinary paragraph text, not a heading.
    let input = "====\nThis line describes quarterly numbers, it is not a section title.\n\n====== Real Heading ======\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let heading_count = page
        .body
        .blocks
        .iter()
        .filter(|b| matches!(b, Block::Heading(_)))
        .count();
    assert_eq!(heading_count, 1, "the bare '====' line must not become a heading");
}

#[test]
fn missing_space_around_markers_is_not_a_heading() {
    // Exactly one space on each side is required; markers glued directly to
    // text do not form a heading.
    let input = "==no spaces here==\n\nParagraph after.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(
        !page.body.blocks.iter().any(|b| matches!(b, Block::Heading(_))),
        "'==no spaces here==' must not parse as a heading"
    );
}

#[test]
fn tags_are_not_recognized_inside_headings() {
    // Spec §3.4: tags are a known exception, not recognized inside headings.
    // The text stays literal, so round-trip alone can't distinguish a Tag
    // from a Text span rendering the same bytes -- check the AST directly.
    let input = "=== Reminders @todo ===\n\nSome body text with a real @todo tag.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let heading = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Heading(h) => Some(h),
            _ => None,
        })
        .expect("heading present");
    assert!(
        !heading.text.iter().any(|sp| matches!(sp, Inline::Tag(_))),
        "heading text must not contain a parsed Tag span"
    );

    let has_tag_in_body = page.body.blocks.iter().any(|b| match b {
        Block::Paragraph(p) => p.text.iter().any(|sp| matches!(sp, Inline::Tag(_))),
        _ => false,
    });
    assert!(has_tag_in_body, "body paragraph text should still recognize @todo as a tag");
}
