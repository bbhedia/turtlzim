//! §2.5 horizontal rule round-trip tests.

mod common;
use common::assert_roundtrip;
use zim_format::Block;

#[test]
fn horizontal_rule_exact_dash_count_preserved() {
    let input = "Above the rule.\n\n--------------------\n\nBelow the rule.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let hr = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::HorizontalRule(hr) => Some(hr),
            _ => None,
        })
        .expect("expected a horizontal rule");
    assert_eq!(hr.dash_count, 20);
}

#[test]
fn longer_horizontal_rule_dash_count_not_normalized() {
    let input = "------------------------------\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::HorizontalRule(hr) = &page.body.blocks[0] else {
        panic!("expected a horizontal rule");
    };
    assert_eq!(hr.dash_count, 30);
}

#[test]
fn short_dash_run_is_not_a_horizontal_rule() {
    // Below the minimum run length, a dash line is just paragraph text.
    let input = "-----\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(!page
        .body
        .blocks
        .iter()
        .any(|b| matches!(b, Block::HorizontalRule(_))));
}
