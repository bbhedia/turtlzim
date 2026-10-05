//! §2.4 verbatim (preformatted) block round-trip tests, including the
//! nested-triple-quote closing-delimiter edge case.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline};

#[test]
fn basic_verbatim_block_suppresses_inline_parsing() {
    let input = "====== Snippet ======\n\nHere is some raw content:\n\n'''\nfn main() {\n    println!(\"**not bold** and //not italic//\");\n}\n'''\n\nBack to normal text.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let verbatim = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Verbatim(v) => Some(v),
            _ => None,
        })
        .expect("expected a verbatim block");
    assert!(verbatim.content_lines.iter().any(|l| l.contains("**not bold**")));
    assert!(verbatim.closed);
}

#[test]
fn nested_bare_triple_quote_does_not_close_the_block_indent_zero() {
    // The inner "'''" line has one extra leading tab beyond the block's own
    // (zero) base indent, so it must be treated as literal content, not as
    // the closing delimiter (spec §2.4).
    let input = "'''\nsome code here\n\t'''\nstill inside the block\n'''\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Verbatim(v) = &page.body.blocks[0] else {
        panic!("expected a verbatim block");
    };
    assert!(v.closed);
    assert_eq!(
        v.content_lines,
        vec![
            "some code here".to_string(),
            "\t'''".to_string(),
            "still inside the block".to_string(),
        ]
    );
}

#[test]
fn nested_bare_triple_quote_does_not_close_the_block_when_outer_is_itself_indented() {
    // Same edge case, but the outer block itself starts at indent 1 (e.g. a
    // verbatim block written inside an indented context): the inner
    // docstring delimiter sits two tabs deep and must still not close it.
    let input = "\t'''\n\tline one of snippet\n\t\t'''\n\tline two of snippet\n\t'''\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Verbatim(v) = &page.body.blocks[0] else {
        panic!("expected a verbatim block");
    };
    assert_eq!(v.indent, 1);
    assert!(v.closed);
    assert_eq!(
        v.content_lines,
        vec![
            "line one of snippet".to_string(),
            "\t'''".to_string(),
            "line two of snippet".to_string(),
        ]
    );
}

#[test]
fn unterminated_verbatim_block_still_round_trips() {
    let input = "'''\nthis block never closes\nmore raw content\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Verbatim(v) = &page.body.blocks[0] else {
        panic!("expected a verbatim block");
    };
    assert!(!v.closed);
}

#[test]
fn inline_verbatim_suppresses_parsing_of_its_contents() {
    let input = "A paragraph with ''**not bold** and //not italic//'' inline verbatim.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Paragraph(p) = &page.body.blocks[0] else {
        panic!("expected a paragraph");
    };
    assert!(p.text.iter().any(|sp| matches!(sp, Inline::Verbatim(t) if t == "**not bold** and //not italic//")));
}

// A line inside an indented verbatim block can have fewer tabs than the fences: an empty line in
// a code sample is the everyday case. There is nothing to strip from it, so the serializer must
// not invent tabs for it. (Found by `golden_real_notebooks`: a real Zim test page has this shape.)

#[test]
fn empty_line_inside_an_indented_verbatim_block_stays_empty() {
    let input = "* step\n\t'''\n\tlet a = 1;\n\n\tlet b = 2;\n\t'''\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Verbatim(v) = &page.body.blocks[1] else {
        panic!("expected a verbatim block after the list, got {:?}", page.body.blocks);
    };
    assert!(v.closed);
    assert_eq!(v.content_lines, vec!["let a = 1;", "", "let b = 2;"]);
    // The stored text is the same with or without the stray tabs; this is what tells them apart.
    assert_eq!(v.under_indented, vec![(1, 0)]);
}

#[test]
fn partly_indented_lines_in_a_deeper_block_keep_their_own_tabs() {
    // Fences two tabs deep; the middle lines have one tab, none, and three.
    let input = "\t\t'''\n\t\talpha\n\tbeta\ngamma\n\t\t\tdelta\n\t\t'''\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Verbatim(v) = &page.body.blocks[0] else {
        panic!("expected a verbatim block");
    };
    assert_eq!(v.content_lines, vec!["alpha", "beta", "gamma", "\tdelta"]);
    assert_eq!(v.under_indented, vec![(1, 1), (2, 0)]);
}

#[test]
fn unterminated_indented_block_keeps_empty_lines_empty() {
    // The shape that exposed the bug: a bare fence two tabs deep that never closes, so it runs to
    // the end of the page, followed by ordinary unindented text with blank lines in it.
    let input = "\t\tcode\n\t\t'''\n\t\treturn x\n\nNext section\n\nmore text\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Some(Block::Verbatim(v)) = page.body.blocks.iter().find(|b| matches!(b, Block::Verbatim(_)))
    else {
        panic!("expected a verbatim block");
    };
    assert!(!v.closed);
    assert_eq!(v.content_lines, vec!["return x", "", "Next section", "", "more text", ""]);
}
