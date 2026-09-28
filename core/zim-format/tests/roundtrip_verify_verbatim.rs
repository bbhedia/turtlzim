//! Adversarial verification for verbatim blocks and inline verbatim
//! (spec §2.4, §3.1-§3.2).
//!
//! These fixtures are original content, composed for this verification pass
//! (not copied from any Zim repository). They specifically target the
//! nesting-safety rule for the block delimiter: a line whose text, after
//! stripping the block's *own* base indent, is bare `'''` only closes the
//! block if that stripped-to-base-indent line is *exactly* `'''` — a `'''`
//! that sits at a *deeper* indent than the block's base (e.g. mimicking a
//! nested docstring inside indented code) must remain literal content.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline};

fn only_verbatim_block(page: &zim_format::Page) -> &zim_format::Verbatim {
    let mut found = None;
    for b in &page.body.blocks {
        if let Block::Verbatim(v) = b {
            assert!(found.is_none(), "expected exactly one verbatim block, found a second one");
            found = Some(v);
        }
    }
    found.expect("expected exactly one verbatim block")
}

#[test]
fn plain_top_level_verbatim_block_round_trips() {
    // Base indent 0: the simplest case, opening/closing delimiters at column 0.
    let input = "====== Build Log ======\n\nRaw compiler output follows:\n\n'''\ncc1: warning: unused variable 'x' [-Wunused-variable]\n1 warning generated.\n'''\n\nEnd of log excerpt.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let v = only_verbatim_block(&page);
    assert_eq!(v.indent, 0);
    assert!(v.closed);
    assert_eq!(
        v.content_lines,
        vec![
            "cc1: warning: unused variable 'x' [-Wunused-variable]".to_string(),
            "1 warning generated.".to_string(),
        ]
    );
}

#[test]
fn indented_tab_prefixed_verbatim_block_round_trips() {
    // Base indent 1 (single leading tab on open/content/close), with content
    // lines that carry their own *extra* indentation as literal spaces
    // (ordinary shell-script indentation), which must be preserved verbatim.
    let input = "====== Shell Snippet ======\n\nA small script, indented one level:\n\n\t'''\n\t#!/bin/sh\n\tfor f in *.txt; do\n\t    echo \"$f\"\n\tdone\n\t'''\n\nThat's the whole thing.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let v = only_verbatim_block(&page);
    assert_eq!(v.indent, 1);
    assert!(v.closed);
    assert_eq!(
        v.content_lines,
        vec![
            "#!/bin/sh".to_string(),
            "for f in *.txt; do".to_string(),
            "    echo \"$f\"".to_string(),
            "done".to_string(),
        ]
    );
}

#[test]
fn nested_bare_triple_quote_at_deeper_indent_does_not_close_the_block_early() {
    // The tricky case: an indented verbatim block (base indent 1) whose
    // content is a function containing its OWN nested docstring, delimited
    // by a "'''" pair that sits at TWO leading tabs (deeper than the
    // outer block's base indent of one tab). Neither inner "'''" line may
    // close the outer block -- only the final line back at exactly one
    // leading tab may do so.
    let input = "====== Snippet Gallery ======\n\nA saved function with its own docstring delimiter inside:\n\n\t'''\n\tdef foo():\n\t\t'''\n\t\tThis is a nested docstring, not the block terminator.\n\t\t'''\n\treturn 42\n\t'''\n\nThat's all for now.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let v = only_verbatim_block(&page);
    assert_eq!(v.indent, 1, "block's own base indent must be 1, from its opening line");
    assert!(
        v.closed,
        "the block must still find its real closing delimiter at the end"
    );
    // The two nested "'''" lines survive as literal content, each keeping the
    // one extra tab of indentation beyond the block's base indent.
    assert_eq!(
        v.content_lines,
        vec![
            "def foo():".to_string(),
            "\t'''".to_string(),
            "\tThis is a nested docstring, not the block terminator.".to_string(),
            "\t'''".to_string(),
            "return 42".to_string(),
        ]
    );
    // In particular, neither nested delimiter line was mistaken for the
    // close: exactly two "'''"-only content lines remain, both still
    // carrying their extra tab (i.e. they were never treated as the base
    // indent's own closing line, which would have been stripped down to a
    // bare "'''" with no leading tab left).
    let bare_close_candidates: Vec<&String> =
        v.content_lines.iter().filter(|l| l.trim_start_matches('\t') == "'''").collect();
    assert_eq!(bare_close_candidates.len(), 2);
    for l in &bare_close_candidates {
        assert_eq!(l.as_str(), "\t'''", "nested delimiter must keep its one extra tab as literal text");
    }
}

#[test]
fn nested_bare_triple_quote_immediately_at_block_start_does_not_close_early() {
    // Variant of the above with the nested delimiter as the very first
    // content line (no intervening text), to make sure the "first match at
    // the block's own indent wins" rule isn't accidentally short-circuited
    // by position rather than by indent comparison.
    let input = "\t'''\n\t\t'''\n\tstill inside, right after a deeper-indented delimiter\n\t'''\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let v = only_verbatim_block(&page);
    assert_eq!(v.indent, 1);
    assert!(v.closed);
    assert_eq!(
        v.content_lines,
        vec![
            "\t'''".to_string(),
            "still inside, right after a deeper-indented delimiter".to_string(),
        ]
    );
}

#[test]
fn inline_verbatim_suppresses_all_lookalike_markup_inside_it() {
    // ''...'' containing tokens that look like every other inline marker in
    // the table (bold, italic, underline, strike, superscript, subscript,
    // a tag, a link, and a bare URL) -- none of it may be parsed as markup;
    // it must all come back as the raw text of a single Inline::Verbatim.
    let input = "Formula reference: ''a**b**c //d// __e__ ~~f~~ @tag [[Page]] https://x.test g^{2} h_{3}'' end of line.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::Paragraph(p) = &page.body.blocks[0] else {
        panic!("expected a paragraph block, got {:?}", page.body.blocks[0]);
    };

    let verbatim_spans: Vec<&String> = p
        .text
        .iter()
        .filter_map(|sp| match sp {
            Inline::Verbatim(t) => Some(t),
            _ => None,
        })
        .collect();
    assert_eq!(verbatim_spans.len(), 1, "expected exactly one inline verbatim span");
    assert_eq!(
        verbatim_spans[0],
        "a**b**c //d// __e__ ~~f~~ @tag [[Page]] https://x.test g^{2} h_{3}"
    );

    // None of the lookalike markers were parsed as their real inline kind
    // anywhere in the paragraph (the verbatim span holds a plain String, not
    // a Vec<Inline>, so this also guards against a boundary-matching bug
    // that might otherwise let content leak out of the verbatim span).
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Bold(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Italic(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Underline(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Strike(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Superscript(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Subscript(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Tag(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::Link(_))));
    assert!(!p.text.iter().any(|sp| matches!(sp, Inline::AutoUrl(_))));
}
