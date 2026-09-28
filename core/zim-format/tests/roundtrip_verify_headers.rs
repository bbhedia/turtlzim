//! Adversarial verification for spec §1.1 (page header block) and §2.6
//! (opaque out-of-scope blocks: tables / object blocks).
//!
//! These fixtures are original content composed for this verification pass —
//! not copied from any Zim repository, and not copies of the implementer's
//! own `tests/headers.rs` / `tests/opaque.rs` fixtures (different wording,
//! different key names, different structural shapes). Each test both
//! checks byte-identical round-trip (`parse` then `serialize`) and, where
//! useful, inspects the parsed `Page` structure directly through the crate's
//! public API to catch a case that would happen to round-trip byte-for-byte
//! while still being structurally wrong (e.g. an opaque block silently
//! swallowing a neighboring block).

mod common;
use common::assert_roundtrip;
use zim_format::{inline::render_inline, Block};

// ---------------------------------------------------------------------
// §1.1 — full header block, own devised keys, blank separator, body
// starting with a level-1 heading.
// ---------------------------------------------------------------------

#[test]
fn full_page_with_devised_header_keys_and_level1_heading_body() {
    let input = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2099-12-31T23:59:59+00:00\n\n====== Turtle Notebook Overview ======\n\nThis page describes how the turtle notebook keeps its records.\n\nEvery entry begins with a plain paragraph like this one.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let headers = page.headers.expect("expected a header block to be recognized");
    assert_eq!(headers.len(), 3, "expected exactly 3 header fields");
    assert_eq!(headers[0].key, "Content-Type");
    assert_eq!(headers[0].value_first_line, " text/x-zim-wiki");
    assert_eq!(headers[1].key, "Wiki-Format");
    assert_eq!(headers[1].value_first_line, " zim 0.6");
    assert_eq!(headers[2].key, "Creation-Date");
    assert_eq!(headers[2].value_first_line, " 2099-12-31T23:59:59+00:00");
    assert!(headers.iter().all(|h| h.continuations.is_empty()));

    match &page.body.blocks[0] {
        Block::Heading(h) => {
            assert_eq!(h.level, 1, "six '=' on each side must be level 1");
            assert_eq!(render_inline(&h.text), "Turtle Notebook Overview");
        }
        other => panic!("expected the body to start with a Heading block, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// §1.1 — RFC822 folding: a header value continuing onto following lines
// via leading whitespace must attach to the SAME logical field and
// round-trip as that one field (not split into separate headers, not
// dropped, not merged into the wrong key).
// ---------------------------------------------------------------------

#[test]
fn header_value_folds_across_multiple_continuation_lines() {
    let input = "Content-Type: text/x-zim-wiki\nX-Backup-Policy: keep the last five encrypted snapshots\n and rotate them out weekly\n starting the first Monday of each month\n\n====== Backup Policy ======\nSee the header for details.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let headers = page.headers.expect("expected a header block");
    assert_eq!(headers.len(), 2);
    let policy = &headers[1];
    assert_eq!(policy.key, "X-Backup-Policy");
    assert_eq!(policy.value_first_line, " keep the last five encrypted snapshots");
    assert_eq!(
        policy.continuations,
        vec![
            " and rotate them out weekly".to_string(),
            " starting the first Monday of each month".to_string(),
        ],
        "both folded lines must attach, in order, to the same header field"
    );
}

#[test]
fn header_continuation_line_indented_with_tab() {
    // Spec §1.1: a continuation line starts with "whitespace (space or tab,
    // not newline)" — exercise the tab case specifically, not just space.
    let input = "Wiki-Format: zim 0.6\nX-Note: first physical line\n\tsecond physical line via tab indent\n\n====== Tab Continuation ======\nBody text.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let headers = page.headers.expect("expected a header block");
    assert_eq!(headers.len(), 2);
    assert_eq!(headers[1].key, "X-Note");
    assert_eq!(headers[1].continuations.len(), 1);
    assert_eq!(
        headers[1].continuations[0],
        "\tsecond physical line via tab indent"
    );
}

#[test]
fn header_continuation_does_not_leak_into_next_header_field() {
    // A folded value must stop binding as soon as a new, non-indented
    // "Key:" line appears — that line starts a new field, it is not
    // swallowed as a third continuation line of the previous field.
    let input = "Content-Type: text/x-zim-wiki\nX-Summary: line one of the summary\n continued line of the summary\nWiki-Format: zim 0.6\n\n====== Two Headers Test ======\nBody.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let headers = page.headers.expect("expected a header block");
    assert_eq!(headers.len(), 3, "the trailing Wiki-Format line must be its own field");
    assert_eq!(headers[1].key, "X-Summary");
    assert_eq!(headers[1].continuations.len(), 1);
    assert_eq!(headers[2].key, "Wiki-Format");
    assert_eq!(headers[2].value_first_line, " zim 0.6");
    assert!(headers[2].continuations.is_empty());
}

// ---------------------------------------------------------------------
// §1.1 — no header block at all: body starts directly with content.
// ---------------------------------------------------------------------

#[test]
fn page_with_no_header_block_body_starts_with_heading() {
    let input = "====== Standalone Page ======\nThis notebook page has no header block at all.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(page.headers.is_none(), "there is no header block in this fixture");
    assert!(matches!(page.body.blocks[0], Block::Heading(_)));
}

#[test]
fn page_with_no_header_block_and_a_colon_in_the_first_body_line() {
    // The first line contains a colon, but the text before it ("Turtles are
    // great") is not a valid RFC822 header key (it contains spaces), so this
    // must never be mistaken for a header line, regardless of what follows.
    let input = "Turtles are great: really, ask anyone who has one.\nThis is just an ordinary paragraph with a colon in its first line.\n\n====== Colon In Body Text ======\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(
        page.headers.is_none(),
        "a colon-bearing first line with a non-word-char key prefix must never parse as a header"
    );
}

#[test]
fn header_like_first_line_without_blank_terminator_stays_body_text() {
    // The first line looks exactly like a valid "Key: value" header line,
    // but the header block is never cleanly terminated by a blank line
    // (the very next line is plain paragraph continuation) — per spec
    // §1.1 the whole prefix must fall back to plain body text, not a
    // partially-parsed header followed by corrupted body content.
    let input = "Reminder: water the turtles before the trip\nand refill their filter cartridge too.\n\n====== Care Instructions ======\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(
        page.headers.is_none(),
        "an unterminated header-like prefix must fall back to plain body text, not a broken header block"
    );
}

// ---------------------------------------------------------------------
// §2.6 — opaque out-of-scope blocks (object blocks / table-like grids)
// must survive as an exact passthrough without corrupting the blocks
// around them.
// ---------------------------------------------------------------------

#[test]
fn opaque_object_block_of_own_devising_survives_between_paragraphs() {
    let input = "Content-Type: text/x-zim-wiki\n\n====== Field Trip Log ======\nIntro paragraph describing the day before the reminder block.\n\n{{{turtlenote: kind=\"reminder\" priority=\"high\"\nFeed the turtles at dawn.\nCheck the tank temperature twice.\n}}}\n\nClosing paragraph describing what happened after the reminder block.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let blocks = &page.body.blocks;
    assert_eq!(blocks.len(), 7, "expected: heading, para, blank, opaque, blank, para, blank");
    assert!(matches!(blocks[0], Block::Heading(_)));
    match &blocks[1] {
        Block::Paragraph(p) => assert_eq!(
            render_inline(&p.text),
            "Intro paragraph describing the day before the reminder block."
        ),
        other => panic!("expected the intro Paragraph before the opaque block, got {other:?}"),
    }
    assert!(matches!(blocks[2], Block::Blank(1)));
    match &blocks[3] {
        Block::Opaque(o) => {
            assert_eq!(o.raw_lines.len(), 4);
            assert_eq!(o.raw_lines[0], "{{{turtlenote: kind=\"reminder\" priority=\"high\"");
            assert_eq!(o.raw_lines[1], "Feed the turtles at dawn.");
            assert_eq!(o.raw_lines[2], "Check the tank temperature twice.");
            assert_eq!(o.raw_lines[3], "}}}");
        }
        other => panic!("expected an Opaque block for the object block, got {other:?}"),
    }
    assert!(matches!(blocks[4], Block::Blank(1)));
    match &blocks[5] {
        Block::Paragraph(p) => assert_eq!(
            render_inline(&p.text),
            "Closing paragraph describing what happened after the reminder block."
        ),
        other => panic!("expected the closing Paragraph after the opaque block, got {other:?}"),
    }
}

#[test]
fn opaque_table_like_grid_of_own_devising_survives_between_paragraphs() {
    let input = "====== Chore Schedule ======\nBefore the grid, a short paragraph explains the chores.\n\n|Chore|Assignee|Frequency|\n|Feed turtles|Belgacem|Daily|\n|Clean filter|Belgacem|Weekly|\n\nAfter the grid, a closing remark wraps up the page.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let blocks = &page.body.blocks;
    assert_eq!(blocks.len(), 7, "expected: heading, para, blank, opaque, blank, para, blank");
    match &blocks[3] {
        Block::Opaque(o) => {
            assert_eq!(o.raw_lines.len(), 3, "all three '|...|' rows form one opaque block");
            assert_eq!(o.raw_lines[0], "|Chore|Assignee|Frequency|");
            assert_eq!(o.raw_lines[2], "|Clean filter|Belgacem|Weekly|");
        }
        other => panic!("expected an Opaque block for the table grid, got {other:?}"),
    }
    match &blocks[5] {
        Block::Paragraph(p) => assert_eq!(
            render_inline(&p.text),
            "After the grid, a closing remark wraps up the page."
        ),
        other => panic!("expected the closing Paragraph after the grid, got {other:?}"),
    }
}

#[test]
fn opaque_object_block_with_no_blank_line_cushioning_on_either_side() {
    // Tight adjacency: no blank line before or after the opaque block. The
    // block-level scanner must still find the exact right boundary and must
    // not swallow the paragraph line immediately before it, nor the one
    // immediately after.
    let input = "====== Tight Adjacency Test ======\nLine right before the block with no blank line after it.\n{{{gadget: mode=\"compact\"\ninner content line\n}}}\nLine right after the block with no blank line before it.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let blocks = &page.body.blocks;
    // heading, para(before), opaque, para(after), blank(trailing newline)
    assert_eq!(blocks.len(), 5, "got blocks: {blocks:?}");
    assert!(matches!(blocks[0], Block::Heading(_)));
    match &blocks[1] {
        Block::Paragraph(p) => assert_eq!(
            render_inline(&p.text),
            "Line right before the block with no blank line after it."
        ),
        other => panic!("the paragraph before the block must not be swallowed into it, got {other:?}"),
    }
    match &blocks[2] {
        Block::Opaque(o) => {
            assert_eq!(o.raw_lines.len(), 3);
            assert_eq!(o.raw_lines[0], "{{{gadget: mode=\"compact\"");
            assert_eq!(o.raw_lines[2], "}}}");
        }
        other => panic!("expected an Opaque block, got {other:?}"),
    }
    match &blocks[3] {
        Block::Paragraph(p) => assert_eq!(
            render_inline(&p.text),
            "Line right after the block with no blank line before it."
        ),
        other => panic!("the paragraph after the block must not be swallowed into it, got {other:?}"),
    }
}

#[test]
fn opaque_table_like_grid_with_no_blank_line_cushioning_on_either_side() {
    let input = "Text right before the grid with no blank line.\n|X|Y|\n|1|2|\nText right after the grid with no blank line.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(page.headers.is_none());
    let blocks = &page.body.blocks;
    assert_eq!(blocks.len(), 4, "got blocks: {blocks:?}");
    match &blocks[0] {
        Block::Paragraph(p) => assert_eq!(render_inline(&p.text), "Text right before the grid with no blank line."),
        other => panic!("expected a leading Paragraph, got {other:?}"),
    }
    match &blocks[1] {
        Block::Opaque(o) => {
            assert_eq!(o.raw_lines, vec!["|X|Y|".to_string(), "|1|2|".to_string()]);
        }
        other => panic!("expected an Opaque block for the grid, got {other:?}"),
    }
    match &blocks[2] {
        Block::Paragraph(p) => assert_eq!(render_inline(&p.text), "Text right after the grid with no blank line."),
        other => panic!("expected a trailing Paragraph, got {other:?}"),
    }
}
