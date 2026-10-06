//! A notebook: its pages, tree, backlinks, search, and renames that keep links intact.

mod common;
use std::collections::{BTreeMap, BTreeSet};

use common::{name, Rng};
use zim_notebook::{links_in, new_page_text, Link, Notebook, PageName, PageSet, RenameError};

fn notebook(pages: &[(&str, &str)]) -> Notebook {
    let mut nb = Notebook::new();
    for (n, text) in pages {
        nb.put(&name(n), *text);
    }
    nb
}

fn names(nb: &Notebook) -> Vec<String> {
    nb.names().map(|n| n.to_string()).collect()
}

#[test]
fn pages_are_put_got_and_removed_without_regard_to_case() {
    let mut nb = Notebook::new();
    assert!(nb.is_empty());
    nb.put(&name("Help:Links"), "first");
    assert_eq!(nb.get(&name("help:links")), Some("first"));
    nb.put(&name("HELP:LINKS"), "second"); // the same page: the text is replaced, the spelling kept
    assert_eq!((nb.len(), nb.get(&name("Help:Links"))), (1, Some("second")));
    assert_eq!(
        nb.page_name(&name("help:LINKS")).unwrap().as_str(),
        "Help:Links"
    );
    assert!(nb.has_page(&name("help:links")));
    assert!(
        !nb.has_page(&name("Help")),
        "a section isn't a page until it has text"
    );
    assert!(nb.remove(&name("help:links")));
    assert!(!nb.remove(&name("help:links")));
    assert!(nb.is_empty());
}

#[test]
fn a_section_exists_while_pages_lie_below_it() {
    let nb = notebook(&[("Plugins:Journal", ""), ("Plugins:Tags", "")]);
    assert_eq!(nb.find(&name("plugins")).unwrap().as_str(), "Plugins");
    assert_eq!(
        nb.find(&name("PLUGINS:journal")).unwrap().as_str(),
        "Plugins:Journal"
    );
    assert!(nb.find(&name("Plugins:Nope")).is_none());
    assert!(
        nb.find(&name("Plug")).is_none(),
        "a longer first level is another section"
    );
}

#[test]
fn the_tree_lists_sections_and_pages_in_order() {
    let nb = notebook(&[
        ("Start", ""),
        ("help:Links", ""),
        ("Help", ""),
        ("Help:Auto Formatting", ""),
        ("Plugins:Table Editor:Basic", ""),
        ("Plugins:journal", ""),
        ("About", ""),
    ]);
    let tree: Vec<(String, usize, bool, usize)> = nb
        .tree()
        .into_iter()
        .map(|n| (n.name.to_string(), n.depth, n.has_page, n.children))
        .collect();
    let expected: Vec<(&str, usize, bool, usize)> = vec![
        ("About", 0, true, 0),
        ("Help", 0, true, 2),
        ("Help:Auto Formatting", 1, true, 0),
        ("help:Links", 1, true, 0), // spelled as its page spells it
        ("Plugins", 0, false, 2),   // a section with no text of its own
        ("Plugins:journal", 1, true, 0),
        ("Plugins:Table Editor", 1, false, 1),
        ("Plugins:Table Editor:Basic", 2, true, 0),
        ("Start", 0, true, 0),
    ];
    assert_eq!(
        tree,
        expected
            .into_iter()
            .map(|(n, d, p, c)| (n.to_string(), d, p, c))
            .collect::<Vec<_>>()
    );
}

#[test]
fn the_tree_of_an_empty_notebook_is_empty() {
    assert!(Notebook::new().tree().is_empty());
}

#[test]
fn backlinks_are_the_pages_whose_links_resolve_to_the_page() {
    let nb = notebook(&[
        (
            "Projects:Garden",
            "====== Garden ======\nSee [[Plan]] and [[+Plan|the plan]] and [[Other]]\n",
        ),
        (
            "Projects:Garden:Plan",
            "Back to [[:Projects:Garden]]; itself: [[Plan]] [[#x]]\n",
        ),
        (
            "Projects:Tools",
            "uses [[Garden:Plan]] and [[garden:plan]]\nand again [[:Projects:Garden:Plan#sec]]\n",
        ),
        ("Other", "no links here"),
        (
            "Journal:Today",
            "[[Projects]] is a section; [[Nowhere]] isn't there\n",
        ),
    ]);
    let plan = nb.backlinks(&name("Projects:Garden:Plan"));
    let summary: Vec<(String, usize)> =
        plan.iter().map(|b| (b.from.to_string(), b.count)).collect();
    // Garden links to the plan twice ("Plan" resolves beside Garden to Projects:Plan: not found,
    // so only "+Plan" counts); Tools links three ways; the plan's own links to itself don't count.
    assert_eq!(
        summary,
        [
            ("Projects:Garden".to_string(), 1),
            ("Projects:Tools".to_string(), 3)
        ]
    );
    assert_eq!(
        plan[0].context,
        // shown as plain text: without its markup
        "See Plan and the plan and Other"
    );
    let garden: Vec<String> = nb
        .backlinks(&name("Projects:Garden"))
        .into_iter()
        .map(|b| b.from.to_string())
        .collect();
    assert_eq!(garden, ["Projects:Garden:Plan"]);
    let section: Vec<String> = nb
        .backlinks(&name("Projects"))
        .into_iter()
        .map(|b| b.from.to_string())
        .collect();
    assert_eq!(section, ["Journal:Today"], "links to a section count too");
    assert!(nb.backlinks(&name("Journal:Today")).is_empty());
}

#[test]
fn backlinks_agree_with_a_brute_force_count_on_random_notebooks() {
    let mut rng = Rng(0xBAC0_11AB_5EED_0001);
    for case in 0..300 {
        let pages = 3 + rng.below(10);
        let nb = random_notebook(&mut rng, pages);
        for target in nb.names().cloned().collect::<Vec<_>>() {
            let mut expected: BTreeMap<String, usize> = BTreeMap::new();
            for page in nb.names() {
                if page.same_page(&target) {
                    continue;
                }
                for link in links_in(nb.get(page).unwrap()) {
                    if matches!(nb.resolve(page, &link.target), Link::Page { page: p, .. } if p.same_page(&target))
                    {
                        *expected.entry(page.to_string()).or_default() += 1;
                    }
                }
            }
            let got: BTreeMap<String, usize> = nb
                .backlinks(&target)
                .into_iter()
                .map(|b| (b.from.to_string(), b.count))
                .collect();
            assert_eq!(got, expected, "case {case}, backlinks of {target}");
        }
    }
}

#[test]
fn search_finds_pages_with_every_word_and_puts_name_matches_first() {
    let nb = notebook(&[
        (
            "Garden",
            "Plant tomatoes in spring.\nWater the tomatoes daily.",
        ),
        ("Tomatoes", "A fruit."),
        (
            "Recipes:Soup",
            "Boil tomatoes with basil. A Fruit salad is not soup.",
        ),
        ("Other", "nothing to see"),
    ]);
    let hits = nb.search("tomatoes", 10);
    let order: Vec<(String, bool)> = hits
        .iter()
        .map(|h| (h.page.to_string(), h.in_name))
        .collect();
    assert_eq!(
        order,
        [
            ("Tomatoes".into(), true),
            ("Garden".into(), false),
            ("Recipes:Soup".into(), false)
        ]
    );
    assert!(
        hits[1].snippet.contains("Plant tomatoes in spring"),
        "{:?}",
        hits[1].snippet
    );
    // every word has to match, in the name or the text, in any order and any case
    let both: Vec<String> = nb
        .search("FRUIT tomatoes", 10)
        .into_iter()
        .map(|h| h.page.to_string())
        .collect();
    assert_eq!(both, ["Tomatoes", "Recipes:Soup"]);
    assert!(nb.search("tomatoes zebra", 10).is_empty());
    assert!(nb.search("   ", 10).is_empty());
    assert_eq!(nb.search("tomatoes", 2).len(), 2, "the limit");
}

#[test]
fn search_reads_what_a_person_reads_not_the_markup_or_the_header() {
    let nb = notebook(&[
        ("Garden", "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00\n\n====== Garden ======\nPlant **tomatoes** in //spring//, see [[Plan|the plan]].\n"),
        ("Plan", "no match here\n"),
    ]);
    // header lines are page properties, not text: no page matches them
    assert!(nb.search("Creation-Date", 10).is_empty());
    assert!(nb.search("zim-wiki", 10).is_empty());
    // markup characters aren't text either, and a link's target is not shown when it has display text
    assert!(nb.search("**", 10).is_empty());
    assert!(nb.search("[[plan", 10).is_empty());
    // what is shown is found, and shown as prose
    let hit = &nb.search("tomatoes spring", 10)[0];
    assert_eq!(hit.page.as_str(), "Garden");
    assert_eq!(hit.snippet, "Garden Plant tomatoes in spring, see the plan.");
    // the page *name* is still searchable
    assert_eq!(nb.search("garden", 10)[0].page.as_str(), "Garden");
}

#[test]
fn search_snippets_are_cut_on_character_boundaries() {
    let long = format!("{}ÉCOLE élève {}", "日本語".repeat(40), "ü".repeat(200));
    let nb = notebook(&[("Page", long.as_str())]);
    let hit = &nb.search("école", 5)[0];
    assert!(hit.snippet.contains("ÉCOLE"), "{}", hit.snippet);
    assert!(hit.snippet.starts_with('…') && hit.snippet.ends_with('…'));
    assert!(hit.snippet.chars().count() < 200);
    // a letter whose lower case is longer than itself ("İ" is two characters in lower case)
    let nb = notebook(&[(
        "Turkish",
        "İİİİİİİİİİ and then the word needle appears here",
    )]);
    assert!(nb.search("needle", 5)[0].snippet.contains("needle"));
}

#[test]
fn a_snippet_near_either_end_of_the_text_reaches_it() {
    // 62 characters before the match: the window would skip only two, so it starts at the start;
    // 12 characters would be left after it ("needle " and 105 more fill the 100 it shows)
    let before = "x".repeat(62);
    let after = "y".repeat(105);
    let nb = notebook(&[("P", format!("{before} needle {after}").as_str())]);
    let snippet = nb.search("needle", 1)[0].snippet.clone();
    assert!(snippet.starts_with("xxxx") && snippet.ends_with("yyyy"), "{snippet}");
    // far from the ends it is cut, with an ellipsis on each cut side
    let before = "x".repeat(300);
    let after = "y".repeat(300);
    let nb = notebook(&[("P", format!("{before} needle {after}").as_str())]);
    let snippet = nb.search("needle", 1)[0].snippet.clone();
    assert!(snippet.starts_with('…') && snippet.ends_with('…') && snippet.contains("needle"), "{snippet}");
}

#[test]
fn new_pages_start_the_way_zim_starts_them() {
    let text = new_page_text(&name("Projects:Garden:Plan"), "2026-10-06T09:41:03+02:00");
    assert_eq!(
        text,
        "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:41:03+02:00\n\n====== Plan ======\n"
    );
    // and what it describes is a page with a header and a level-1 heading
    let page = zim_format::parse(&text);
    assert_eq!(page.serialize(), text);
    assert_eq!(page.headers.unwrap().len(), 3);
    assert!(
        !new_page_text(&name("X"), "2026\n-10").contains("\n-10"),
        "a time can't smuggle in a line break"
    );
}

// ----------------------------------------------------------------------------------------------
// renames

fn texts(nb: &Notebook) -> BTreeMap<String, String> {
    nb.names()
        .map(|n| (n.to_string(), nb.get(n).unwrap().to_string()))
        .collect()
}

#[test]
fn renaming_a_page_rewrites_the_links_to_it_and_nothing_else() {
    let mut nb = notebook(&[
        ("Foo", "I am Foo.\n"),
        ("Bar", "a [[Foo]], a [[Foo|labelled]], an [[:Foo]], a [[Foo#part]], an [[https://example.org/Foo]], and [[Baz]]\n"),
    ]);
    let report = nb.rename(&name("Foo"), &name("Qux"), true).unwrap();
    assert_eq!(nb.get(&name("Qux")), Some("I am Foo.\n"));
    assert!(!nb.has_page(&name("Foo")));
    assert_eq!(
        nb.get(&name("Bar")).unwrap(),
        "a [[Qux]], a [[Qux|labelled]], an [[:Qux]], a [[Qux#part]], an [[https://example.org/Foo]], and [[Baz]]\n"
    );
    assert_eq!((report.links_changed, report.rewritten.len()), (4, 1));
    assert_eq!(report.moved, [(name("Foo"), name("Qux"))]);
}

#[test]
fn without_update_links_only_the_page_moves() {
    let mut nb = notebook(&[("Foo", "x"), ("Bar", "[[Foo]]")]);
    nb.rename(&name("Foo"), &name("Qux"), false).unwrap();
    assert_eq!(nb.get(&name("Bar")), Some("[[Foo]]"));
    assert!(nb.has_page(&name("Qux")));
}

#[test]
fn a_page_moves_with_everything_below_it() {
    let mut nb = notebook(&[
        ("Help", "top"),
        ("Help:Links", "see [[+Sub]] and [[Pages]] and [[Help]]"),
        ("Help:Links:Sub", "sub"),
        ("Help:Pages", "pages"),
        (
            "Start",
            "go to [[Help:Links]] or [[:Help:Pages]] or [[+Nope]]",
        ),
    ]);
    let report = nb
        .rename(&name("Help"), &name("Docs:Manual"), true)
        .unwrap();
    assert_eq!(
        names(&nb),
        [
            "Docs:Manual",
            "Docs:Manual:Links",
            "Docs:Manual:Links:Sub",
            "Docs:Manual:Pages",
            "Start"
        ]
    );
    assert_eq!(report.moved.len(), 4);
    // links inside the moved pages still point at the same pages, by the shortest form that works
    assert_eq!(
        nb.get(&name("Docs:Manual:Links")).unwrap(),
        "see [[+Sub]] and [[Pages]] and [[Manual]]"
    );
    assert_eq!(
        nb.get(&name("Start")).unwrap(),
        "go to [[Docs:Manual:Links]] or [[:Docs:Manual:Pages]] or [[+Nope]]"
    );
}

#[test]
fn a_relative_link_that_would_change_meaning_on_moving_is_made_to_keep_it() {
    // "Sibling" leads to Zim:Sibling from Zim:Page. Moved to Elsewhere:Page it would be looked up
    // beside the page and found nowhere, so the link has to name where it really goes.
    let mut nb = notebook(&[
        ("Zim:Page", "[[Sibling]] and [[Zim:Sibling]]"),
        ("Zim:Sibling", "s"),
    ]);
    nb.rename(&name("Zim:Page"), &name("Elsewhere:Page"), true)
        .unwrap();
    assert_eq!(
        nb.get(&name("Elsewhere:Page")).unwrap(),
        "[[Zim:Sibling]] and [[Zim:Sibling]]"
    );
}

#[test]
fn links_that_led_nowhere_are_left_alone() {
    let mut nb = notebook(&[("A", "[[Missing]] [[:Gone:Page]] [[A]]"), ("B", "b")]);
    nb.rename(&name("A"), &name("C"), true).unwrap();
    assert_eq!(
        nb.get(&name("C")).unwrap(),
        "[[Missing]] [[:Gone:Page]] [[C]]"
    );
}

#[test]
fn an_absolute_link_stays_absolute_and_a_child_link_stays_a_child_link() {
    let mut nb = notebook(&[
        ("Top:Page", "[[+Kid]] [[:Top:Page:Kid]]"),
        ("Top:Page:Kid", "k"),
    ]);
    nb.rename(&name("Top:Page"), &name("Moved:Here:Page"), true)
        .unwrap();
    assert_eq!(
        nb.get(&name("Moved:Here:Page")).unwrap(),
        "[[+Kid]] [[:Moved:Here:Page:Kid]]"
    );
}

#[test]
fn a_section_with_no_page_of_its_own_can_be_moved() {
    let mut nb = notebook(&[
        ("Old:One", "[[Two]]"),
        ("Old:Two", "t"),
        ("Home", "[[Old:One]]"),
    ]);
    nb.rename(&name("Old"), &name("New"), true).unwrap();
    assert_eq!(names(&nb), ["Home", "New:One", "New:Two"]);
    assert_eq!(nb.get(&name("Home")).unwrap(), "[[New:One]]");
    assert_eq!(nb.get(&name("New:One")).unwrap(), "[[Two]]");
}

#[test]
fn renaming_only_the_case_is_allowed() {
    let mut nb = notebook(&[("foo", "[[foo]]"), ("bar", "[[Foo]]")]);
    nb.rename(&name("foo"), &name("Foo"), true).unwrap();
    assert_eq!(nb.page_name(&name("foo")).unwrap().as_str(), "Foo");
    assert_eq!(nb.get(&name("bar")), Some("[[Foo]]"));
}

#[test]
fn renames_that_cannot_be_done_say_so_and_change_nothing() {
    let mut nb = notebook(&[("A", "[[B]]"), ("B", "b"), ("A:Kid", "k")]);
    let before = texts(&nb);
    assert_eq!(
        nb.rename(&name("Missing"), &name("X"), true),
        Err(RenameError::NothingThere(name("Missing")))
    );
    assert_eq!(
        nb.rename(&name("A"), &name("B"), true),
        Err(RenameError::Taken(name("B")))
    );
    assert_eq!(
        nb.rename(&name("A"), &name("b"), true),
        Err(RenameError::Taken(name("B"))),
        "taken regardless of case"
    );
    assert_eq!(
        nb.rename(&name("A"), &name("A:Kid:Deeper"), true),
        Err(RenameError::IntoItself)
    );
    assert_eq!(
        nb.rename(&name("A"), &name("a:x"), true),
        Err(RenameError::IntoItself)
    );
    assert_eq!(
        nb.rename(&name("A:Kid"), &name("B"), true),
        Err(RenameError::Taken(name("B")))
    );
    assert_eq!(texts(&nb), before);
    // renaming to itself is nothing, not an error
    assert_eq!(
        nb.rename(&name("A"), &name("A"), true).unwrap().moved.len(),
        0
    );
}

#[test]
fn moving_into_a_section_that_exists_merges_with_it() {
    let mut nb = notebook(&[("Loose", "[[Home]]"), ("Archive:Old", "o"), ("Home", "h")]);
    nb.rename(&name("Loose"), &name("Archive:Loose"), true)
        .unwrap();
    assert_eq!(names(&nb), ["Archive:Loose", "Archive:Old", "Home"]);
    assert_eq!(
        nb.get(&name("Archive:Loose")).unwrap(),
        "[[Home]]",
        "Home is still found, higher up"
    );
}

/// How a page refers to a file, worked out here (and not by the library function whose work it
/// checks): the path from the page's folder, `./` or `../`, with what would break a reference
/// written as `%XX`.
fn reference_text(page: &PageName, file: &str, dot: bool) -> String {
    let folder: Vec<String> = page.folder_path().split('/').map(str::to_lowercase).collect();
    let parts: Vec<&str> = file.split('/').collect();
    let (dir, last) = parts.split_at(parts.len() - 1);
    let mut common = 0;
    while common < folder.len() && common < dir.len() && folder[common] == dir[common].to_lowercase() {
        common += 1;
    }
    let escape = |part: &str| -> String {
        part.chars()
            .map(|c| match c {
                '%' | '?' | '|' | '#' | '[' | ']' | '{' | '}' => format!("%{:02X}", c as u32),
                c => c.to_string(),
            })
            .collect()
    };
    let rest: Vec<String> = dir[common..].iter().chain(last.iter()).map(|p| escape(p)).collect();
    let up = folder.len() - common;
    let text = format!("{}{}", "../".repeat(up), rest.join("/"));
    if up == 0 && dot {
        format!("./{text}")
    } else if up == 0 && (text.starts_with('~') || text.chars().nth(1) == Some(':')) {
        format!("./{text}") // read as a place outside the notebook otherwise
    } else {
        text
    }
}

/// Random notebooks from a small alphabet, so that names collide and shadow each other constantly,
/// with pages that link to each other in every style.
fn random_notebook(rng: &mut Rng, pages: usize) -> Notebook {
    let parts = ["a", "b", "c", "d"];
    let random_name = |rng: &mut Rng| {
        let depth = 1 + rng.below(3);
        PageName::parse(
            &(0..depth)
                .map(|_| parts[rng.below(parts.len())])
                .collect::<Vec<_>>()
                .join(":"),
        )
        .unwrap()
    };
    let mut nb = Notebook::new();
    let mut names = BTreeSet::new();
    for _ in 0..pages {
        let n = random_name(rng);
        names.insert(n.key());
        nb.put(&n, "");
    }
    let all: Vec<PageName> = nb.names().cloned().collect();
    // Files: in the folders of pages, in folders no page has, and at the top.
    let mut file_paths: Vec<String> = Vec::new();
    // (some with names that would break a reference if it were written as they are)
    let awkward = ["w?.png", "p|q.png", "c}}d.png", "50%.png", "h#.png", "~t.png", "x:y.png", "b[r].png", "s p.png"];
    for page in &all {
        for k in 0..rng.below(3) {
            let file = if rng.below(4) == 0 { awkward[rng.below(awkward.len())].to_string() } else { format!("f{k}.png") };
            file_paths.push(format!("{}/{file}", page.folder_path()));
        }
    }
    for k in 0..rng.below(3) {
        let folder: Vec<&str> = (0..1 + rng.below(2)).map(|_| parts[rng.below(parts.len())]).collect();
        // (sometimes named like the files of the pages, so that a move can land on one)
        let file = if rng.below(2) == 0 { format!("f{k}.png") } else { format!("o{k}.pdf") };
        file_paths.push(format!("{}/{file}", folder.join("/")));
    }
    for k in 0..rng.below(2) {
        file_paths.push(format!("top{k}.png"));
    }
    for path in &file_paths {
        nb.put_file(path).unwrap();
    }
    for page in &all {
        let mut text = format!("====== {} ======\n", page.last());
        // references to files: right ones in every style, wrong ones, and ones to somewhere else
        for _ in 0..rng.below(4) {
            let pick = |rng: &mut Rng| file_paths[rng.below(file_paths.len())].clone();
            let (wanted, link_ok) = match rng.below(7) {
                0..=2 if !file_paths.is_empty() => (reference_text(page, &pick(rng), true), true),
                3 if !file_paths.is_empty() => (reference_text(page, &pick(rng), false), false),
                4 if !file_paths.is_empty() => (reference_text(page, &pick(rng), true).to_uppercase(), true),
                5 => ("/abs/outside.png".to_string(), true),
                _ => ("./missing.png".to_string(), true),
            };
            text.push_str(&match rng.below(4) {
                0 => format!("{{{{{wanted}}}}}\n"),
                1 => format!("{{{{{wanted}?width=20|alt}}}}\n"),
                // (a link is a file link only if it has a `/` in it)
                2 if link_ok => format!("[[{wanted}]]\n"),
                _ if link_ok => format!("[[{wanted}|file]]\n"),
                _ => format!("{{{{{wanted}}}}}\n"),
            });
        }
        for _ in 0..rng.below(5) {
            let target = match rng.below(5) {
                0 => nb.link_to(page, &all[rng.below(all.len())]),
                1 => format!(":{}", all[rng.below(all.len())]),
                2 => format!("+{}", random_name(rng)),
                3 => random_name(rng).to_string(),
                _ => format!("{}#sec", nb.link_to(page, &all[rng.below(all.len())])),
            };
            let display = if rng.below(3) == 0 { "|shown" } else { "" };
            text.push_str(&format!("see [[{target}{display}]]\n"));
        }
        nb.put(page, text);
    }
    nb
}

#[test]
fn after_a_rename_every_link_still_leads_to_the_page_it_led_to() {
    let mut rng = Rng(0x2E4A_3E00_C0DE_0042);
    let (mut renamed, mut refused, mut rewritten) = (0, 0, 0);
    let (mut files_moved, mut file_clashes) = (0, 0);
    for case in 0..6_000 {
        let pages = 2 + rng.below(12);
        let mut nb = random_notebook(&mut rng, pages);
        let all: Vec<PageName> = nb.names().cloned().collect();
        // an old name that is a page or a section of one
        let page = &all[rng.below(all.len())];
        let old = page.prefix(1 + rng.below(page.depth()));
        let new = {
            let parts = ["a", "b", "c", "d", "e"];
            let depth = 1 + rng.below(3);
            PageName::parse(
                &(0..depth)
                    .map(|_| parts[rng.below(parts.len())])
                    .collect::<Vec<_>>()
                    .join(":"),
            )
            .unwrap()
        };
        match common::rename_checked(&mut nb, &old, &new, &format!("case {case}")) {
            Ok(report) => {
                renamed += 1;
                rewritten += report.links_changed;
                files_moved += report.files_moved.len();
            }
            Err(e) => {
                refused += 1;
                file_clashes += usize::from(matches!(e, RenameError::FileTaken(_)));
            }
        }
    }
    assert!(renamed > 2_000 && refused > 100 && rewritten > 1_000, "the generator exercised too little: {renamed} renamed, {refused} refused, {rewritten} links rewritten");
    assert!(files_moved > 1_000 && file_clashes > 10, "too few files in play: {files_moved} moved, {file_clashes} renames refused for landing on a file");
}
