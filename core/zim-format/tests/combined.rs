//! §4 golden-file round-trip test: one larger, original fixture combining
//! headers, every in-scope block type, nested/mixed lists, a nested-verbatim
//! edge case, opaque table and object blocks, and adjacent (no-space)
//! inline markup — exercising nesting and adjacency edge cases together.

mod common;
use common::assert_roundtrip;
use zim_format::Block;

const FIXTURE: &str = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\n\n====== Weekly Report ======\n\nThis report covers **status**, //risks//, and next steps for the @project-zeta tag.\n\n=== Status {{id: status}} ===\n\n\tThe team is on track. See [[Planning|the planning page]] for details,\n\tor visit https://example.org/status for the live dashboard.\n\n* Workstreams\n\t1. Backend\n\t2. Frontend\n\t\ta. Styling\n\t\tb. Accessibility\n\t[ ] Docs (not started)\n\t[x] Kickoff (done)\n\n--------------------\n\n'''\ndef status():\n\t'''nested docstring marker'''\n\treturn \"ok\"\n'''\n\n|Stream|Owner|\n|------|-----|\n|Backend|Alice|\n|Frontend|Bob|\n\n{{{equation: v = d / t\n}}}\n\nSee {{./chart.png?width=300|Status chart}} for the chart. Contact**Ops Team**[[Escalation]] if blocked,@urgent right away.\n";

#[test]
fn everything_at_once_round_trips_exactly() {
    assert_roundtrip(FIXTURE);
}

#[test]
fn everything_at_once_has_the_expected_shape() {
    let page = zim_format::parse(FIXTURE);
    assert_eq!(page.headers.as_ref().map(|h| h.len()), Some(2));

    let mut headings = 0;
    let mut lists = 0;
    let mut verbatims = 0;
    let mut hrs = 0;
    let mut opaques = 0;
    for b in &page.body.blocks {
        match b {
            Block::Heading(_) => headings += 1,
            Block::List(_) => lists += 1,
            Block::Verbatim(_) => verbatims += 1,
            Block::HorizontalRule(_) => hrs += 1,
            Block::Opaque(_) => opaques += 1,
            _ => {}
        }
    }
    assert_eq!(headings, 2);
    assert_eq!(lists, 1);
    assert_eq!(verbatims, 1);
    assert_eq!(hrs, 1);
    assert_eq!(opaques, 2, "expected both the table and the object block");

    let list = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::List(l) => Some(l),
            _ => None,
        })
        .unwrap();
    assert_eq!(list.items.len(), 7);
    assert!(list.items.iter().any(|i| i.indent == 2), "expected depth-2 nesting");

    let verbatim = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Verbatim(v) => Some(v),
            _ => None,
        })
        .unwrap();
    assert!(verbatim.closed);
    assert!(verbatim
        .content_lines
        .iter()
        .any(|l| l.contains("'''nested docstring marker'''")));
}
