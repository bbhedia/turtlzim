//! Adversarial verification fixtures for §2.1 (Headings) and §2.2
//! (Paragraphs and indented paragraphs), written independently of the
//! implementation and of the existing `tests/headings.rs` /
//! `tests/paragraphs.rs` files. All fixture text below is original content
//! composed for this task — not copied from any Zim repository.
//!
//! Coverage:
//!   - all 5 heading levels (N=6..N=2) in one fixture
//!   - a heading containing an inline anchor (`{{id: name}}`)
//!   - "bare equals run, no second marker at all" is not a heading (two
//!     different N, generalizing the spec's own `====` example)
//!   - "two marker runs of the same N with only whitespace text between
//!     them" is not a heading either, per spec §2.1's "remaining text is
//!     non-blank" rule (two different N) -- round-trip alone can't catch a
//!     misclassification here (the byte-identical output happens to be the
//!     same either way), so this checks the parsed `Block` variant directly
//!   - an indented paragraph (single leading tab shared by every line) vs.
//!     a plain, non-indented paragraph, checking the tracked `indent` field
//!   - a run of several (4) consecutive blank lines between two blocks,
//!     checked to be preserved exactly, not collapsed

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline};

#[test]
fn all_five_heading_levels_round_trip_with_correct_levels() {
    let input = "\
====== Project Turtlzim Overview ======

===== Milestones and Deliverables =====

==== Sprint Planning Notes ====

=== Backlog Grooming Session ===

== Retro Action Items ==
";
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
    assert_eq!(
        levels,
        vec![1, 2, 3, 4, 5],
        "expected levels 1..=5 in document order, got {levels:?}"
    );
}

#[test]
fn heading_containing_an_inline_anchor_round_trips_and_parses_anchor() {
    let input = "=== Deployment Checklist {{id: deploy-checklist}} ===\n\nSee the checklist heading above for release steps.\n";
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
    assert_eq!(heading.level, 4);

    let anchor_raw = heading.text.iter().find_map(|sp| match sp {
        Inline::Anchor(raw) => Some(raw.as_str()),
        _ => None,
    });
    assert_eq!(
        anchor_raw,
        Some(" deploy-checklist"),
        "heading text should contain an Inline::Anchor with the raw text between \
         '{{{{id:' and '}}}}' (including its leading space), got {:?}",
        heading.text
    );
}

#[test]
fn bare_equals_run_with_no_second_marker_is_not_a_heading_for_two_different_n() {
    // Generalizes the spec's own example ("==== " alone, four equals with
    // nothing else on the line, is ordinary paragraph text) to two
    // different marker widths: a lone two-equals run (N=2, the minimum) and
    // a lone five-equals run (N=5). Neither has a second marker run at all,
    // so per spec §2.1 both must stay plain paragraph text.
    let input = "==\nA lone two-character equals run on its own line, like just above, is plain text.\n\n=====\nA lone five-character equals run on its own line, like just above, is also plain text.\n\n====== Actual Heading ======\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let heading_levels: Vec<u8> = page
        .body
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Heading(h) => Some(h.level),
            _ => None,
        })
        .collect();
    assert_eq!(
        heading_levels,
        vec![1],
        "only 'Actual Heading' should parse as a heading; a bare '==' or '=====' \
         run with no closing marker run must stay a paragraph (got heading levels {heading_levels:?})"
    );
}

#[test]
fn whitespace_only_text_between_equal_marker_runs_is_not_a_heading() {
    // Spec §2.1: "a candidate heading line only parses as a heading if,
    // after both marker runs are stripped, the remaining text is
    // non-blank." The spec's own worked example covers *empty* remaining
    // text (a bare "====" run). This checks the sibling case explicitly
    // named by this task: remaining text that is *whitespace-only* (here:
    // three spaces between two equal-width marker runs, which after the
    // mandatory one-space-per-side is stripped still leaves one space of
    // literal content) -- also blank, and so must likewise not be a
    // heading. Checked at two different N (3 and 6).
    //
    // Round-trip alone cannot distinguish this from a correctly-classified
    // heading: a `Heading { text: [Text(" ")] }` serializes back to the
    // exact same bytes as a `Paragraph { text: [Text("===   ===")] }`
    // would. So this test additionally inspects the parsed `Block` variant
    // directly, which is the only way to observe a misclassification here.
    let input = "===   ===\n\nThe line above has only whitespace between its two N=3 marker runs.\n\n======   ======\n\nThe line above has only whitespace between its two N=6 marker runs.\n\n== Actual Section Heading ==\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);

    let heading_levels: Vec<u8> = page
        .body
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Heading(h) => Some(h.level),
            _ => None,
        })
        .collect();
    assert_eq!(
        heading_levels,
        vec![5],
        "only '== Actual Section Heading ==' should parse as a heading; \
         '===   ===' and '======   ======' have only whitespace between their \
         marker runs and per spec §2.1 must stay paragraphs, not headings \
         (got heading levels {heading_levels:?})"
    );

    let n3_line_is_paragraph = page.body.blocks.iter().any(|b| {
        matches!(
            b,
            Block::Paragraph(p)
                if p.indent == 0
                    && matches!(p.text.as_slice(), [Inline::Text(t)] if t == "===   ===")
        )
    });
    assert!(
        n3_line_is_paragraph,
        "'===   ===' (N=3, whitespace-only text) must parse as a literal \
         paragraph, not a heading"
    );

    let n6_line_is_paragraph = page.body.blocks.iter().any(|b| {
        matches!(
            b,
            Block::Paragraph(p)
                if p.indent == 0
                    && matches!(p.text.as_slice(), [Inline::Text(t)] if t == "======   ======")
        )
    });
    assert!(
        n6_line_is_paragraph,
        "'======   ======' (N=6, whitespace-only text) must parse as a literal \
         paragraph, not a heading"
    );
}

#[test]
fn indented_paragraph_with_shared_leading_tab_tracks_indent_depth() {
    let input = "====== Field Notes ======\n\n\tEvery line of this paragraph begins with exactly one shared tab,\n\tso the whole run is one indented paragraph,\n\tand that shared tab must be stripped on parse and re-added on serialize.\n\nA plain paragraph follows this one with no leading tab at all.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let mut paragraphs = page.body.blocks.iter().filter_map(|b| match b {
        Block::Paragraph(p) => Some(p),
        _ => None,
    });

    let indented = paragraphs.next().expect("indented paragraph present");
    assert_eq!(
        indented.indent, 1,
        "expected the first paragraph to be tracked with indent depth 1"
    );

    let plain = paragraphs.next().expect("plain paragraph present");
    assert_eq!(
        plain.indent, 0,
        "expected the trailing paragraph to have indent depth 0 (no leading tab)"
    );
}

#[test]
fn run_of_four_consecutive_blank_lines_is_preserved_exactly() {
    // Spec §2.2: "multiple consecutive blank lines must be preserved
    // exactly (don't collapse them)". Built with `"\n".repeat(4)` rather
    // than a hand-counted literal so the exact blank-line count is
    // unambiguous. Deliberately has no trailing newline after the final
    // line: a trailing "\n" would itself split into one more (unrelated)
    // trailing empty line, which would otherwise show up as a spurious
    // extra `Blank(1)` entry and make the blank-run assertion ambiguous.
    let input = format!(
        "First block: a short paragraph sitting right before the gap.\n{}Second block: a short paragraph sitting right after a run of four blank lines.",
        "\n".repeat(4)
    );
    assert_roundtrip(&input);

    let page = zim_format::parse(&input);
    let blank_run_lengths: Vec<usize> = page
        .body
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Blank(n) => Some(*n),
            _ => None,
        })
        .collect();
    assert_eq!(
        blank_run_lengths,
        vec![4],
        "expected a single preserved run of exactly 4 blank lines, got {blank_run_lengths:?}"
    );
}
