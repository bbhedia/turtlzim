//! Adversarial round-trip verification: images/embeds (spec §3.5) and the
//! horizontal rule (spec §2.5).
//!
//! All fixtures below are original content written for this review — nothing
//! is copied from any Zim project source, docs, or tests (per CLAUDE.md).

use zim_format::{parse, Block, Image, Inline};

/// Find the first `Inline::Image` in a page's top-level paragraph blocks.
/// Every fixture here keeps its image on an unnested paragraph line, so
/// there is no need to recurse into bold/italic/etc. spans.
fn first_image(text: &str) -> Image {
    let page = parse(text);
    for block in &page.body.blocks {
        if let Block::Paragraph(p) = block {
            for span in &p.text {
                if let Inline::Image(img) = span {
                    return img.clone();
                }
            }
        }
    }
    panic!("no image found in parsed page for input: {text:?}");
}

#[test]
fn plain_image_round_trips_and_has_empty_query() {
    let text = "Here is a snapshot: {{./pic.png}} taken yesterday.\n";
    let page = parse(text);
    assert_eq!(page.serialize(), text);

    let img = first_image(text);
    assert_eq!(img.path, "./pic.png");
    assert!(
        img.query.is_empty(),
        "expected no query params, got {:?}",
        img.query
    );
    assert_eq!(img.alt, None);
}

#[test]
fn image_with_single_query_param_round_trips() {
    let text = "See diagram: {{./pic.png?height=40}}\n";
    let page = parse(text);
    assert_eq!(page.serialize(), text);

    let img = first_image(text);
    assert_eq!(img.path, "./pic.png");
    assert_eq!(
        img.query,
        vec![("height".to_string(), Some("40".to_string()))]
    );
    assert_eq!(img.alt, None);
}

#[test]
fn image_with_multiple_params_and_label_round_trips() {
    let text = "{{../diagrams/roadmap.png?width=480&height=320|Roadmap sketch}}\n";
    let page = parse(text);
    assert_eq!(page.serialize(), text);

    let img = first_image(text);
    assert_eq!(img.path, "../diagrams/roadmap.png");
    assert_eq!(
        img.query,
        vec![
            ("width".to_string(), Some("480".to_string())),
            ("height".to_string(), Some("320".to_string())),
        ]
    );
    assert_eq!(img.alt.as_deref(), Some("Roadmap sketch"));
}

#[test]
fn image_percent_encoded_param_value_round_trips_raw() {
    // %3A is a percent-encoded ':'. Spec §3.5: "values may be percent-encoded
    // ... store the raw encoded string, don't decode/re-encode it ourselves."
    let text = "{{./archive/notes.png?href=Projects%3AOverview}}\n";
    let page = parse(text);
    assert_eq!(page.serialize(), text);

    let img = first_image(text);
    assert_eq!(img.path, "./archive/notes.png");
    assert_eq!(
        img.query,
        vec![(
            "href".to_string(),
            Some("Projects%3AOverview".to_string())
        )],
        "the percent-encoded value must be preserved exactly, not decoded"
    );
}

#[test]
fn image_unknown_query_param_keys_are_preserved_not_dropped() {
    // "sparkle" and "mood" are not among the spec's recognized keys
    // (height/width/href/type) — spec §3.5: "Unknown keys must still
    // round-trip (store as opaque key/value pairs, not a fixed struct)."
    let text = "{{./gallery/sunset.jpg?sparkle=42&mood=cozy}}\n";
    let page = parse(text);
    assert_eq!(page.serialize(), text);

    let img = first_image(text);
    assert_eq!(img.path, "./gallery/sunset.jpg");
    assert_eq!(
        img.query,
        vec![
            ("sparkle".to_string(), Some("42".to_string())),
            ("mood".to_string(), Some("cozy".to_string())),
        ],
        "unknown query param keys must round-trip, not be silently dropped"
    );
}

#[test]
fn horizontal_rule_33_dashes_round_trips_without_normalization() {
    // 33 is deliberately not one of the "round" counts (20) shown in the
    // spec's own example, to catch any implementation that quietly snaps
    // the stored/rendered dash count to a canonical width.
    let dashes = "-".repeat(33);
    let text = format!("Above the rule.\n\n{dashes}\n\nBelow the rule.\n");
    let page = parse(&text);
    assert_eq!(page.serialize(), text);

    let hr = page
        .body
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::HorizontalRule(hr) => Some(hr),
            _ => None,
        })
        .expect("expected a horizontal rule block");
    assert_eq!(
        hr.dash_count, 33,
        "dash count must round-trip exactly, not be normalized to a fixed width"
    );
}

#[test]
fn horizontal_rule_15_dashes_round_trips_byte_identical() {
    // Spec §2.5 says only "at least some minimum run (Zim's own example uses
    // 20 dashes...)" without pinning an exact minimum run length. Whatever a
    // conforming implementation decides for *classification* at this length,
    // byte-identical round-trip must hold, and if it *is* classified as a
    // horizontal rule the exact count (15, not 20 or any other count) must be
    // what is stored and re-emitted.
    let dashes = "-".repeat(15);
    let text = format!("Above the rule.\n\n{dashes}\n\nBelow the rule.\n");
    let page = parse(&text);
    assert_eq!(page.serialize(), text);

    let classified_as_hr = page.body.blocks.iter().find_map(|b| match b {
        Block::HorizontalRule(hr) => Some(hr.dash_count),
        _ => None,
    });
    eprintln!(
        "horizontal_rule_15_dashes_round_trips_byte_identical: classified_as_hr = {classified_as_hr:?}"
    );
    if let Some(dash_count) = classified_as_hr {
        assert_eq!(
            dash_count, 15,
            "if classified as a horizontal rule, the exact dash count must be preserved"
        );
    }
}
