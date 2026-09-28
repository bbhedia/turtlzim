//! Adversarial verification fixtures for §2.3 (Lists), written independently
//! of the implementation and of the existing `tests/lists.rs` file. All
//! fixture text below is original content composed for this task — not
//! copied from any Zim repository.
//!
//! Coverage:
//!   - a plain bullet list with a tab-indented nested sub-list
//!   - a numbered list starting at 1 with a nested a./b.-scheme sub-list
//!   - numbered lists starting at an arbitrary value (arabic "5." and
//!     upper-alpha "C.")
//!   - the spec's own explicit example: a nested numbered sub-list that
//!     starts at a non-1 value ("3.") under a parent that started at "1."
//!   - all five checkbox states in one list
//!   - a checkbox list item with a plain bullet child (mixed list-type
//!     nesting)
//!   - extra adversarial cases: leading-zero start-token preservation,
//!     internal whitespace preservation after a checkbox marker, three
//!     levels of mixed-type nesting, and list blocks directly adjacent to
//!     paragraphs with no blank-line separator.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, CheckboxState, ListMarker, NumberStyle};

/// Pull out the flat sequence of `ListItem` markers from every `List` block
/// in a parsed page's body, in order. Helper for the structural assertions
/// below (round-trip alone wouldn't catch a marker parsed into the wrong
/// enum variant if serialization happens to still produce the same bytes).
fn all_markers(page: &zim_format::Page) -> Vec<ListMarker> {
    page.body
        .blocks
        .iter()
        .flat_map(|b| match b {
            Block::List(lb) => lb.items.iter().map(|i| i.marker.clone()).collect::<Vec<_>>(),
            _ => vec![],
        })
        .collect()
}

#[test]
fn plain_bullet_list_with_nested_sublist() {
    let input = "* Weekend garden tasks\n\t* Trim the hedges\n\t* Water the tomatoes\n* Kitchen tasks\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::List(lb) = &page.body.blocks[0] else {
        panic!("expected a single list block, got {:?}", page.body.blocks);
    };
    assert_eq!(lb.items.len(), 4);
    assert_eq!(lb.items[0].indent, 0);
    assert_eq!(lb.items[1].indent, 1);
    assert_eq!(lb.items[2].indent, 1);
    assert_eq!(lb.items[3].indent, 0);
    for item in &lb.items {
        assert_eq!(item.marker, ListMarker::Bullet);
    }
}

#[test]
fn numbered_list_starting_at_one_with_alpha_sublist() {
    let input = "1. Assemble the frame\n2. Attach the wheels\n\ta. Tighten the left bolt\n\tb. Tighten the right bolt\n3. Test the brakes\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let markers = all_markers(&page);
    assert_eq!(
        markers,
        vec![
            ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "1".to_string() },
            ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "2".to_string() },
            ListMarker::Numbered { style: NumberStyle::LowerAlpha, start_token: "a".to_string() },
            ListMarker::Numbered { style: NumberStyle::LowerAlpha, start_token: "b".to_string() },
            ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "3".to_string() },
        ]
    );
}

#[test]
fn numbered_list_starting_at_arbitrary_arabic_value() {
    // Spec §2.3: "lists may start at any value, e.g. `C.`, `D.`, `E.`" —
    // exercised here with a numeric start other than 1.
    let input = "5. Fifth checkpoint\n6. Sixth checkpoint\n7. Seventh checkpoint\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let markers = all_markers(&page);
    assert_eq!(
        markers[0],
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "5".to_string() }
    );
}

#[test]
fn numbered_list_starting_at_arbitrary_upper_alpha_value() {
    let input = "C. Cave entrance\nD. Deep tunnel\nE. Exit shaft\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let markers = all_markers(&page);
    assert_eq!(
        markers[0],
        ListMarker::Numbered { style: NumberStyle::UpperAlpha, start_token: "C".to_string() }
    );
}

#[test]
fn nested_numbered_sublist_starts_at_non_one_value() {
    // Directly exercises the spec's own example: "a nested list can start at
    // `3.` under a parent that started at `1.`".
    let input = "1. Opening remarks\n\t3. Continuing an earlier outline\n\t4. Wrapping up that point\n2. Closing remarks\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::List(lb) = &page.body.blocks[0] else {
        panic!("expected a single list block, got {:?}", page.body.blocks);
    };
    assert_eq!(
        lb.items[0].marker,
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "1".to_string() }
    );
    assert_eq!(lb.items[0].indent, 0);
    assert_eq!(
        lb.items[1].marker,
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "3".to_string() }
    );
    assert_eq!(lb.items[1].indent, 1);
    assert_eq!(
        lb.items[3].marker,
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "2".to_string() }
    );
    assert_eq!(lb.items[3].indent, 0);
}

#[test]
fn numbered_list_preserves_leading_zero_start_token() {
    // Adversarial: the start token is stored "verbatim" per spec §2.3, so a
    // leading zero must round-trip exactly rather than being renormalized
    // to a bare "5"/"6".
    let input = "05. Fifth prep step\n06. Sixth prep step\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let markers = all_markers(&page);
    assert_eq!(
        markers[0],
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "05".to_string() }
    );
}

#[test]
fn checkbox_list_all_five_states_in_one_list() {
    let input = "[ ] Draft the quarterly report\n[*] Confirm travel arrangements\n[x] Cancel the unused subscription\n[>] Move this to next sprint\n[<] Bring this back from last sprint\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let states: Vec<CheckboxState> = all_markers(&page)
        .into_iter()
        .map(|m| match m {
            ListMarker::Checkbox(s) => s,
            other => panic!("expected checkbox marker, got {other:?}"),
        })
        .collect();
    assert_eq!(
        states,
        vec![
            CheckboxState::Unchecked,
            CheckboxState::Checked,
            CheckboxState::Xchecked,
            CheckboxState::Migrated,
            CheckboxState::Transmigrated,
        ]
    );
}

#[test]
fn checkbox_item_with_plain_bullet_child() {
    // Mixed list-type nesting: a checkbox parent with a plain-bullet child,
    // then back out to a checkbox sibling (spec §2.3: "a checkbox list can
    // contain a plain bullet child").
    let input = "[ ] Plan the release\n\t* Notify the beta testers\n\t* Update the changelog\n[x] Tag the release commit\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::List(lb) = &page.body.blocks[0] else {
        panic!("expected a single list block, got {:?}", page.body.blocks);
    };
    assert_eq!(lb.items.len(), 4);
    assert_eq!(lb.items[0].marker, ListMarker::Checkbox(CheckboxState::Unchecked));
    assert_eq!(lb.items[0].indent, 0);
    assert_eq!(lb.items[1].marker, ListMarker::Bullet);
    assert_eq!(lb.items[1].indent, 1);
    assert_eq!(lb.items[2].marker, ListMarker::Bullet);
    assert_eq!(lb.items[2].indent, 1);
    assert_eq!(lb.items[3].marker, ListMarker::Checkbox(CheckboxState::Xchecked));
    assert_eq!(lb.items[3].indent, 0);
}

#[test]
fn checkbox_marker_preserves_extra_internal_whitespace() {
    // Adversarial: only the first space after "[ ]" is the marker separator;
    // a second, incidental space belongs to the item text and must survive
    // round-trip rather than being trimmed.
    let input = "[ ]  double-spaced item text\n";
    assert_roundtrip(input);
}

#[test]
fn three_level_mixed_type_nesting() {
    // Stress the indent-transition logic across all three marker kinds at
    // increasing then decreasing depth: bullet -> numbered -> checkbox ->
    // bullet (deepest) -> back up to numbered at depth 1.
    let input = "* Top level bullet\n\t1. Nested numbered step\n\t\t[ ] Nested checkbox under numbered\n\t\t\t* Deeply nested bullet note\n\t2. Second nested numbered step\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::List(lb) = &page.body.blocks[0] else {
        panic!("expected a single list block, got {:?}", page.body.blocks);
    };
    let indents: Vec<usize> = lb.items.iter().map(|i| i.indent).collect();
    assert_eq!(indents, vec![0, 1, 2, 3, 1]);
    assert_eq!(lb.items[0].marker, ListMarker::Bullet);
    assert_eq!(
        lb.items[1].marker,
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "1".to_string() }
    );
    assert_eq!(lb.items[2].marker, ListMarker::Checkbox(CheckboxState::Unchecked));
    assert_eq!(lb.items[3].marker, ListMarker::Bullet);
    assert_eq!(
        lb.items[4].marker,
        ListMarker::Numbered { style: NumberStyle::Arabic, start_token: "2".to_string() }
    );
}

#[test]
fn list_immediately_followed_by_paragraph_no_blank_line() {
    // Adversarial block-boundary case: nothing in spec §2.2/§2.3 requires a
    // blank line between a list and a following paragraph; the scanner must
    // still split them into two distinct blocks and round-trip exactly.
    let input = "* Line one of the list\n* Line two of the list\nThis paragraph directly follows the list with no blank line before it.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    // (Not asserting an exact block count: a trailing "\n" in the input
    // produces a trailing synthetic `Blank(1)` block from the `split('\n')`
    // artifact, which is unrelated to what this test is checking.)
    assert!(matches!(page.body.blocks[0], Block::List(_)));
    assert!(matches!(page.body.blocks[1], Block::Paragraph(_)));
}

#[test]
fn paragraph_immediately_followed_by_list_no_blank_line() {
    let input = "This paragraph is followed immediately by a list, with no blank line between them.\n* First list item right after\n* Second list item right after\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(matches!(page.body.blocks[0], Block::Paragraph(_)));
    assert!(matches!(page.body.blocks[1], Block::List(_)));
}

#[test]
fn full_page_with_heading_then_list_then_heading() {
    // Combined fixture: verify list parsing composes correctly with the
    // surrounding page structure (header block, headings, blank-line block
    // separation) rather than only in isolation.
    let input = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\n\n====== Errand Tracker ======\n\n[ ] Pick up dry cleaning\n[x] Return library books\n\t* Ask about the late fee\n[>] Renew car registration\n\n===== Notes =====\nEverything above must survive a byte-identical round trip.\n";
    assert_roundtrip(input);
}
