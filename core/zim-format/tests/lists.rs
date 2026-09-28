//! §2.3 list round-trip tests: bullet, numbered (all three schemes, custom
//! start values), checkbox (all five states), and mixed nesting.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, CheckboxState, ListMarker, NumberStyle};

#[test]
fn bullet_list() {
    let input = "* First bullet item\n* Second bullet item\n* Third bullet item\n";
    assert_roundtrip(input);
}

#[test]
fn numbered_list_all_schemes_with_custom_start_values() {
    let input = "C. Gamma milestone\nD. Delta milestone\nE. Epsilon milestone\n\nc. third sub-point\nd. fourth sub-point\n\n3. third overall step\n4. fourth overall step\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let mut markers = page.body.blocks.iter().filter_map(|b| match b {
        Block::List(lb) => Some(lb.items[0].marker.clone()),
        _ => None,
    });
    assert_eq!(
        markers.next(),
        Some(ListMarker::Numbered {
            style: NumberStyle::UpperAlpha,
            start_token: "C".to_string()
        })
    );
    assert_eq!(
        markers.next(),
        Some(ListMarker::Numbered {
            style: NumberStyle::LowerAlpha,
            start_token: "c".to_string()
        })
    );
    assert_eq!(
        markers.next(),
        Some(ListMarker::Numbered {
            style: NumberStyle::Arabic,
            start_token: "3".to_string()
        })
    );
}

#[test]
fn checkbox_list_all_five_states() {
    let input = "[ ] unchecked task\n[*] checked task\n[x] xchecked (crossed out) task\n[>] migrated task\n[<] transmigrated task\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let states: Vec<CheckboxState> = page
        .body
        .blocks
        .iter()
        .flat_map(|b| match b {
            Block::List(lb) => lb.items.iter().map(|i| i.marker.clone()).collect(),
            _ => vec![],
        })
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
fn nested_mixed_list_with_independent_sub_counters() {
    // A bullet list whose children are: a numbered sub-list restarting its
    // own counter, and a checkbox sub-list with a plain bullet grandchild --
    // exercising mixed siblings/children (spec §2.3).
    let input = "* Project Alpha\n\t1. Design phase\n\t2. Build phase\n\t3. Ship phase\n* Project Beta\n\t[ ] Draft the spec\n\t[x] Old idea, abandoned\n\t\t* a random side note\n* Project Gamma\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let Block::List(lb) = &page.body.blocks[0] else {
        panic!("expected a single list block");
    };
    // Depth-2 nesting (two tabs) is present.
    assert!(lb.items.iter().any(|i| i.indent == 2));
}
