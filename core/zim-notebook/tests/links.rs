//! Links: classification, resolution (Zim's rules), `link_to`, heading ids, and finding links in text.

mod common;
use common::{name, Pages, Rng};
use zim_notebook::{
    anchors_in, classify, heading_id, link_to, links_in, resolve, Link, LinkKind, PageName,
};

fn page(link: &Link) -> (&str, bool) {
    match link {
        Link::Page { page, exists, .. } => (page.as_str(), *exists),
        other => panic!("expected a page link, got {other:?}"),
    }
}

#[test]
fn every_kind_of_target_is_recognized() {
    use LinkKind::*;
    for (target, kind) in [
        ("https://zim-wiki.org", Url),
        ("http://example.org/a?b=c#d", Url),
        ("ftp://host/file", Url),
        ("smb://host/share/path", Url),
        ("file:///home/me/notes.txt", File),
        ("FILE://host/share", File),
        ("mailto:me@example.org", Email),
        ("me@example.org", Email),
        ("./pictures/a.png", File),
        ("../up/b.png", File),
        ("~/notes/c.txt", File),
        ("/etc/hosts", File),
        ("C:\\Users\\me\\x.txt", File),
        ("\\\\host\\share\\x", File),
        ("#a-heading", Anchor),
        ("wp?wiki", Interwiki),
        ("Foo", Page),
        ("Foo Bar", Page),
        ("Foo:Bar", Page),
        (":Foo:Bar", Page),
        ("+Child", Page),
        ("Foo#heading", Page),
        ("10:20PM", Page),
        ("Help:Links", Page), // a colon alone is not an address: it needs "//"
        (":mailto:x", Page),
        ("", Invalid),
        ("   ", Invalid),
    ] {
        assert_eq!(classify(target), kind, "{target:?}");
    }
}

#[test]
fn the_manuals_own_example_of_relative_links() {
    // "You have a page Zim:Examples:Linking:Relative; now you just use Absolute to link to
    // Zim:Examples:Linking:Absolute, but you also use Examples:Calendar to link to Zim:Examples:Calendar."
    let pages = Pages::new(&[
        "Zim:Examples:Linking:Relative",
        "Zim:Examples:Linking:Absolute",
        "Zim:Examples:Calendar",
    ]);
    let from = name("Zim:Examples:Linking:Relative");
    assert_eq!(
        page(&resolve(&from, "Absolute", &pages)),
        ("Zim:Examples:Linking:Absolute", true)
    );
    assert_eq!(
        page(&resolve(&from, "Examples:Calendar", &pages)),
        ("Zim:Examples:Calendar", true)
    );
    // An absolute link starts from the top, and a "+" link goes below the page itself.
    assert_eq!(
        page(&resolve(&from, ":Zim:Examples:Calendar", &pages)),
        ("Zim:Examples:Calendar", true)
    );
    let examples = name("Zim:Examples");
    assert_eq!(
        page(&resolve(&examples, "+Linking:Relative", &pages)),
        ("Zim:Examples:Linking:Relative", true)
    );
    assert_eq!(
        page(&resolve(&examples, "+Brand New", &pages)),
        ("Zim:Examples:Brand New", false)
    );
}

#[test]
fn a_plain_link_is_looked_up_beside_the_page_then_beside_each_parent() {
    let pages = Pages::new(&["A:B:C", "A:B:Foo", "A:Foo", "A:X", "Foo", "Y"]);
    // nearest first
    assert_eq!(
        page(&resolve(&name("A:B:C"), "Foo", &pages)),
        ("A:B:Foo", true)
    );
    assert_eq!(page(&resolve(&name("A:X"), "Foo", &pages)), ("A:Foo", true));
    assert_eq!(page(&resolve(&name("Y"), "Foo", &pages)), ("Foo", true));
    // higher up when it isn't beside the page
    assert_eq!(page(&resolve(&name("A:B:C"), "X", &pages)), ("A:X", true));
    assert_eq!(page(&resolve(&name("A:B:C"), "Y", &pages)), ("Y", true));
    // a section the page is in is a page too, even with no text of its own
    assert_eq!(page(&resolve(&name("A:B:C"), "B", &pages)), ("A:B", true));
    assert_eq!(page(&resolve(&name("A:B:C"), "A", &pages)), ("A", true));
    // the page itself is "beside" itself
    assert_eq!(page(&resolve(&name("A:B:C"), "C", &pages)), ("A:B:C", true));
}

#[test]
fn a_page_that_is_not_found_is_the_one_that_would_be_created_beside_the_link() {
    let pages = Pages::new(&["A:B:C", "Z"]);
    assert_eq!(
        page(&resolve(&name("A:B:C"), "Nowhere", &pages)),
        ("A:B:Nowhere", false)
    );
    assert_eq!(
        page(&resolve(&name("A:B:C"), "Nowhere:Deeper", &pages)),
        ("A:B:Nowhere:Deeper", false)
    );
    // at the top of the notebook there is no section to put it in
    assert_eq!(
        page(&resolve(&name("Z"), "Nowhere", &pages)),
        ("Nowhere", false)
    );
    // children aren't searched for without a "+": the page below this one is not found
    let nested = Pages::new(&["Foo:Bar", "Foo"]);
    assert_eq!(page(&resolve(&name("Foo"), "Bar", &nested)), ("Bar", false));
    assert_eq!(
        page(&resolve(&name("Foo"), "+Bar", &nested)),
        ("Foo:Bar", true)
    );
}

#[test]
fn only_the_first_part_is_searched_for_above_the_page() {
    let pages = Pages::new(&["Zim:Examples", "Zim:Examples:Linking:Relative"]);
    let from = name("Zim:Examples:Linking:Relative");
    // "Examples" is found in the section above, and "Nope" follows it, existing or not
    assert_eq!(
        page(&resolve(&from, "Examples:Nope", &pages)),
        ("Zim:Examples:Nope", false)
    );
}

#[test]
fn matching_ignores_case_and_returns_the_notebooks_spelling() {
    let pages = Pages::new(&["Help:Links", "Plugins:Foo"]);
    assert_eq!(
        page(&resolve(&name("Other"), "help:links", &pages)),
        ("Help:Links", true)
    );
    assert_eq!(
        page(&resolve(&name("Other"), ":HELP:LINKS", &pages)),
        ("Help:Links", true)
    );
    assert_eq!(
        page(&resolve(&name("Other"), ":PLUGINS:New Page", &pages)),
        ("Plugins:New Page", false),
        "the part that exists is spelled as the notebook spells it"
    );
    assert_eq!(
        page(&resolve(&name("Plugins:Foo"), "foo", &pages)),
        ("Plugins:Foo", true)
    );
}

#[test]
fn links_to_sections_with_no_text_of_their_own_lead_somewhere() {
    let pages = Pages::new(&["Plugins:Foo"]);
    assert_eq!(
        page(&resolve(&name("Other"), "Plugins", &pages)),
        ("Plugins", true)
    );
    assert_eq!(
        page(&resolve(&name("Other"), "Plugins:", &pages)),
        ("Plugins", true),
        "a section written with a trailing colon"
    );
}

#[test]
fn an_underscore_in_a_link_is_a_space() {
    let pages = Pages::new(&["Help:Auto Formatting"]);
    assert_eq!(
        page(&resolve(&name("Help:Links"), "Auto_Formatting", &pages)),
        ("Help:Auto Formatting", true)
    );
}

#[test]
fn a_place_in_a_page() {
    let pages = Pages::new(&["Help:Links", "Other"]);
    let from = name("Other");
    match resolve(&from, "Help:Links#link-to-a-heading", &pages) {
        Link::Page {
            page,
            exists,
            anchor,
        } => assert_eq!(
            (page.as_str(), exists, anchor.as_deref()),
            ("Help:Links", true, Some("link-to-a-heading"))
        ),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        resolve(&from, "#here", &pages),
        Link::Anchor("here".to_string())
    );
    match resolve(&from, "Help:Links#", &pages) {
        Link::Page { anchor, .. } => assert_eq!(anchor, None, "an empty anchor is no anchor"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_other_kinds_of_target_resolve_to_themselves() {
    let pages = Pages::new(&["Other"]);
    let from = name("Other");
    assert_eq!(
        resolve(&from, "https://example.org/x", &pages),
        Link::Url("https://example.org/x".into())
    );
    assert_eq!(
        resolve(&from, "./pics/a.png", &pages),
        Link::File("./pics/a.png".into())
    );
    assert_eq!(
        resolve(&from, "me@example.org", &pages),
        Link::Email("mailto:me@example.org".into())
    );
    assert_eq!(
        resolve(&from, "mailto:me@example.org", &pages),
        Link::Email("mailto:me@example.org".into())
    );
    assert_eq!(
        resolve(&from, "wp?Zim (software)", &pages),
        Link::Interwiki {
            key: "wp".into(),
            page: "Zim (software)".into()
        }
    );
    assert_eq!(
        resolve(&from, "  https://example.org  ", &pages),
        Link::Url("https://example.org".into()),
        "the target is trimmed"
    );
}

#[test]
fn links_that_cannot_be_followed_say_why() {
    let pages = Pages::new(&["Other"]);
    let from = name("Other");
    for bad in [
        "", "   ", ":", "+", "Foo::Bar", "Foo*Bar", ":.hidden", "+..", "?page",
    ] {
        match resolve(&from, bad, &pages) {
            Link::Invalid(reason) => assert!(!reason.is_empty(), "{bad:?}"),
            other => panic!("{bad:?} should be invalid, got {other:?}"),
        }
    }
}

#[test]
fn a_link_that_leads_nowhere_can_be_written_to_lead_where_you_want() {
    let pages = Pages::new(&[
        "Zim:Examples:Linking:Relative",
        "Zim:Examples:Linking:Absolute",
        "Zim:Examples:Calendar",
        "Other:Thing",
        "Top",
    ]);
    let relative = name("Zim:Examples:Linking:Relative");
    assert_eq!(
        link_to(&relative, &name("Zim:Examples:Linking:Absolute"), &pages),
        "Absolute"
    );
    assert_eq!(
        link_to(&relative, &name("Zim:Examples:Calendar"), &pages),
        "Calendar"
    );
    // "Thing" would be looked for beside the page and in each section above it, and it is in none of them
    assert_eq!(
        link_to(&relative, &name("Other:Thing"), &pages),
        "Other:Thing"
    );
    assert_eq!(link_to(&relative, &name("Top"), &pages), "Top");
    assert_eq!(
        link_to(
            &name("Zim:Examples"),
            &name("Zim:Examples:Linking:Relative"),
            &pages
        ),
        "+Linking:Relative",
        "a sub-page"
    );
    // a page that doesn't exist yet, beside the one holding the link
    assert_eq!(
        link_to(&relative, &name("Zim:Examples:Linking:New"), &pages),
        "New"
    );
}

#[test]
fn when_a_short_name_would_lead_elsewhere_a_longer_one_is_used() {
    // "X" found beside A:B:C would be A:B:X, so the top-level X needs its full name.
    let pages = Pages::new(&["A:B:C", "A:B:X", "X"]);
    assert_eq!(link_to(&name("A:B:C"), &name("X"), &pages), ":X");
    // nothing exists under Q: the shortest correct form is the whole name
    assert_eq!(link_to(&name("A:B:C"), &name("Q:R"), &pages), ":Q:R");
}

#[test]
fn link_to_always_leads_to_the_page_it_was_asked_for() {
    // Random notebooks from a small alphabet, so that names collide and shadow each other a lot.
    let mut rng = Rng(0xC0FF_EE00_1234_5678);
    let parts = ["a", "b", "c", "d"];
    let random_name = |rng: &mut Rng| {
        let depth = 1 + rng.below(4);
        PageName::parse(
            &(0..depth)
                .map(|_| parts[rng.below(parts.len())])
                .collect::<Vec<_>>()
                .join(":"),
        )
        .unwrap()
    };
    for case in 0..20_000 {
        let existing: Vec<PageName> = (0..1 + rng.below(12))
            .map(|_| random_name(&mut rng))
            .collect();
        let pages = common::Pages(existing.clone());
        let from = if rng.below(2) == 0 {
            existing[rng.below(existing.len())].clone()
        } else {
            random_name(&mut rng)
        };
        let to = if rng.below(3) == 0 {
            random_name(&mut rng)
        } else {
            existing[rng.below(existing.len())].clone()
        };
        let text = link_to(&from, &to, &pages);
        match resolve(&from, &text, &pages) {
            Link::Page { page, .. } => assert!(page.same_page(&to), "case {case}: from {from} to {to} wrote {text:?}, which leads to {page}; pages {existing:?}"),
            other => panic!("case {case}: {text:?} resolved to {other:?}"),
        }
    }
}

#[test]
fn heading_ids_follow_zims_rule() {
    // The manual's own example: this section's heading is linked as #link-to-a-heading-or-object.
    assert_eq!(
        heading_id("Link to a heading or object"),
        "link-to-a-heading-or-object"
    );
    assert_eq!(heading_id("What's new? (2026)"), "whats-new-2026");
    assert_eq!(heading_id("  Spaced   out  "), "spaced-out");
    assert_eq!(heading_id("Über uns"), "über-uns");
    assert_eq!(
        heading_id("snake_case and kebab-case"),
        "snake_case-and-kebab-case"
    );
    assert_eq!(heading_id("***"), "");
    assert_eq!(heading_id(""), "");
    assert_eq!(heading_id("日本語の見出し"), "日本語の見出し");
}

#[test]
fn links_are_found_in_text_with_their_places() {
    let text = "====== T ======\nSee [[Foo]] and [[:A:B|shown]], [[#here]], [[]] and [[|only text]].\n* item [[Last one]]\n";
    let links = links_in(text);
    let found: Vec<(&str, Option<&str>)> = links
        .iter()
        .map(|l| (l.target.as_str(), l.display.as_deref()))
        .collect();
    assert_eq!(
        found,
        [
            ("Foo", None),
            (":A:B", Some("shown")),
            ("#here", None),
            ("", None),
            ("", Some("only text")),
            ("Last one", None)
        ]
    );
    for link in &links {
        assert!(
            text[link.start..link.end].starts_with("[[")
                && text[link.start..link.end].ends_with("]]")
        );
        assert_eq!(&text[link.target_start..link.target_end], link.target);
        assert!(link.start + 2 <= link.target_start && link.target_end <= link.end - 2);
    }
}

#[test]
fn what_is_not_a_link_is_not_found() {
    let text = "''[[in verbatim]]'' and\n'''\n[[in a code block]]\n'''\nand [single] [[ok]]\n";
    let targets: Vec<String> = links_in(text).into_iter().map(|l| l.target).collect();
    assert_eq!(targets, ["ok"]);
}

#[test]
fn headings_and_anchors_are_places_to_link_to() {
    let text = "====== Link to a heading ======\ntext {{id: spot}} more\n=== Second **part** ===\n";
    let ids: Vec<String> = anchors_in(text).into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["link-to-a-heading", "spot", "second-part"]);
    let at: Vec<usize> = anchors_in(text).into_iter().map(|a| a.at).collect();
    assert_eq!(&text[at[0]..at[0] + 6], "======");
    assert_eq!(&text[at[1]..at[1] + 5], "{{id:");
}
