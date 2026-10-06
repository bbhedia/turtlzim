//! Syntax spans: where each construct sits in the text. The structural guarantees (bounds, order,
//! nesting, marker ownership, delimiters, counts) are in `common::span_problem`, which every test
//! here also applies; these tests show, for each construct, exactly which text its spans cover.

mod common;
use common::assert_spans_well_formed;
use zim_format::highlight::{list_marker, opaque, VERBATIM_UNTERMINATED};
use zim_format::{highlight, to_utf16, utf16_offsets, Span, SpanKind};

/// One line per span: its kind (a marker shows its owner's), the exact text it covers, and its
/// `detail` when that means something.
fn dump(text: &str) -> Vec<String> {
    assert_spans_well_formed(text);
    let spans = highlight(text);
    spans
        .iter()
        .map(|s| {
            let slice = &text[s.start..s.end];
            match s.kind {
                SpanKind::Marker => {
                    format!("Marker({}) {slice:?}", spans[s.detail as usize].kind.name())
                }
                kind if s.detail != 0 => format!("{} {slice:?} #{}", kind.name(), s.detail),
                kind => format!("{} {slice:?}", kind.name()),
            }
        })
        .collect()
}

#[test]
fn plain_text_and_blank_lines_have_no_spans() {
    assert_eq!(dump(""), Vec::<String>::new());
    assert_eq!(dump("\n\n\n"), Vec::<String>::new());
    assert_eq!(dump("just some words\nand more\n"), Vec::<String>::new());
}

#[test]
fn a_heading_is_its_line_and_its_two_marker_runs() {
    assert_eq!(
        dump("====== Title ======\n== Small ==\n"),
        [
            r#"Heading "====== Title ======" #1"#,
            r#"Marker(Heading) "====== ""#,
            r#"Marker(Heading) " ======""#,
            r#"Heading "== Small ==" #5"#,
            r#"Marker(Heading) "== ""#,
            r#"Marker(Heading) " ==""#,
        ]
    );
}

#[test]
fn inline_markup_nests_and_each_construct_owns_its_markers() {
    assert_eq!(
        dump("a **b //c// d** e"),
        [
            r#"Bold "**b //c// d**""#,
            r#"Marker(Bold) "**""#,
            r#"Italic "//c//""#,
            r#"Marker(Italic) "//""#,
            r#"Marker(Italic) "//""#,
            r#"Marker(Bold) "**""#,
        ]
    );
    assert_eq!(
        dump("__u__ ~~s~~ ''v **not bold** v'' x^{2} H_{2}O"),
        [
            r#"Underline "__u__""#,
            r#"Marker(Underline) "__""#,
            r#"Marker(Underline) "__""#,
            r#"Strike "~~s~~""#,
            r#"Marker(Strike) "~~""#,
            r#"Marker(Strike) "~~""#,
            r#"InlineVerbatim "''v **not bold** v''""#,
            r#"Marker(InlineVerbatim) "''""#,
            r#"Marker(InlineVerbatim) "''""#,
            r#"Superscript "^{2}""#,
            r#"Marker(Superscript) "^{""#,
            r#"Marker(Superscript) "}""#,
            r#"Subscript "_{2}""#,
            r#"Marker(Subscript) "_{""#,
            r#"Marker(Subscript) "}""#,
        ]
    );
}

#[test]
fn links_split_into_brackets_target_and_display() {
    assert_eq!(
        dump("[[Page]] and [[Other:Page|shown text]]"),
        [
            r#"Link "[[Page]]""#,
            r#"Marker(Link) "[[""#,
            r#"LinkTarget "Page""#,
            r#"Marker(Link) "]]""#,
            r#"Link "[[Other:Page|shown text]]""#,
            r#"Marker(Link) "[[""#,
            // #1: this target has a display part, so a preview hides it
            r#"LinkTarget "Other:Page" #1"#,
            r#"Marker(Link) "|""#,
            r#"LinkDisplay "shown text""#,
            r#"Marker(Link) "]]""#,
        ]
    );
}

#[test]
fn tags_urls_emails_images_and_anchors() {
    assert_eq!(
        dump("@todo see http://example.org or mail me@example.org {{./a.png?width=5|alt}} {{id: here}}"),
        [
            r#"Tag "@todo""#,
            r#"AutoUrl "http://example.org""#,
            r#"AutoEmail "me@example.org""#,
            r#"Image "{{./a.png?width=5|alt}}""#,
            r#"Marker(Image) "{{""#,
            r#"Marker(Image) "}}""#,
            r#"Anchor "{{id: here}}""#,
            r#"Marker(Anchor) "{{id:""#,
            r#"Marker(Anchor) "}}""#,
        ]
    );
}

#[test]
fn list_items_have_a_line_span_and_a_marker_span_with_a_code() {
    let text = "* bullet\n\t[*] done\n1. one\na. alpha\nA. Alpha\n[x] crossed\n[>] moved\n";
    let spans = highlight(text);
    assert_spans_well_formed(text);
    let markers: Vec<(&str, u32)> = spans
        .iter()
        .filter(|s| s.kind == SpanKind::ListMarker)
        .map(|s| (&text[s.start..s.end], s.detail))
        .collect();
    assert_eq!(
        markers,
        [
            ("* ", list_marker::BULLET),
            ("[*] ", list_marker::CHECKED),
            ("1. ", list_marker::NUMBER),
            ("a. ", list_marker::LOWER_ALPHA),
            ("A. ", list_marker::UPPER_ALPHA),
            ("[x] ", list_marker::XCHECKED),
            ("[>] ", list_marker::MIGRATED),
        ]
    );
    let items: Vec<(&str, u32)> = spans
        .iter()
        .filter(|s| s.kind == SpanKind::ListItem)
        .map(|s| (&text[s.start..s.end], s.detail))
        .collect();
    assert_eq!(items[0], ("* bullet", 0));
    assert_eq!(
        items[1],
        ("\t[*] done", 1),
        "the item span includes the indent; detail is its depth"
    );
}

#[test]
fn inline_markup_inside_a_list_item_is_found_at_the_right_place() {
    assert_eq!(
        dump("\t* see **this** and [[that]]"),
        [
            r#"ListItem "\t* see **this** and [[that]]" #1"#,
            r#"ListMarker "* " #1"#,
            r#"Bold "**this**""#,
            r#"Marker(Bold) "**""#,
            r#"Marker(Bold) "**""#,
            r#"Link "[[that]]""#,
            r#"Marker(Link) "[[""#,
            r#"LinkTarget "that""#,
            r#"Marker(Link) "]]""#,
        ]
    );
}

#[test]
fn verbatim_blocks_cover_their_fences_and_content_lines() {
    assert_eq!(
        dump("'''\nraw **text**\n'''\n"),
        [
            "VerbatimBlock \"'''\\nraw **text**\\n'''\"",
            "Marker(VerbatimBlock) \"'''\"",
            "Marker(VerbatimBlock) \"'''\"",
        ]
    );
    // Never closed: runs to the end, flagged, and only the opening fence is a marker.
    let text = "\t'''\n\tcode\n";
    let spans = highlight(text);
    assert_spans_well_formed(text);
    assert_eq!(spans[0].kind, SpanKind::VerbatimBlock);
    assert_eq!(spans[0].detail, 1 | VERBATIM_UNTERMINATED);
    assert_eq!(
        spans.iter().filter(|s| s.kind == SpanKind::Marker).count(),
        1
    );
}

#[test]
fn rules_tables_and_objects() {
    let text =
        "--------------------\n\n| a | b |\n|---|---|\n\n{{{code: lang=\"python\"\nprint(1)\n}}}\n";
    let spans = highlight(text);
    assert_spans_well_formed(text);
    let rule = spans
        .iter()
        .find(|s| s.kind == SpanKind::HorizontalRule)
        .unwrap();
    assert_eq!(
        (&text[rule.start..rule.end], rule.detail),
        ("--------------------", 20)
    );
    let blocks: Vec<(&str, u32)> = spans
        .iter()
        .filter(|s| s.kind == SpanKind::Opaque)
        .map(|s| (&text[s.start..s.end], s.detail))
        .collect();
    assert_eq!(
        blocks,
        [
            ("| a | b |\n|---|---|", opaque::TABLE),
            ("{{{code: lang=\"python\"\nprint(1)\n}}}", opaque::OBJECT)
        ]
    );
}

#[test]
fn an_indented_paragraph_maps_inline_markup_across_its_tab_prefixed_lines() {
    // The bold text runs across a line break; every line is prefixed with its tab in the page,
    // and the span must cover those tabs while the markers sit exactly on the asterisks.
    assert_eq!(
        dump("\tsome **bold\n\ttext** here\n"),
        [
            "IndentedParagraph \"\\tsome **bold\\n\\ttext** here\" #1",
            "Bold \"**bold\\n\\ttext**\"",
            "Marker(Bold) \"**\"",
            "Marker(Bold) \"**\"",
        ]
    );
    // And a deeper indent, with markup on the second line only.
    assert_eq!(
        dump("\t\tfirst\n\t\t//second//\n"),
        [
            "IndentedParagraph \"\\t\\tfirst\\n\\t\\t//second//\" #2",
            "Italic \"//second//\"",
            "Marker(Italic) \"//\"",
            "Marker(Italic) \"//\"",
        ]
    );
}

#[test]
fn the_header_block_and_its_keys() {
    assert_eq!(
        dump("Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nNote: long\n\tcontinued\n\n====== T ======\n"),
        [
            "Header \"Content-Type: text/x-zim-wiki\\nWiki-Format: zim 0.6\\nNote: long\\n\\tcontinued\"",
            "HeaderKey \"Content-Type:\"",
            "HeaderKey \"Wiki-Format:\"",
            "HeaderKey \"Note:\"",
            "Heading \"====== T ======\" #1",
            "Marker(Heading) \"====== \"",
            "Marker(Heading) \" ======\"",
        ]
    );
}

#[test]
fn the_empty_edge_cases_of_links_and_images() {
    // An empty target or display has no span of its own, only its brackets.
    for text in [
        "[[]]", "[[|]]", "[[a|]]", "[[|b]]", "{{}}", "{{?}}", "{{a?|}}", "''''", "****", "^{}",
        "_{}",
    ] {
        assert_spans_well_formed(text);
    }
    assert_eq!(
        dump("[[|b]]"),
        [
            r#"Link "[[|b]]""#,
            r#"Marker(Link) "[[""#,
            r#"Marker(Link) "|""#,
            r#"LinkDisplay "b""#,
            r#"Marker(Link) "]]""#,
        ]
    );
}

#[test]
fn a_page_using_every_construct_is_well_formed() {
    let text = "Content-Type: text/x-zim-wiki\nCreation-Date: 2099-01-02\n\n====== The Title ======\n\nPlain text with **bold**, //italic//, __underline__, ~~strike~~, ''verbatim'', x^{2} and H_{2}O.\nA [[Namespace:Page|link]], a [[+child]], http://example.org/path?q=1, me@example.org, @tag, {{./pic.png?width=100&height=50|alt}} and {{id: here}}.\n\n===== Lists =====\n\n* one\n\t* nested **bold**\n1. first\na. alpha\n[ ] open\n[*] done\n\n\tindented\n\twith //two// lines\n\n'''\nraw\n'''\n\n--------------------\n\n| a | b |\n\n{{{code\nx\n}}}\n\n== Last ==\n";
    assert_spans_well_formed(text);
    let kinds: std::collections::HashSet<SpanKind> =
        highlight(text).iter().map(|s| s.kind).collect();
    for kind in SpanKind::ALL {
        assert!(
            kinds.contains(kind),
            "the sample page doesn't exercise {kind:?}"
        );
    }
}

#[test]
fn utf16_offsets_index_the_same_text_as_a_javascript_string_would() {
    let text = "😀 **日本語** é \u{1d11e} [[ünï|𝔘]]\n";
    let bytes = highlight(text);
    let units = to_utf16(text, &bytes);
    assert_eq!(bytes.len(), units.len());
    let utf16: Vec<u16> = text.encode_utf16().collect();
    for (b, u) in bytes.iter().zip(&units) {
        assert_eq!((b.kind, b.detail), (u.kind, u.detail));
        let from_bytes = &text[b.start..b.end];
        let from_units = String::from_utf16(&utf16[u.start..u.end])
            .expect("a span must not split a surrogate pair");
        assert_eq!(from_units, from_bytes, "{:?} {:?}", b.kind, from_bytes);
    }
    // Non-BMP characters take two units, so the offsets really did move.
    assert!(bytes.iter().zip(&units).any(|(b, u)| b.start != u.start));
}

#[test]
fn spans_of_a_hand_built_page_match_the_text_it_serializes_to() {
    // `Page::spans` works on any page, not just parsed ones: positions come from what it renders.
    let text = "====== T ======\n* **x**\n";
    let page = zim_format::parse(text);
    assert_eq!(page.spans(), highlight(text));
    let _: &[Span] = &page.spans();
}

#[test]
fn the_utf16_offset_table_maps_every_byte() {
    // a (1 byte, 1 unit), a smiley (4 bytes, 2 units), b (1 byte, 1 unit)
    assert_eq!(utf16_offsets("a😀b"), [0, 1, 1, 1, 1, 3, 4]);
    assert_eq!(utf16_offsets(""), [0]);
    assert_eq!(utf16_offsets("é"), [0, 0, 1], "a byte inside a character maps to its start");
    assert_eq!(utf16_offsets("日本"), [0, 0, 0, 1, 1, 1, 2]);
}
