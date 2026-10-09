//! Completing a link that is being typed: which pages `[[Gar` may lead to, in what order, and what to write for each.

mod common;
use common::name;
use zim_notebook::{Link, LinkSuggestion, Notebook};

fn notebook(pages: &[&str]) -> Notebook {
    let mut nb = Notebook::new();
    for page in pages {
        nb.put(&name(page), "text\n");
    }
    nb
}

fn pages(found: &[LinkSuggestion]) -> Vec<String> {
    found.iter().map(|s| s.page.to_string()).collect()
}

const GARDEN: [&str; 8] = [
    "Home",
    "Garden",
    "Gardening",
    "Roof",
    "Projects:Garden",
    "Projects:Garden:Beds",
    "Projects:Roof",
    "Notes:My garden",
];

#[test]
fn what_is_typed_finds_the_pages_best_first() {
    let nb = notebook(&GARDEN);
    let from = name("Home");
    // the last part of the name is what was typed, then it starts with it, then the whole name does, then a part of it does, then it is somewhere in it
    let found = nb.complete_link(&from, "gard", 20);
    assert_eq!(
        pages(&found),
        ["Garden", "Gardening", "Projects:Garden", "Projects:Garden:Beds", "Notes:My garden"],
        "{found:?}"
    );
    // (Projects:Garden:Beds has a part that starts with it; Notes:My garden has it in the middle of a part)
    let found = nb.complete_link(&from, "garden", 20);
    assert_eq!(pages(&found), ["Garden", "Projects:Garden", "Gardening", "Projects:Garden:Beds", "Notes:My garden"]);
    // the whole name starts with it: its first part is typed, the last is not
    let found = nb.complete_link(&from, "projects:g", 20);
    assert_eq!(pages(&found), ["Projects:Garden", "Projects:Garden:Beds"]);
    // a part in the middle
    assert_eq!(pages(&nb.complete_link(&from, "beds", 20)), ["Projects:Garden:Beds"]);
    assert_eq!(pages(&nb.complete_link(&from, "nothing like it", 20)), Vec::<String>::new());
}

#[test]
fn case_and_blanks_around_it_do_not_matter() {
    let nb = notebook(&GARDEN);
    let from = name("Home");
    let plain = pages(&nb.complete_link(&from, "gard", 20));
    assert!(!plain.is_empty());
    for typed in ["GARD", "  gard", "gard  ", " GaRd "] {
        assert_eq!(pages(&nb.complete_link(&from, typed, 20)), plain, "{typed:?}");
    }
    // (and a page is offered as it is spelled)
    assert!(plain.contains(&"Notes:My garden".to_string()));
}

#[test]
fn nothing_typed_offers_what_there_is_from_the_top() {
    let nb = notebook(&GARDEN);
    let found = nb.complete_link(&name("Home"), "", 20);
    // not the page itself; sections (pages that only hold other pages) are there; the top of the notebook first, then by name
    assert_eq!(
        pages(&found),
        ["Garden", "Gardening", "Notes", "Projects", "Roof", "Notes:My garden", "Projects:Garden", "Projects:Roof", "Projects:Garden:Beds"]
    );
    assert_eq!(nb.complete_link(&name("Home"), "", 3).len(), 3);
    assert_eq!(nb.complete_link(&name("Home"), "", 0), Vec::new());
}

#[test]
fn a_section_is_offered_and_says_it_has_no_text() {
    let nb = notebook(&GARDEN);
    let found = nb.complete_link(&name("Home"), "proj", 20);
    assert_eq!(pages(&found)[0], "Projects");
    assert!(!found[0].has_page, "Projects only holds pages");
    assert!(found[1..].iter().all(|s| s.has_page));
    assert!(nb.complete_link(&name("Home"), "garden", 20).iter().all(|s| s.has_page));
}

#[test]
fn a_page_is_not_offered_a_link_to_itself() {
    let nb = notebook(&GARDEN);
    assert!(!pages(&nb.complete_link(&name("Garden"), "garden", 20)).contains(&"Garden".to_string()));
    // (the case of the name does not matter to that)
    assert!(!pages(&nb.complete_link(&name("garden"), "gard", 20)).contains(&"Garden".to_string()));
    // but the pages above and below it are
    let found = pages(&nb.complete_link(&name("Projects:Garden"), "", 20));
    assert!(found.contains(&"Projects".to_string()) && found.contains(&"Projects:Garden:Beds".to_string()));
}

#[test]
fn a_plus_looks_below_the_page_the_link_is_on_and_names_from_there() {
    let nb = notebook(&GARDEN);
    let from = name("Projects");
    let found = nb.complete_link(&from, "+", 20);
    assert_eq!(pages(&found), ["Projects:Garden", "Projects:Roof", "Projects:Garden:Beds"]);
    assert_eq!(found.iter().map(|s| s.link.as_str()).collect::<Vec<_>>(), ["+Garden", "+Roof", "+Garden:Beds"]);
    assert_eq!(pages(&nb.complete_link(&from, "+bed", 20)), ["Projects:Garden:Beds"]);
    assert_eq!(pages(&nb.complete_link(&from, "+garden:b", 20)), ["Projects:Garden:Beds"]);
    // not what is beside it, or above it
    assert_eq!(pages(&nb.complete_link(&from, "+home", 20)), Vec::<String>::new());
    assert_eq!(pages(&nb.complete_link(&name("Home"), "+", 20)), Vec::<String>::new(), "a page with nothing below it");
}

#[test]
fn a_colon_starts_from_the_top_of_the_notebook() {
    let nb = notebook(&GARDEN);
    let from = name("Home");
    // (only a name that starts with it: Projects:Garden is not what ":garden" says)
    assert_eq!(pages(&nb.complete_link(&from, ":garden", 20)), ["Garden", "Gardening"]);
    assert_eq!(pages(&nb.complete_link(&from, ":Projects:", 20)), ["Projects:Garden", "Projects:Roof", "Projects:Garden:Beds"]);
    assert_eq!(pages(&nb.complete_link(&from, ":projects:garden", 20)), ["Projects:Garden", "Projects:Garden:Beds"]);
    assert_eq!(pages(&nb.complete_link(&from, ":beds", 20)), Vec::<String>::new());
}

#[test]
fn what_is_not_a_name_gets_nothing() {
    let nb = notebook(&GARDEN);
    for typed in ["Garden#head", "#head", "Gar|den", "[", "a]b", "[[Garden"] {
        assert_eq!(nb.complete_link(&name("Home"), typed, 20), Vec::new(), "{typed:?}");
    }
    // a bracket can't be written in a link's target, so none is offered for one even if a page's name has one
    let nb = notebook(&["Home", "a[b", "a]c", "ab"]);
    assert_eq!(pages(&nb.complete_link(&name("Home"), "a[", 20)), Vec::<String>::new());
    assert_eq!(pages(&nb.complete_link(&name("Home"), "a]", 20)), Vec::<String>::new());
    // (and the pages that have a bracket are not offered at all: see the test of that below)
    assert_eq!(pages(&nb.complete_link(&name("Home"), "a", 20)), ["ab"]);
}

#[test]
fn a_page_with_a_bracket_in_its_name_is_not_offered_because_no_link_to_it_can_be_written() {
    let nb = notebook(&["Home", "a]x", "ab", "a[c", "Projects:q]r", "Projects:Garden"]);
    // (it would come first, and it does not take the place of one that can be written)
    assert_eq!(pages(&nb.complete_link(&name("Home"), "a", 1)), ["ab"]);
    let all = pages(&nb.complete_link(&name("Home"), "a", 20));
    assert_eq!(all, ["ab", "Projects:Garden"], "the only others with an a in them");
    // nor the section above one that only holds such pages... which is a name without a bracket, and is offered
    assert_eq!(pages(&nb.complete_link(&name("Home"), "proj", 20)), ["Projects", "Projects:Garden"]);
    assert_eq!(pages(&nb.complete_link(&name("Home"), "q", 20)), Vec::<String>::new());
}

#[test]
fn what_is_below_a_page_is_named_from_that_page() {
    let nb = notebook(&GARDEN);
    // (the names below Projects are Garden, Garden:Beds and Roof: the start of the whole name is not part of them)
    assert_eq!(pages(&nb.complete_link(&name("Projects"), "+proj", 20)), Vec::<String>::new());
    assert_eq!(pages(&nb.complete_link(&name("Projects"), "+projects:g", 20)), Vec::<String>::new());
    assert_eq!(pages(&nb.complete_link(&name("Projects"), "+garden:", 20)), ["Projects:Garden:Beds"]);
}

#[test]
fn what_is_written_leads_to_the_page_from_where_it_is_written() {
    let mut pages_of = Vec::new();
    for top in ["Alpha", "Beta", "Journal"] {
        pages_of.push(top.to_string());
        for sub in ["Notes", "Todo", "Plan", "Alpha"] {
            pages_of.push(format!("{top}:{sub}"));
            for deep in ["Notes", "Plan", "x"] {
                pages_of.push(format!("{top}:{sub}:{deep}"));
            }
        }
    }
    pages_of.push("Journal:2026:10:09".to_string());
    let refs: Vec<&str> = pages_of.iter().map(String::as_str).collect();
    let nb = notebook(&refs);
    let mut checked = 0;
    for from in ["Alpha", "Alpha:Notes", "Beta:Todo:Plan", "Journal:2026:10:09", "Alpha:Alpha:Notes", "Elsewhere"] {
        for typed in ["", "n", "notes", "alpha", "+", "+plan", ":beta", ":journal:2026", "pl", "todo:p", "2026", "x"] {
            for suggestion in nb.complete_link(&name(from), typed, 50) {
                match nb.resolve(&name(from), &suggestion.link) {
                    Link::Page { page, .. } => assert!(page.same_page(&suggestion.page), "{from} typed {typed:?}: {} leads to {page}, not {}", suggestion.link, suggestion.page),
                    other => panic!("{from} typed {typed:?}: {} leads to {other:?}", suggestion.link),
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 500, "{checked}");
}

#[test]
fn the_shortest_text_that_leads_there_is_what_is_written() {
    let nb = notebook(&GARDEN);
    let link_of = |from: &str, typed: &str, page: &str| -> String {
        nb.complete_link(&name(from), typed, 20)
            .into_iter()
            .find(|s| s.page.as_str() == page)
            .unwrap_or_else(|| panic!("{page} not offered for {typed:?} on {from}"))
            .link
    };
    // a page beside it is its own name; one that would be taken for another needs more of its name
    assert_eq!(link_of("Projects:Roof", "garden", "Projects:Garden"), "Garden");
    assert_eq!(link_of("Home", "garden", "Garden"), "Garden");
    assert_eq!(link_of("Home", "garden", "Projects:Garden"), "Projects:Garden");
    // below the page it is written on
    assert_eq!(link_of("Projects", "garden", "Projects:Garden"), "+Garden");
}

#[test]
fn only_so_many_are_offered_and_the_best_come_first() {
    let mut names = vec!["Home".to_string()];
    names.extend((0..40).map(|n| format!("Item {n:02}")));
    names.push("An item".to_string());
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let nb = notebook(&refs);
    let found = nb.complete_link(&name("Home"), "item", 5);
    assert_eq!(found.len(), 5);
    // "Item NN" starts with it, "An item" only has it in the middle
    assert_eq!(pages(&found), ["Item 00", "Item 01", "Item 02", "Item 03", "Item 04"]);
    let all = nb.complete_link(&name("Home"), "item", 100);
    assert_eq!(all.len(), 41);
    assert_eq!(all.last().unwrap().page.as_str(), "An item");
}
