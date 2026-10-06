//! The rules against REAL notebooks. Zim's own manual is a notebook of 81 pages written by the
//! people who wrote the rules, so every page link in it should lead to a page that exists; if one
//! doesn't, either the rules are misread here or the manual has a broken link, and each such link
//! is looked at by hand.
//!
//! Like `zim-format`'s golden tests, the pages are not in this repository (Zim is GPLv2): point
//! `ZIM_GOLDEN_DIR` at a checkout of the Zim project, or at any directory holding notebooks (a
//! notebook is a folder with a `notebook.zim` file in it); `scripts/zim-golden.sh` does the former.
//!
//!   ZIM_GOLDEN_DIR=$HOME/.cache/turtlzim-labs/zim-desktop-wiki \
//!       cargo test -p zim-notebook --release --test golden_notebooks -- --ignored --nocapture

mod common;
use std::collections::BTreeMap;

use common::{notebook_roots, read_notebook, Pages};
use zim_notebook::{links_in, resolve, Link, PageName};

fn notebooks() -> Vec<(String, BTreeMap<String, String>)> {
    let var = std::env::var_os("ZIM_GOLDEN_DIR")
        .expect("ZIM_GOLDEN_DIR is not set (see this file's docs)");
    let roots = notebook_roots(&var);
    assert!(
        !roots.is_empty(),
        "no notebook (a folder with notebook.zim) below ZIM_GOLDEN_DIR={var:?}"
    );
    roots
        .into_iter()
        .map(|root| (root.display().to_string(), read_notebook(&root)))
        .collect()
}

#[test]
#[ignore = "needs real Zim notebooks: set ZIM_GOLDEN_DIR (see the module docs)"]
fn every_page_link_in_a_real_notebook_leads_to_a_page() {
    for (root, pages) in notebooks() {
        let set = Pages(pages.keys().map(|n| PageName::parse(n).unwrap()).collect());
        let (mut by_kind, mut broken): (BTreeMap<&str, usize>, Vec<String>) =
            (BTreeMap::new(), Vec::new());
        for (name, text) in &pages {
            let from = PageName::parse(name).unwrap();
            for link in links_in(text) {
                let kind = match resolve(&from, &link.target, &set) {
                    Link::Page { exists: true, .. } => "page",
                    Link::Page {
                        exists: false,
                        page,
                        ..
                    } => {
                        broken.push(format!("{name}: [[{}]] would be {page}", link.target));
                        "page (missing)"
                    }
                    Link::Anchor(_) => "anchor",
                    Link::Url(_) => "url",
                    Link::File(_) => "file",
                    Link::Email(_) => "email",
                    Link::Interwiki { .. } => "interwiki",
                    Link::Invalid(reason) => {
                        broken.push(format!("{name}: [[{}]] is invalid: {reason}", link.target));
                        "invalid"
                    }
                };
                *by_kind.entry(kind).or_default() += 1;
            }
        }
        println!("{root}: {} pages; links by kind: {by_kind:?}", pages.len());
        for line in &broken {
            println!("  BROKEN {line}");
        }
        assert!(
            broken.is_empty(),
            "{} links in {root} don't lead anywhere:\n{}",
            broken.len(),
            broken.join("\n")
        );
    }
}

#[test]
#[ignore = "needs real Zim notebooks: set ZIM_GOLDEN_DIR (see the module docs)"]
fn renaming_in_a_real_notebook_keeps_every_link_leading_where_it_led() {
    for (root, pages) in notebooks() {
        // The renames a person might do: a section, a nested page, a page into a section it isn't in,
        // a page to the top, and the front page.
        let candidates: Vec<(&str, &str)> = vec![
            ("Help", "Docs:Handbook"),
            ("Plugins:Table Editor", "Tables"),
            ("Help:Export", "Plugins:Export"),
            ("Usage", "Help:Usage"),
            ("Start", "Home"),
            ("Plugins", "Addons"),
            ("FAQ", "Help:FAQ"),
            ("Help:Links", "Help:Linking"),
        ];
        for (old, new) in candidates {
            let (old, new) = (PageName::parse(old).unwrap(), PageName::parse(new).unwrap());
            let mut nb = zim_notebook::Notebook::new();
            for (name, text) in &pages {
                nb.put(&PageName::parse(name).unwrap(), text.as_str());
            }
            if !nb.names().any(|n| n.same_page(&old) || n.is_inside(&old)) {
                continue; // this notebook has no such page (the website's pages, for one)
            }
            let report =
                common::rename_checked(&mut nb, &old, &new, &format!("{root}: {old} -> {new}"))
                    .unwrap_or_else(|e| panic!("{root}: {old} -> {new}: {e}"));
            println!(
                "{root}: {old} -> {new}: {} pages moved, {} links rewritten on {} pages",
                report.moved.len(),
                report.links_changed,
                report.rewritten.len()
            );
        }
    }
}

#[test]
#[ignore = "needs real Zim notebooks: set ZIM_GOLDEN_DIR (see the module docs)"]
fn the_tree_and_backlinks_of_a_real_notebook_make_sense() {
    for (root, pages) in notebooks() {
        let mut nb = zim_notebook::Notebook::new();
        for (name, text) in &pages {
            nb.put(&PageName::parse(name).unwrap(), text.as_str());
        }
        let tree = nb.tree();
        // every page is in the tree exactly once, with text; sections without text are the only others
        assert_eq!(
            tree.iter().filter(|n| n.has_page).count(),
            pages.len(),
            "{root}"
        );
        let top: Vec<&str> = tree
            .iter()
            .filter(|n| n.depth == 0)
            .map(|n| n.name.as_str())
            .collect();
        let mut sorted = top.clone();
        sorted.sort_by_key(|n| n.to_lowercase());
        assert_eq!(top, sorted, "{root}: the top level isn't in order");
        // each node is directly below the one before it, or a sibling or an uncle of it
        for pair in tree.windows(2) {
            assert!(
                pair[1].depth <= pair[0].depth + 1,
                "{root}: {} -> {}",
                pair[0].name,
                pair[1].name
            );
        }
        // a page's backlinks are exactly the pages with a link that resolves to it
        let mut with_backlinks = 0;
        for name in nb.names().cloned().collect::<Vec<_>>() {
            let mut expected = std::collections::BTreeSet::new();
            for other in nb.names() {
                if other.same_page(&name) {
                    continue;
                }
                if links_in(nb.get(other).unwrap()).iter().any(|l| matches!(resolve(other, &l.target, &nb), Link::Page { page, .. } if page.same_page(&name))) {
                    expected.insert(other.to_string());
                }
            }
            let got: std::collections::BTreeSet<String> = nb
                .backlinks(&name)
                .into_iter()
                .map(|b| b.from.to_string())
                .collect();
            assert_eq!(got, expected, "{root}: backlinks of {name}");
            with_backlinks += usize::from(!got.is_empty());
        }
        println!("{root}: {} tree lines, {} top-level entries, {with_backlinks} of {} pages have backlinks", tree.len(), top.len(), pages.len());
    }
}
