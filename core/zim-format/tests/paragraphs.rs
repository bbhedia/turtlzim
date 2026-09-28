//! §2.2 paragraph / indented-paragraph round-trip tests.

mod common;
use common::assert_roundtrip;
use zim_format::Block;

#[test]
fn simple_and_multiline_paragraph() {
    let input = "====== Notes ======\n\nThis is a short paragraph.\n\nThis paragraph wraps\nover two physical lines\nwithout any blank line between them.\n";
    assert_roundtrip(input);
}

#[test]
fn indented_paragraph_tracks_and_restores_indent() {
    let input = "====== Quote ======\n\nAs someone once said:\n\n\tThis whole paragraph is indented by one tab,\n\tand every one of its lines shares that tab,\n\tso it should round-trip exactly.\n\nBack to normal indentation.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let indented = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Paragraph(p) if p.indent > 0 => Some(p),
            _ => None,
        })
        .expect("expected an indented paragraph");
    assert_eq!(indented.indent, 1);
}

#[test]
fn multiple_consecutive_blank_lines_are_preserved_exactly() {
    // Spec §2.2: multiple consecutive blank lines must not be collapsed.
    let input = "====== Spacing ======\n\nFirst paragraph.\n\n\n\nSecond paragraph, after three blank lines.\n\nThird paragraph, after one blank line.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let blank_run_lengths: Vec<usize> = page
        .body
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Blank(n) => Some(*n),
            _ => None,
        })
        .collect();
    assert!(blank_run_lengths.contains(&3), "expected a preserved run of 3 blank lines, got {blank_run_lengths:?}");
}

#[test]
fn bold_spanning_a_soft_line_break_in_an_indented_paragraph() {
    // Inline markup may span the (soft) line break inside a multi-line
    // paragraph; the paragraph's per-line indentation must still be
    // re-applied correctly around the embedded newline on serialize.
    let input = "\tThis is a **bold phrase that\n\tcontinues** onto the next physical line.\n";
    assert_roundtrip(input);
}
