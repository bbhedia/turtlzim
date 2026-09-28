//! §3 inline element round-trip tests.

mod common;
use common::assert_roundtrip;
use zim_format::{Block, Inline};

fn paragraph_spans(text: &str) -> Vec<Inline> {
    let page = zim_format::parse(text);
    match &page.body.blocks[0] {
        Block::Paragraph(p) => p.text.clone(),
        other => panic!("expected a paragraph block, got {other:?}"),
    }
}

fn count_matching(spans: &[Inline], pred: impl Fn(&Inline) -> bool + Copy) -> usize {
    spans
        .iter()
        .map(|sp| {
            let here = pred(sp) as usize;
            let nested = match sp {
                Inline::Bold(c) | Inline::Italic(c) | Inline::Underline(c) | Inline::Strike(c) => {
                    count_matching(c, pred)
                }
                _ => 0,
            };
            here + nested
        })
        .sum()
}

#[test]
fn basic_styles_in_isolation() {
    let input = "**bold** //italic// __underline__ ~~strike~~ text.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Bold(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Italic(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Underline(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Strike(_))));
}

#[test]
fn superscript_and_subscript() {
    let input = "E = mc^{2} and H_{2}O are examples.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Superscript(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Subscript(_))));
}

#[test]
fn styles_combine_and_nest_freely() {
    let input = "**bold //italic ~~strike~~ text// end**\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let Inline::Bold(bold_content) = &spans[0] else {
        panic!("expected the whole line to start with a bold span");
    };
    assert!(bold_content.iter().any(|s| matches!(s, Inline::Italic(_))));
}

#[test]
fn unmatched_marker_falls_back_to_literal_text() {
    let input = "A stray * asterisk, a stray / slash, and an **unmatched bold marker with no closing.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(
        !spans.iter().any(|s| matches!(s, Inline::Bold(_))),
        "an unterminated '**' must not produce a Bold span"
    );
}

#[test]
fn inline_verbatim_is_the_one_exception_to_combining() {
    let input = "Plain, ''**not bold**'', plain again.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let verbatim = spans
        .iter()
        .find_map(|s| match s {
            Inline::Verbatim(t) => Some(t),
            _ => None,
        })
        .expect("expected an inline verbatim span");
    assert_eq!(verbatim, "**not bold**");
}

#[test]
fn links_all_forms_and_the_single_bracket_non_match() {
    let input = "See [[foo]], [[:foo]], [[+foo]], [[foo|bar]], [[foo#anchor]], [[#anchor]], [[wp?Test]], and [not:a:link] which is not a link.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let links: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::Link(l) => Some(l),
            _ => None,
        })
        .collect();
    assert_eq!(links.len(), 7, "expected exactly the 7 double-bracket links");
    assert_eq!(links[0].target, "foo");
    assert_eq!(links[0].display, None);
    assert_eq!(links[3].target, "foo");
    assert_eq!(links[3].display.as_deref(), Some("bar"));
    assert_eq!(links[6].target, "wp?Test");
}

#[test]
fn bare_url_email_and_mailto_autolinking() {
    let input = "Visit https://example.org/notes or email me at hello@example.org, or use mailto:hello@example.org directly.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    let urls: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoUrl(u) => Some(u.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(urls, vec!["https://example.org/notes", "mailto:hello@example.org"]);

    let emails: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::AutoEmail(e) => Some(e.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(emails, vec!["hello@example.org"]);
}

#[test]
fn tags_recognized_without_swallowing_embedded_at_signs_in_emails() {
    let input = "Remember this @todo and also @Important, plus an email like x@y.co is not a tag.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    let tags: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::Tag(name) => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tags, vec!["todo", "Important"], "original casing must be preserved");

    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::AutoEmail(e) if e == "x@y.co")));
}

#[test]
fn images_with_query_params_and_alt_text() {
    let input = "{{./diagrams/plan.png?width=400&height=%3A200|Project plan}}\n{{icons/star.png?href=SomePage}}\n{{./photo.jpg}}\n{{./x.png?type=equation}}\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let images: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            Inline::Image(im) => Some(im),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 4);

    assert_eq!(images[0].path, "./diagrams/plan.png");
    assert_eq!(
        images[0].query,
        vec![
            ("width".to_string(), Some("400".to_string())),
            ("height".to_string(), Some("%3A200".to_string())),
        ]
    );
    assert_eq!(images[0].alt.as_deref(), Some("Project plan"));

    assert_eq!(images[1].path, "icons/star.png");
    assert_eq!(images[1].query, vec![("href".to_string(), Some("SomePage".to_string()))]);
    assert_eq!(images[1].alt, None);

    assert_eq!(images[2].path, "./photo.jpg");
    assert!(images[2].query.is_empty());

    assert_eq!(images[3].query, vec![("type".to_string(), Some("equation".to_string()))]);
}

#[test]
fn anchor_definition_inside_paragraph_text() {
    let input = "See the {{id: intro-section}} anchor marker in this paragraph.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::Anchor(raw) if raw == " intro-section")));
}

#[test]
fn unused_helper_is_exercised() {
    // Keep `count_matching` covered even though most tests use direct
    // `.iter().any(...)` checks for clarity.
    let spans = paragraph_spans("**a //b// c**\n");
    assert_eq!(count_matching(&spans, |s| matches!(s, Inline::Italic(_))), 1);
}
