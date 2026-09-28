//! Adversarial verification for §3.1-§3.2 (inline formatting) of
//! `docs/zim-wiki-format-spec.md`.
//!
//! All fixtures below are original sentences composed for this review; none
//! are copied from any Zim project source. Every test asserts the spec §4
//! byte-identical round-trip; several also probe the resulting `Inline` AST
//! against what a plain reading of §3.1/§3.2 implies the grouping *should*
//! be, since a naive-substring-search implementation can round-trip a
//! misgrouped parse purely by construction (concatenation of the wrong
//! partition can still reproduce the original bytes) while still disagreeing
//! with the spec's stated semantics (e.g. "verbatim is opaque").

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

fn find_all<'a>(spans: &'a [Inline], pred: &impl Fn(&Inline) -> bool) -> Vec<&'a Inline> {
    let mut out = Vec::new();
    for sp in spans {
        if pred(sp) {
            out.push(sp);
        }
        let nested: &[Inline] = match sp {
            Inline::Bold(c)
            | Inline::Italic(c)
            | Inline::Underline(c)
            | Inline::Strike(c)
            | Inline::Superscript(c)
            | Inline::Subscript(c) => c,
            _ => &[],
        };
        out.extend(find_all(nested, pred));
    }
    out
}

// ---------------------------------------------------------------------
// 1. Each style in isolation, one per sentence.
// ---------------------------------------------------------------------

#[test]
fn bold_in_isolation() {
    let input = "The quarterly summary is **finally ready** for review.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Bold(_))));
}

#[test]
fn italic_in_isolation() {
    let input = "She whispered //very quietly// during the meeting.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Italic(_))));
}

#[test]
fn underline_in_isolation() {
    let input = "Please __read this carefully__ before signing.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Underline(_))));
}

#[test]
fn strikethrough_in_isolation() {
    let input = "The old plan is ~~scrapped entirely~~ as of today.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Strike(_))));
}

#[test]
fn inline_verbatim_in_isolation() {
    let input = "Run ''ls -la /tmp'' to see the directory listing.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let v = spans.iter().find_map(|s| match s {
        Inline::Verbatim(t) => Some(t.as_str()),
        _ => None,
    });
    assert_eq!(v, Some("ls -la /tmp"));
}

// ---------------------------------------------------------------------
// 2. All five combined (non-nested) in one sentence.
// ---------------------------------------------------------------------

#[test]
fn all_five_styles_combined_non_nested_in_one_sentence() {
    let input = "We call it **critical**, //urgent//, __mandatory__, ~~optional~~, and ''non-negotiable'' in the same breath.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Bold(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Italic(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Underline(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Strike(_))));
    assert!(spans
        .iter()
        .any(|s| matches!(s, Inline::Verbatim(t) if t == "non-negotiable")));
}

// ---------------------------------------------------------------------
// 3. Four-level nesting: bold > italic > underline > strike.
// ---------------------------------------------------------------------

#[test]
fn four_level_nesting_bold_italic_underline_strike() {
    let input = "This is **bold //and italic __and underlined ~~and struck-through~~ back to underline__ back to italic// back to bold** again.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let bold_c = spans
        .iter()
        .find_map(|s| match s {
            Inline::Bold(c) => Some(c),
            _ => None,
        })
        .expect("expected a Bold span somewhere in the line");
    let italic = bold_c
        .iter()
        .find_map(|s| match s {
            Inline::Italic(c) => Some(c),
            _ => None,
        })
        .expect("Bold should contain a nested Italic span");
    let underline = italic
        .iter()
        .find_map(|s| match s {
            Inline::Underline(c) => Some(c),
            _ => None,
        })
        .expect("Italic should contain a nested Underline span");
    assert!(
        underline.iter().any(|s| matches!(s, Inline::Strike(_))),
        "Underline should contain a nested Strike span"
    );
}

// ---------------------------------------------------------------------
// 4. Verbatim as the one exception to combining, nested cleanly inside
//    bold (no marker collision between the two).
// ---------------------------------------------------------------------

#[test]
fn verbatim_nested_inside_bold_stays_opaque_when_content_has_no_bold_marker() {
    let input = "**Keep this ''raw & unformatted'' text safe inside bold**\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let Inline::Bold(bold_c) = &spans[0] else {
        panic!("expected a single Bold span wrapping the whole line, got {spans:?}");
    };
    let verbatim = bold_c.iter().find_map(|s| match s {
        Inline::Verbatim(t) => Some(t.as_str()),
        _ => None,
    });
    assert_eq!(
        verbatim,
        Some("raw & unformatted"),
        "expected the ''...'' span to survive as an opaque Verbatim nested in Bold"
    );
}

// ---------------------------------------------------------------------
// 5. Superscript / subscript adjacent to normal text, and to each other,
//    with no separating space (original constructs, spec §3).
// ---------------------------------------------------------------------

#[test]
fn superscript_adjacent_to_normal_text() {
    let input = "Kinetic energy scales with v^{2} in the classic formula.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Superscript(_))));
}

#[test]
fn subscript_adjacent_to_normal_text() {
    let input = "The reaction produces CO_{2} as a byproduct.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Subscript(_))));
}

#[test]
fn superscript_immediately_followed_by_subscript_no_separator() {
    // "a^{2}_{i}" — superscript then subscript, back to back, no space
    // between the closing '}' of one and the opening marker of the next.
    let input = "The term a^{2}_{i} denotes the squared i-th component.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Superscript(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Subscript(_))));
}

#[test]
fn superscript_nesting_bold_inside_it() {
    let input = "The bound **v^{2}** must never exceed the baseline v_{0}.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    let sup = find_all(&spans, &|s| matches!(s, Inline::Superscript(_)));
    assert_eq!(sup.len(), 1, "expected exactly one Superscript span, nested inside Bold");
}

// ---------------------------------------------------------------------
// 6. Single stray '*' / '/' (and other stray symbols) are not markup.
// ---------------------------------------------------------------------

#[test]
fn single_stray_star_and_slash_are_not_markup() {
    let input = "A * lone star and a / lone slash mean nothing here, but **this** and //this// still work.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    // The literal stray '*' and '/' must appear as plain text, not as any
    // recognized inline node.
    let has_literal_star = spans.iter().any(|s| matches!(s, Inline::Text(t) if t.contains('*')) );
    assert!(has_literal_star, "the stray '*' should survive as literal text");
    assert!(spans.iter().any(|s| matches!(s, Inline::Bold(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Italic(_))));
}

#[test]
fn other_stray_symbols_are_not_markup() {
    let input = "Random marks like * # @ <> and \"\" show up here but only doubled markers format anything.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    // None of '#', a bare '@' (not followed by a word char), '<>' or '\"\"'
    // should have produced a Tag, Link, Image or Anchor node.
    assert!(!spans.iter().any(|s| matches!(s, Inline::Tag(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Link(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Image(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Anchor(_))));
}

// ---------------------------------------------------------------------
// 7. Unmatched / unclosed markers fall back to literal text, not a panic.
// ---------------------------------------------------------------------

#[test]
fn unmatched_unclosed_double_star_falls_back_to_literal() {
    let input = "The report has an **unclosed bold marker right here and nothing ever closes it.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(
        !spans.iter().any(|s| matches!(s, Inline::Bold(_))),
        "an unterminated '**' must not produce a Bold span"
    );
}

#[test]
fn unmatched_unclosed_markers_of_every_paired_kind_fall_back_to_literal() {
    // One paragraph, five independent unclosed markers (bold, italic,
    // underline, strike, inline-verbatim), each on its own line so a
    // premature match in one can't accidentally borrow a delimiter from
    // another. None of these should panic or produce a paired span.
    let input = "Unclosed bold: **oops\n\
Unclosed italic: //oops\n\
Unclosed underline: __oops\n\
Unclosed strike: ~~oops\n\
Unclosed verbatim: ''oops\n";
    assert_roundtrip(input);
    let page = zim_format::parse(input);
    let Block::Paragraph(p) = &page.body.blocks[0] else {
        panic!("expected a single paragraph block, got {:?}", page.body.blocks[0]);
    };
    let spans = &p.text;
    assert!(!spans.iter().any(|s| matches!(s, Inline::Bold(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Italic(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Underline(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Strike(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Verbatim(_))));
}

#[test]
fn unclosed_superscript_and_subscript_fall_back_to_literal() {
    let input = "Here x^{2 has no closing brace and y_{i also lacks one, yet nothing crashes.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(!spans.iter().any(|s| matches!(s, Inline::Superscript(_))));
    assert!(!spans.iter().any(|s| matches!(s, Inline::Subscript(_))));
}

// ---------------------------------------------------------------------
// 8. Byte-safety: multi-byte UTF-8 content directly touching markers.
// ---------------------------------------------------------------------

#[test]
fn multibyte_utf8_directly_touching_markers_does_not_panic() {
    let input = "Le café **crème brûlée** coûte 5€ et l'emoji 🚀**décolle**maintenant.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().filter(|s| matches!(s, Inline::Bold(_))).count() >= 2);
}

// ---------------------------------------------------------------------
// 9. Markers with no surrounding whitespace at all (adjacent to
//    punctuation), since spec places no whitespace requirement on them
//    (unlike headings, which require exactly one space).
// ---------------------------------------------------------------------

#[test]
fn markers_with_no_surrounding_whitespace() {
    let input = "Call(**important**);then(//details//),done.\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);
    assert!(spans.iter().any(|s| matches!(s, Inline::Bold(_))));
    assert!(spans.iter().any(|s| matches!(s, Inline::Italic(_))));
}

// ---------------------------------------------------------------------
// 10. ADVERSARIAL: a '**' sequence hiding inside inline-verbatim content
//     that is itself nested inside a bold span. Per spec §3.2, verbatim
//     is "opaque... nothing else is parsed until the closing ''" — so the
//     '**' inside the verbatim content must never be mistaken for the
//     bold's own closing delimiter, and the verbatim span must survive.
// ---------------------------------------------------------------------

#[test]
fn adversarial_bold_closing_marker_must_not_be_stolen_from_inside_nested_verbatim() {
    let input = "**Keep ''a ** b'' safe**\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    // Expectation per spec: a single Bold span spanning the whole line,
    // containing a Verbatim span whose content is exactly "a ** b".
    let Inline::Bold(bold_c) = &spans[0] else {
        panic!(
            "expected the whole line to parse as one Bold span; got: {spans:#?}"
        );
    };
    let verbatim = bold_c.iter().find_map(|s| match s {
        Inline::Verbatim(t) => Some(t.as_str()),
        _ => None,
    });
    assert_eq!(
        verbatim,
        Some("a ** b"),
        "the inline-verbatim span containing '**' should be recognized as opaque \
         and its content preserved verbatim, nested inside a single Bold span; \
         actual parse was: {spans:#?}",
    );
}

// ---------------------------------------------------------------------
// 11. ADVERSARIAL: italic markers wrapped around a bare URL whose own
//     "//" (from its scheme) sits between them. Spec §3.3 says bare URLs
//     are auto-linked "wherever they appear in text"; check whether an
//     enclosing pair of italic markers can "steal" the URL's internal
//     "//" as its closing delimiter, splitting the URL apart instead of
//     recognizing it as one AutoUrl span.
// ---------------------------------------------------------------------

#[test]
fn adversarial_italic_markers_around_a_bare_url_should_not_split_the_url() {
    let input = "//see https://example.org//\n";
    assert_roundtrip(input);
    let spans = paragraph_spans(input);

    // Expectation per spec §3.3: the scheme "https://" should be recognized
    // as one whole AutoUrl span, wherever it appears in the text -- here,
    // nested inside the Italic span the surrounding "//...//" legitimately
    // forms (exactly as `verbatim_nested_inside_bold_stays_opaque_when_...`
    // above expects Verbatim to survive *nested inside* Bold, not hoisted
    // out to the top level). Use the file's own `find_all` helper, which
    // already recurses into Bold/Italic/Underline/Strike/Superscript/
    // Subscript, rather than checking only the top-level span list.
    let urls: Vec<&str> = find_all(&spans, &|s| matches!(s, Inline::AutoUrl(_)))
        .into_iter()
        .map(|s| match s {
            Inline::AutoUrl(u) => u.as_str(),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(
        urls,
        vec!["https://example.org"],
        "the full scheme URL should be recognized as a single AutoUrl span (however deeply \
         nested inside the surrounding italic markup) rather than split apart; \
         actual parse was: {spans:#?}",
    );
}
