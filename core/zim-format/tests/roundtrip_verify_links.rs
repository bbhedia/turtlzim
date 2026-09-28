//! Adversarial verification fixtures for spec §3.3 (links), §3.4 (tags), and
//! §3.6 (anchors).
//!
//! All prose/content below is composed originally for this verification
//! pass; nothing is copied from any Zim project source, docs, or tests. Only
//! the crate's public API (`zim_format::parse`, `Page::serialize`, the
//! exported `Block`/`Inline`/`Link` types) is used.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline, Link};

/// Parse `text` and return the inline spans of its first block, which every
/// fixture here arranges to be a single paragraph.
fn paragraph_spans(text: &str) -> Vec<Inline> {
    let page = zim_format::parse(text);
    match &page.body.blocks[0] {
        Block::Paragraph(p) => p.text.clone(),
        other => panic!("expected first block to be a Paragraph, got {other:?}"),
    }
}

fn links_in(spans: &[Inline]) -> Vec<&Link> {
    spans
        .iter()
        .filter_map(|s| match s {
            Inline::Link(l) => Some(l),
            _ => None,
        })
        .collect()
}

fn tags_in(spans: &[Inline]) -> Vec<&str> {
    spans
        .iter()
        .filter_map(|s| match s {
            Inline::Tag(name) => Some(name.as_str()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// §3.3 Links — every bracketed form in the spec's table, individually.
// ---------------------------------------------------------------------------

#[test]
fn same_level_link_defaults_display_to_target() {
    let input = "Check the [[ShoppingList]] before you leave for the market.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "ShoppingList");
    assert_eq!(
        links[0].display, None,
        "spec §3.3: '[[foo]] ... display text defaults to the target (\"foo\")' — \
         no separate display string should be stored when there is no '|'"
    );
}

#[test]
fn absolute_root_link() {
    let input = "Our conventions live at [[:Reference:StyleGuide]] for everyone to read.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, ":Reference:StyleGuide");
    assert_eq!(links[0].display, None);
}

#[test]
fn sub_page_link() {
    let input = "See the [[+Materials]] sub-page for the parts list.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "+Materials");
}

#[test]
fn link_with_pipe_display_text() {
    let input = "Background reading: [[Projects:Greenhouse|the greenhouse build log]].\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "Projects:Greenhouse");
    assert_eq!(links[0].display.as_deref(), Some("the greenhouse build log"));
}

#[test]
fn link_to_anchor_on_another_page() {
    let input = "The wiring budget is documented at [[Projects:Greenhouse#power-budget]].\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "Projects:Greenhouse#power-budget");
    assert_eq!(links[0].display, None);
}

#[test]
fn link_to_anchor_on_the_current_page() {
    let input = "Jump back up to [[#power-budget]] once you've read this part.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "#power-budget");
}

#[test]
fn interwiki_style_link_is_kept_as_one_opaque_target() {
    let input = "The upstream page is mirrored at [[wp?SomePage]] for reference.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(
        links[0].target, "wp?SomePage",
        "spec §3.3: interwiki links are 'kept as an opaque href, not resolved' — the whole \
         'shorthand-key?PageName' string is one target, the '?' is not a separate field"
    );
    assert_eq!(links[0].display, None);
}

#[test]
fn single_bracket_form_is_never_parsed_as_a_link() {
    let input = "The build produced tag [not:a:link] which is just a label string.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(
        links_in(&spans).is_empty(),
        "spec §3.3: 'a single-bracket form ... is not a link — only doubled [[...]] triggers \
         link parsing', so no Inline::Link may be produced here"
    );
    let literal_intact = spans
        .iter()
        .any(|s| matches!(s, Inline::Text(t) if t.contains("[not:a:link]")));
    assert!(
        literal_intact,
        "the bracketed text must survive as ordinary literal text, unsplit"
    );
}

#[test]
fn several_link_forms_share_one_paragraph_with_prose_and_an_unmatched_bracket_between_them() {
    // Adversarial adjacency: an absolute link, a same-page-anchor link, an
    // interwiki link, and a single (non-doubled, unmatched) bracket all in
    // one run of prose, to check that block boundaries and marker matching
    // don't bleed into each other.
    let input = "Start at [[:Home]], then [[#see-also]], then the [[wp?SomePage]] mirror; \
        note that [misc-tag-123 is just an unmatched single bracket, not a link.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links = links_in(&spans);
    assert_eq!(links.len(), 3);
    assert_eq!(links[0].target, ":Home");
    assert_eq!(links[1].target, "#see-also");
    assert_eq!(links[2].target, "wp?SomePage");
}

// ---------------------------------------------------------------------------
// §3.3 Autolinking — bare URLs, `mailto:` URIs, and bare email addresses.
// ---------------------------------------------------------------------------

#[test]
fn bare_url_and_bare_email_autolink_with_no_brackets_in_plain_prose() {
    let input =
        "Our workshop notes are posted at https://example-co.test/workshop and questions go to \
         crew@example-co.test any time.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    let urls: Vec<&str> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoUrl(u) => Some(u.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(urls, vec!["https://example-co.test/workshop"]);

    let emails: Vec<&str> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoEmail(e) => Some(e.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(emails, vec!["crew@example-co.test"]);
}

#[test]
fn bare_mailto_uri_is_its_own_documented_form_distinct_from_a_bare_email() {
    let input = "You can also reach the crew via mailto:crew@example-co.test if that's easier.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    let urls: Vec<&str> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoUrl(u) => Some(u.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        urls,
        vec!["mailto:crew@example-co.test"],
        "spec §3.3 lists 'mailto: URIs' as their own bullet, alongside (not the same as) bare \
         email addresses"
    );

    let emails: Vec<&str> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoEmail(e) => Some(e.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        emails.is_empty(),
        "the address inside a mailto: URI must not *also* be reported as a separate bare email"
    );
}

#[test]
fn bare_url_recognized_at_the_very_start_of_a_paragraph() {
    // Spec §3.3: bare URLs/emails autolink "wherever they appear in text" —
    // check the boundary case of a URL as the very first thing in the block,
    // with nothing before it for a preceding-character check to key off of,
    // and nothing (e.g. a heading) above it in the page.
    //
    // ADVERSARIAL FINDING: this input has no header block at all (spec §1.1:
    // a page with no headers is valid and common) and should parse as one
    // Paragraph block containing an AutoUrl span. Instead, header detection
    // (spec §1.1) greedily treats the whole first line as a header field
    // `"https": "//example-co.test/front-page is the entry point for new
    // members."` (any `[\w-]+` prefix before *any* colon in the line
    // qualifies as a key, with no requirement that a space follow the colon
    // the way every `Key: value` example in the spec shows) and consumes it,
    // leaving the body with zero blocks. Byte-identical round-trip still
    // holds (checked above), but the parsed document model is wrong: the
    // entire paragraph silently disappears from `page.body.blocks` and gets
    // replaced by a bogus header field.
    let input = "https://example-co.test/front-page is the entry point for new members.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert_eq!(
        page.headers, None,
        "expected no header block (there is no blank-line-separated RFC822 block here, just a \
         paragraph) but got: {:?}",
        page.headers
    );
    // [Paragraph(url sentence), Blank(1)]: the trailing "\n" on `input`
    // splits into its own final empty line, which (per spec §2.2 -- "every
    // line belongs to exactly one block, including blank lines") becomes a
    // trailing `Block::Blank(1)`, exactly as
    // `run_of_four_consecutive_blank_lines_is_preserved_exactly` above
    // documents for the same reason.
    assert_eq!(
        page.body.blocks.len(),
        2,
        "expected [Paragraph(url sentence), Blank(1)] = 2 blocks, but the opening paragraph was \
         silently absorbed into a bogus header field instead: {:?}",
        page.body.blocks
    );
    assert!(matches!(page.body.blocks[0], Block::Paragraph(_)));
}

#[test]
fn bare_email_recognized_at_the_very_end_of_a_paragraph() {
    let input = "For anything urgent, write to duty.officer@example-co.test\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::AutoEmail(e) if e == "duty.officer@example-co.test")));
}

#[test]
fn bare_url_at_the_very_start_of_a_realistic_multi_block_page() {
    // Same defect as `bare_url_recognized_at_the_very_start_of_a_paragraph`
    // above, but in a shape that can't be dismissed as a single-line/EOF
    // artifact: an entirely ordinary page — first paragraph happens to open
    // with a bare URL, then a blank line, then a heading and more text, with
    // no header block intended anywhere. Per spec §1.1 a page with no
    // headers is valid and common, and per spec §3.3 the URL should just
    // autolink inside an ordinary first paragraph.
    let input = "https://example-co.test/front-page is the entry point for new members.\n\n\
        ====== Some Heading ======\nMore body text after the heading.\n";
    assert_roundtrip(input);

    let page = zim_format::parse(input);
    assert_eq!(
        page.headers, None,
        "expected no header block for an ordinary page whose first paragraph starts with a \
         bare URL, but got: {:?}",
        page.headers
    );
    // [Paragraph(url sentence), Blank(1), Heading, Paragraph, Blank(1)]: as
    // in the single-line variant above, `input`'s trailing "\n" contributes
    // its own final trailing `Block::Blank(1)` in addition to the blank
    // line separating the opening paragraph from the heading.
    assert_eq!(
        page.body.blocks.len(),
        5,
        "expected [Paragraph(url sentence), Blank(1), Heading, Paragraph, Blank(1)] = 5 blocks, \
         but the opening paragraph was silently absorbed into a bogus header field instead: {:?}",
        page.body.blocks
    );
    assert!(matches!(page.body.blocks[0], Block::Paragraph(_)));
    assert!(matches!(page.body.blocks[2], Block::Heading(_)));
}

// ---------------------------------------------------------------------------
// §3.4 Tags
// ---------------------------------------------------------------------------

#[test]
fn a_couple_of_tags_in_body_text_preserve_original_casing() {
    let input = "Remember this @errand and flag it as @Urgent for tomorrow's stand-up.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let tags = tags_in(&spans);
    assert_eq!(
        tags,
        vec!["errand", "Urgent"],
        "spec §3.4: tag names are case-insensitive for matching but the original casing must \
         be stored/round-tripped"
    );
}

#[test]
fn tag_name_stops_at_the_first_character_outside_its_allowed_class() {
    // Spec §3.4: "Name is [A-Za-z0-9_]+ immediately after @" — a hyphen is
    // *not* in that class, so it must terminate the tag name rather than
    // being swallowed into it.
    let input = "Ping the @ops-team channel about the outage.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let tags = tags_in(&spans);
    assert_eq!(
        tags,
        vec!["ops"],
        "a hyphen is outside [A-Za-z0-9_]+ and must end the tag name at '@ops', leaving \
         '-team' as ordinary literal text"
    );
    let has_leftover_literal = spans
        .iter()
        .any(|s| matches!(s, Inline::Text(t) if t.starts_with("-team")));
    assert!(
        has_leftover_literal,
        "expected the '-team' remainder right after the tag to be literal text"
    );
}

#[test]
fn tags_are_not_recognized_inside_headings() {
    // Spec §3.4: "@word ... (not inside headings — Zim's own known
    // limitation, which we preserve for compatibility)".
    let input = "===== Errands @today =====\n";
    assert_roundtrip(input);
    let page = zim_format::parse(input);
    let heading_text = match &page.body.blocks[0] {
        Block::Heading(h) => h.text.clone(),
        other => panic!("expected a Heading block, got {other:?}"),
    };
    assert!(
        !heading_text.iter().any(|s| matches!(s, Inline::Tag(_))),
        "spec §3.4 explicitly excludes headings from tag recognition — '@today' inside a \
         heading must not become an Inline::Tag"
    );
    let literal_at_sign = heading_text
        .iter()
        .any(|s| matches!(s, Inline::Text(t) if t.contains("@today")));
    assert!(
        literal_at_sign,
        "'@today' should survive as literal heading text instead"
    );
}

// ---------------------------------------------------------------------------
// §3.6 Anchors
// ---------------------------------------------------------------------------

#[test]
fn anchor_definition_in_a_paragraph_round_trips_and_is_not_an_image() {
    let input = "This paragraph defines {{id: intro-section}} as a jump target for later links.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    let anchors: Vec<&str> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::Anchor(raw) => Some(raw.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(anchors, vec![" intro-section"]);

    assert!(
        !spans.iter().any(|s| matches!(s, Inline::Image(_))),
        "spec §3.6: an anchor definition is 'distinguished from an image embed by the literal \
         id: keyword right after {{{{' — it must never be classified as an Inline::Image"
    );
}

#[test]
fn anchor_definition_can_be_referenced_by_a_link_elsewhere_in_the_same_paragraph() {
    let input = "We define {{id: power-budget}} here, and later text can jump back via \
        [[#power-budget]] to reach it.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::Anchor(raw) if raw == " power-budget")));
    let links = links_in(&spans);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "#power-budget");
}

// ---------------------------------------------------------------------------
// Combined adversarial fixture: links, an autolinked URL and email, tags,
// a single-bracket non-link, and an anchor definition, all sharing one
// paragraph with ordinary punctuation between each piece.
// ---------------------------------------------------------------------------

#[test]
fn combined_links_tags_and_anchor_in_one_paragraph() {
    let input = "See [[Projects:Greenhouse|the build log]] or [[:Reference:StyleGuide]], jump to \
        [[#power-budget]], check the [[wp?SomePage]] mirror, and note [not:a:link] stays plain. \
        Reach the crew at crew@example-co.test or https://example-co.test/contact, tagged \
        @followup and @low_priority for next time. {{id: power-budget}} marks this spot for the \
        link above.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    assert_eq!(links_in(&spans).len(), 4, "expected exactly the four double-bracket links");
    assert_eq!(tags_in(&spans), vec!["followup", "low_priority"]);
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::AutoEmail(e) if e == "crew@example-co.test")));
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::AutoUrl(u) if u == "https://example-co.test/contact,")
            || matches!(s, Inline::AutoUrl(u) if u == "https://example-co.test/contact")));
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::Anchor(raw) if raw == " power-budget")));
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::Text(t) if t.contains("[not:a:link]"))));
}
