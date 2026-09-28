//! §2.6 opaque-passthrough round-trip tests: tables and object blocks are
//! out of scope for v1 but must still round-trip losslessly.

mod common;
use common::assert_roundtrip;
use zim_format::Block;

#[test]
fn table_block_round_trips_as_opaque() {
    let input = "Some intro text before the table.\n\n|Fruit|Color|\n|-----|-----|\n|Apple|Red|\n|Lime|Green|\n\nMore text after the table.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let opaque = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Opaque(o) => Some(o),
            _ => None,
        })
        .expect("expected an opaque block for the table");
    assert_eq!(opaque.raw_lines.len(), 4);
    assert_eq!(opaque.raw_lines[0], "|Fruit|Color|");
}

#[test]
fn table_block_boundary_without_trailing_blank_line() {
    // The table block must stop exactly where the '|...|' shape stops, even
    // with no blank line separating it from the next block.
    let input = "|A|B|\n|1|2|\nNot a table row anymore.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert!(matches!(page.body.blocks[0], Block::Opaque(_)));
    assert!(matches!(page.body.blocks[1], Block::Paragraph(_)));
}

#[test]
fn object_block_round_trips_as_opaque() {
    let input = "Here is a worked formula:\n\n{{{equation: x^2 + y^2 = z^2\nwhere x, y, z are the triangle's sides\n}}}\n\nDone.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    let opaque = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Opaque(o) => Some(o),
            _ => None,
        })
        .expect("expected an opaque block for the object block");
    assert_eq!(opaque.raw_lines.first().unwrap(), "{{{equation: x^2 + y^2 = z^2");
    assert_eq!(opaque.raw_lines.last().unwrap(), "}}}");
}
