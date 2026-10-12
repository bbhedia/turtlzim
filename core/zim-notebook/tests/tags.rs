//! `@tags`: which are found in a page, the index a notebook keeps of them, and searching by one.

mod common;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use common::{name, Rng};
use zim_notebook::{tag_key, tags_in, Notebook};

fn notebook(pages: &[(&str, &str)]) -> Notebook {
    let mut nb = Notebook::new();
    for (n, text) in pages {
        nb.put(&name(n), *text);
    }
    nb
}

fn names(pages: Vec<zim_notebook::PageName>) -> Vec<String> {
    pages.into_iter().map(|p| p.to_string()).collect()
}

fn tag_names(text: &str) -> Vec<String> {
    tags_in(text).into_iter().map(|t| t.name).collect()
}

#[test]
fn a_tag_is_an_at_sign_and_a_word_not_in_the_middle_of_one() {
    assert_eq!(tag_names("Call @alice about @project_x."), ["alice", "project_x"]);
    let found = tags_in("Call @alice now");
    assert_eq!((found[0].start, found[0].end, found[0].name.as_str()), (5, 11, "alice"));
    // the case it was written in is kept, and each place that writes one is a tag
    assert_eq!(tag_names("@Foo and @foo and @FOO"), ["Foo", "foo", "FOO"]);
    // a word with an @ in it is not: an address, or a name with a tag-like end
    assert_eq!(tag_names("write to bob@example.org or @real"), ["real"]);
    assert_eq!(tag_names("a@b"), Vec::<String>::new());
    assert_eq!(tag_names("@ alone, and @, and @!"), Vec::<String>::new());
    // letters, digits and the underscore, in ASCII: the rest of a word is text
    assert_eq!(tag_names("@a_b9 @café @日本"), ["a_b9", "caf"]);
    let cafe = &tags_in("@café")[0];
    assert_eq!((cafe.start, cafe.end), (0, 4), "byte offsets, on a character boundary");
    // in a list, a checkbox, and bold text: where the editor draws one
    assert_eq!(tag_names("* [ ] buy milk @shop\n* and @home"), ["shop", "home"]);
    assert_eq!(tag_names("**@x** and //@y//"), ["x", "y"]);
}

#[test]
fn a_search_for_a_tag_shows_the_tag_and_not_a_longer_one_or_the_end_of_a_word() {
    let filler = "word ".repeat(80);
    // (a longer tag, then an address with the tag's name after its @, each a long way before the tag itself)
    let text = format!("@homework first. {filler} mail@home {filler} and then a real @home tag here. {filler}\n");
    let nb = notebook(&[("Page", &text)]);
    let hits = nb.search("@home", 5);
    assert_eq!(hits.len(), 1);
    assert!(hits[0].snippet.contains("a real @home tag here"), "{}", hits[0].snippet);
    assert!(!hits[0].snippet.contains("@homework") && !hits[0].snippet.contains("mail@home"), "{}", hits[0].snippet);
}

#[test]
fn a_page_that_writes_a_tag_more_often_comes_first() {
    let nb = notebook(&[("A", "@x once\n"), ("B", "@x and @x and @x\n"), ("C", "@x @x\n")]);
    let order: Vec<String> = nb.search("@x", 10).into_iter().map(|h| h.page.to_string()).collect();
    assert_eq!(order, ["B", "C", "A"]);
}

#[test]
fn a_tag_is_not_in_a_heading_a_code_block_a_table_or_an_object() {
    // (spec 3.4: Zim's own limitation, kept for compatibility)
    assert_eq!(tag_names("====== @heading ======\n\n@body"), ["body"]);
    assert_eq!(tag_names("'''\n@code\n'''\n\n@after"), ["after"]);
    assert_eq!(tag_names("inline ''@code'' and @tag"), ["tag"]);
    assert_eq!(tag_names("|@a|b|\n|c|d|\n\n@c"), ["c"]);
    assert_eq!(tag_names("{{{code: lang=\"c\"\n@x\n}}}\n\n@y"), ["y"]);
    // and not in the header block
    assert_eq!(tag_names("Content-Type: text/x-zim-wiki\nCreation-Date: @x\n\n@y"), ["y"]);
}

#[test]
fn a_notebook_keeps_an_index_of_its_tags() {
    let nb = notebook(&[
        ("Projects:Garden", "Plant @seeds and water @Urgent things.\n"),
        ("Projects:Roof", "@urgent: the roof leaks. @urgent again, and @roof.\n"),
        ("Journal", "nothing here\n"),
        ("Alpha", "@Zeta @alpha @zeta\n"),
    ]);
    let tags = nb.tags();
    let listed: Vec<(String, Vec<String>)> = tags.iter().map(|t| (t.name.clone(), names(t.pages.clone()))).collect();
    // by tag name with case ignored; spelled as the first page (in name order) that has it spells it; each page once
    assert_eq!(
        listed,
        [
            ("alpha".to_string(), vec!["Alpha".to_string()]),
            ("roof".to_string(), vec!["Projects:Roof".to_string()]),
            ("seeds".to_string(), vec!["Projects:Garden".to_string()]),
            ("Urgent".to_string(), vec!["Projects:Garden".to_string(), "Projects:Roof".to_string()]),
            ("Zeta".to_string(), vec!["Alpha".to_string()]),
        ]
    );
    // a tag is found by its name, with or without the @, in any case
    for spelling in ["urgent", "@urgent", "URGENT", "@Urgent"] {
        assert_eq!(names(nb.pages_with_tag(spelling)), ["Projects:Garden", "Projects:Roof"], "{spelling}");
    }
    assert!(nb.pages_with_tag("nothing").is_empty());
    assert!(nb.pages_with_tag("").is_empty());
    // the tags of one page: each once, in the order they first appear, as written there
    assert_eq!(nb.tags_of(&name("Alpha")), ["Zeta", "alpha"]);
    assert_eq!(nb.tags_of(&name("projects:roof")), ["urgent", "roof"]);
    assert!(nb.tags_of(&name("Journal")).is_empty());
    assert!(nb.tags_of(&name("Missing")).is_empty());
}

#[test]
fn the_index_follows_the_pages() {
    let mut nb = notebook(&[("One", "@a @b\n"), ("Two", "@b\n")]);
    assert_eq!(names(nb.pages_with_tag("b")), ["One", "Two"]);
    // a page's text replaced: its tags are what the new text says
    nb.put(&name("one"), "@c only\n");
    assert!(nb.pages_with_tag("a").is_empty());
    assert_eq!(names(nb.pages_with_tag("b")), ["Two"]);
    assert_eq!(names(nb.pages_with_tag("c")), ["One"]);
    // a page removed takes its tags with it, and a tag nobody writes is not listed
    assert!(nb.remove(&name("Two")));
    assert!(nb.tags().iter().all(|t| t.name != "b"));
    assert_eq!(nb.tags().len(), 1);
    // a page that moved keeps its tags under its new name, and a tree that is removed takes its pages'
    let mut nb = notebook(&[("Old", "@x\n"), ("Old:Child", "@y\n"), ("Keep", "@x\n")]);
    nb.rename(&name("Old"), &name("New"), true).unwrap();
    assert_eq!(names(nb.pages_with_tag("x")), ["Keep", "New"]);
    assert_eq!(names(nb.pages_with_tag("y")), ["New:Child"]);
    nb.remove_tree(&name("New"));
    assert_eq!(names(nb.pages_with_tag("x")), ["Keep"]);
    assert!(nb.pages_with_tag("y").is_empty());
}

#[test]
fn search_by_tag_finds_the_pages_that_write_it_and_only_those() {
    let nb = notebook(&[
        ("Garden", "Water the tomatoes @urgent and @home.\n"),
        ("Roof", "Fix the roof, @urgent. Not @urgently, not mail@urgent.example.\n"),
        ("Mailing", "Talk about @mailing and the urgent mail.\n"),
        ("Heading", "====== @urgent ======\nnothing\n"),
        ("Plain", "the word urgent without a tag\n"),
    ]);
    let found = |query: &str| -> Vec<String> { nb.search(query, 20).into_iter().map(|h| h.page.to_string()).collect() };
    // the tag, exactly, in any case: not a longer tag, not part of a word, not a heading (which has none)
    assert_eq!(found("@urgent"), ["Garden", "Roof"]);
    assert_eq!(found("@URGENT"), ["Garden", "Roof"]);
    assert_eq!(found("@mail"), Vec::<String>::new());
    assert_eq!(found("@mailing"), ["Mailing"]);
    // with words, every one has to match too; with tags, every one has to be written
    assert_eq!(found("@urgent tomatoes"), ["Garden"]);
    assert_eq!(found("@urgent @home"), ["Garden"]);
    assert_eq!(found("@home @mailing"), Vec::<String>::new());
    assert_eq!(found("tomatoes @nothing"), Vec::<String>::new());
    // a lone @ is an ordinary word, found wherever an @ is written (and the other pages are not)
    let mut with_at = found("@ ");
    with_at.sort();
    assert_eq!(with_at, ["Garden", "Heading", "Mailing", "Roof"]);
    // the snippet is round the tag
    let hit = &nb.search("@home", 5)[0];
    assert!(hit.snippet.contains("@home"), "{:?}", hit.snippet);
    assert!(!hit.in_name);
    // a page with the tag that also has the word in its name comes first
    let nb = notebook(&[("Zebra", "@x\n"), ("Alpha", "@x and zebra\n")]);
    assert_eq!(nb.search("@x zebra", 5).into_iter().map(|h| h.page.to_string()).collect::<Vec<_>>(), ["Zebra", "Alpha"]);
}

/// Pages made of words, tags and addresses only (no block or inline syntax), so that what each page's tags
/// are can be worked out by a plain scan, independently of the parser the notebook uses.
fn random_page(rng: &mut Rng) -> String {
    const WORDS: &[&str] = &["plan", "water", "roof", "Garden", "bob@example.org", "x@y", "tomato", "mail", "42"];
    const TAGS: &[&str] = &["@urgent", "@Urgent", "@home", "@a_b", "@Roof", "@x1", "@tomato"];
    let mut text = String::new();
    for _ in 0..rng.below(4) {
        for _ in 0..1 + rng.below(6) {
            if rng.below(3) == 0 {
                text.push_str(TAGS[rng.below(TAGS.len())]);
            } else {
                text.push_str(WORDS[rng.below(WORDS.len())]);
            }
            text.push(if rng.below(5) == 0 { ',' } else { ' ' });
        }
        text.push('\n');
    }
    text
}

/// The tags of a page by the rule written out: an `@`, then letters, digits and underscores, not after one.
fn model_tags(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !word(chars[i - 1])) {
            let mut j = i + 1;
            while j < chars.len() && word(chars[j]) {
                j += 1;
            }
            if j > i + 1 {
                found.push(chars[i + 1..j].iter().collect::<String>());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    found
}

#[test]
fn the_index_agrees_with_a_plain_scan_through_any_run_of_changes() {
    let mut rng = Rng(0x7a95_11e5_cafe_f00d);
    let page_names = ["A", "B", "C:D", "C:E", "F", "G:H:I"];
    for round in 0..40 {
        let mut nb = Notebook::new();
        let mut model: BTreeMap<String, String> = BTreeMap::new();
        for _ in 0..60 {
            let page = page_names[rng.below(page_names.len())];
            if rng.below(4) == 0 {
                nb.remove(&name(page));
                model.remove(page);
            } else {
                let text = random_page(&mut rng);
                nb.put(&name(page), text.clone());
                model.insert(page.to_string(), text);
            }
            // what the plain scan says, tag by tag
            let mut expected: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for (page, text) in &model {
                for tag in model_tags(text) {
                    expected.entry(tag_key(&tag)).or_default().insert(page.clone());
                }
            }
            let got: BTreeMap<String, BTreeSet<String>> = nb.tags().into_iter().map(|t| (tag_key(&t.name), names(t.pages).into_iter().collect())).collect();
            assert_eq!(got, expected, "round {round}");
            for (tag, pages) in &expected {
                let listed: BTreeSet<String> = names(nb.pages_with_tag(tag)).into_iter().collect();
                assert_eq!(&listed, pages, "round {round}, pages with {tag}");
                // and a search for the tag finds those pages, no others
                let searched: BTreeSet<String> = nb.search(&format!("@{tag}"), 100).into_iter().map(|h| h.page.to_string()).collect();
                assert_eq!(&searched, pages, "round {round}, search for @{tag}");
            }
            for (page, text) in &model {
                let mut seen = BTreeSet::new();
                let distinct: Vec<String> = model_tags(text).into_iter().filter(|t| seen.insert(tag_key(t))).collect();
                assert_eq!(nb.tags_of(&name(page)), distinct, "round {round}, tags of {page}");
            }
        }
    }
}

/// The notebook of one page that writes `n` different tags (and each of the first few again, spelled in another case).
fn page_of_many_tags(n: usize) -> Notebook {
    let mut text: String = (0..n).map(|i| format!("@t{i} ")).collect();
    text.push_str("@T0 @T1 @T2\n");
    notebook(&[("Many", &text)])
}

#[test]
fn a_page_with_very_many_different_tags_is_indexed_in_time_that_grows_with_their_number() {
    // `tags()` once looked each tag of a page up in the page's whole list of them: the time grew with the
    // square of their number (six seconds for twenty thousand). A page that is a long list of tags is not rare
    // enough to freeze the sidebar, so what matters is how the time grows: eight times the tags may take about
    // eight times as long, and the square would be sixty-four times.
    fn best_of_three(nb: &Notebook, n: usize) -> Duration {
        (0..3)
            .map(|_| {
                let started = Instant::now();
                let tags = nb.tags();
                let took = started.elapsed();
                assert_eq!(tags.len(), n);
                assert_eq!(tags[0].name, "t0", "the first spelling the page writes, not the later `@T0`");
                assert_eq!(names(tags[0].pages.clone()), ["Many"]);
                took
            })
            .min()
            .unwrap()
    }
    let few = best_of_three(&page_of_many_tags(1_000), 1_000);
    let many = best_of_three(&page_of_many_tags(8_000), 8_000);
    assert!(many < few * 24 + Duration::from_millis(20), "1 000 tags took {few:?}, 8 000 took {many:?}");
    // and the other questions about such a page are as quick
    let nb = page_of_many_tags(8_000);
    let started = Instant::now();
    assert_eq!(nb.tags_of(&name("Many")).len(), 8_000);
    assert_eq!(names(nb.pages_with_tag("T7999")), ["Many"]);
    assert_eq!(nb.search("@t7999", 10).len(), 1);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}
