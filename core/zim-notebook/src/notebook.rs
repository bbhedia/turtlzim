//! A whole notebook: its pages by name, and what follows from them.
//!
//! The notebook is a plain in-memory set of pages. Where the pages are kept (a folder of `.txt`
//! files, a database in a browser, encrypted records on a server) is for a storage backend to
//! decide; it feeds pages in with [`Notebook::put`] and writes out what changed. Everything else a
//! notebook offers (the page tree, links and backlinks, search, and renames that keep links intact)
//! is worked out here, the same for every shell.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::link::{link_to, links_in, resolve, Link, LinkRef, PageSet};
use crate::name::PageName;

struct Entry {
    name: PageName,
    text: String,
    /// The `[[links]]` in `text`, found once when the text is set.
    links: Vec<LinkRef>,
}

/// The pages of a notebook.
#[derive(Default)]
pub struct Notebook {
    /// By key (the name in lower case), so that lookups ignore case and a walk is in name order.
    pages: BTreeMap<String, Entry>,
}

impl PageSet for Notebook {
    fn find(&self, name: &PageName) -> Option<PageName> {
        let key = name.key();
        if let Some(entry) = self.pages.get(&key) {
            return Some(entry.name.clone());
        }
        // A section with no text of its own: some page lies below it. Keys sort so that all the
        // pages below `key:` come together, starting at the first key not less than `key:`.
        let below = format!("{key}:");
        let (found, entry) = self.pages.range(below.clone()..).next()?;
        found
            .starts_with(&below)
            .then(|| entry.name.prefix(name.depth()))
    }
}

/// One line of the page tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeNode {
    pub name: PageName,
    /// 0 for a page at the top.
    pub depth: usize,
    /// Whether the page has text of its own; a section that only holds other pages doesn't.
    pub has_page: bool,
    /// How many pages and sections lie directly below it.
    pub children: usize,
}

/// A page that links to another.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backlink {
    pub from: PageName,
    /// How many of its links lead to the page.
    pub count: usize,
    /// The line holding the first of them.
    pub context: String,
}

/// A page matching a search.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub page: PageName,
    /// A stretch of text around the first match, on one line.
    pub snippet: String,
    /// Whether the name itself matches.
    pub in_name: bool,
}

/// Why a rename could not be done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RenameError {
    /// There is no such page, and nothing below it.
    NothingThere(PageName),
    /// A page can't be moved below itself.
    IntoItself,
    /// A page called this already exists.
    Taken(PageName),
}

impl std::fmt::Display for RenameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenameError::NothingThere(name) => write!(f, "There is no page called {name}."),
            RenameError::IntoItself => write!(f, "A page can't be moved below itself."),
            RenameError::Taken(name) => write!(f, "A page called {name} already exists."),
        }
    }
}

impl std::error::Error for RenameError {}

/// What a rename did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RenameReport {
    /// Every page that moved, from its old name to its new one.
    pub moved: Vec<(PageName, PageName)>,
    /// The pages (by their names after the move) whose text had links rewritten.
    pub rewritten: Vec<PageName>,
    /// How many links were rewritten.
    pub links_changed: usize,
}

/// The text of a new page, as Zim starts one: its header and a title heading.
/// `created` is a time such as `2026-10-06T09:41:03+02:00`.
pub fn new_page_text(name: &PageName, created: &str) -> String {
    let created: String = created.chars().filter(|c| !c.is_control()).collect();
    format!("Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: {created}\n\n====== {} ======\n", name.last())
}

impl Notebook {
    pub fn new() -> Notebook {
        Notebook::default()
    }

    /// How many pages have text.
    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    /// Set a page's text, creating the page if need be. A page that exists keeps its spelling.
    pub fn put(&mut self, name: &PageName, text: impl Into<String>) {
        let text = text.into();
        let links = links_in(&text);
        match self.pages.get_mut(&name.key()) {
            Some(entry) => {
                entry.text = text;
                entry.links = links;
            }
            None => {
                self.pages.insert(
                    name.key(),
                    Entry {
                        name: name.clone(),
                        text,
                        links,
                    },
                );
            }
        }
    }

    /// The text of a page.
    pub fn get(&self, name: &PageName) -> Option<&str> {
        self.pages.get(&name.key()).map(|e| e.text.as_str())
    }

    /// The name of the page as the notebook spells it, if it has text.
    pub fn page_name(&self, name: &PageName) -> Option<PageName> {
        self.pages.get(&name.key()).map(|e| e.name.clone())
    }

    /// Whether the page has text.
    pub fn has_page(&self, name: &PageName) -> bool {
        self.pages.contains_key(&name.key())
    }

    /// Remove one page (what lies below it stays). Whether there was one.
    pub fn remove(&mut self, name: &PageName) -> bool {
        self.pages.remove(&name.key()).is_some()
    }

    /// Remove a page and everything below it. The names removed.
    pub fn remove_tree(&mut self, name: &PageName) -> Vec<PageName> {
        let keys = self.keys_in_tree(&name.key());
        keys.iter()
            .filter_map(|k| self.pages.remove(k))
            .map(|e| e.name)
            .collect()
    }

    /// Every page, in name order.
    pub fn names(&self) -> impl Iterator<Item = &PageName> {
        self.pages.values().map(|e| &e.name)
    }

    /// The `[[links]]` of a page, as found in its text.
    pub fn links(&self, name: &PageName) -> &[LinkRef] {
        self.pages.get(&name.key()).map_or(&[], |e| &e.links)
    }

    /// Where the link `target`, written on page `from`, leads in this notebook.
    pub fn resolve(&self, from: &PageName, target: &str) -> Link {
        resolve(from, target, self)
    }

    /// The shortest link text that, written on `from`, leads to `to`.
    pub fn link_to(&self, from: &PageName, to: &PageName) -> String {
        link_to(from, to, self)
    }

    /// The keys of the page called `key` and of every page below it.
    fn keys_in_tree(&self, key: &str) -> Vec<String> {
        let below = format!("{key}:");
        let mut keys = Vec::new();
        if self.pages.contains_key(key) {
            keys.push(key.to_string());
        }
        keys.extend(
            self.pages
                .range(below.clone()..)
                .take_while(|(k, _)| k.starts_with(&below))
                .map(|(k, _)| k.clone()),
        );
        keys
    }

    /// The pages and sections as a tree, flattened in display order: a node, then what lies below
    /// it, with the pages of each section in alphabetical order (ignoring case).
    pub fn tree(&self) -> Vec<TreeNode> {
        // For every page and every section above one: its name (as the first page below it spells
        // it) and whether it has text of its own.
        let mut nodes: BTreeMap<String, (PageName, bool)> = BTreeMap::new();
        let mut children: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for entry in self.pages.values() {
            for depth in 1..=entry.name.depth() {
                let name = entry.name.prefix(depth);
                let key = name.key();
                let parent = if depth == 1 {
                    String::new()
                } else {
                    entry.name.prefix(depth - 1).key()
                };
                children.entry(parent).or_default().insert(key.clone());
                let node = nodes.entry(key).or_insert_with(|| (name, false));
                node.1 |= depth == entry.name.depth();
            }
        }
        let mut flat = Vec::with_capacity(nodes.len());
        let mut stack: Vec<(String, usize)> = children
            .get("")
            .map(|top| top.iter().rev().map(|k| (k.clone(), 0)).collect())
            .unwrap_or_default();
        while let Some((key, depth)) = stack.pop() {
            let (name, has_page) = nodes[&key].clone();
            let below = children.get(&key);
            flat.push(TreeNode {
                name,
                depth,
                has_page,
                children: below.map_or(0, |b| b.len()),
            });
            if let Some(below) = below {
                stack.extend(below.iter().rev().map(|k| (k.clone(), depth + 1)));
            }
        }
        flat
    }

    /// The pages that link to `target`, in name order. A link counts if it *resolves* to the page,
    /// by whatever form it is written; a page's links to itself don't.
    pub fn backlinks(&self, target: &PageName) -> Vec<Backlink> {
        let mut found = Vec::new();
        for entry in self.pages.values() {
            if entry.name.same_page(target) {
                continue;
            }
            let mut count = 0;
            let mut context = String::new();
            for link in &entry.links {
                if let Link::Page { page, .. } = resolve(&entry.name, &link.target, self) {
                    if page.same_page(target) {
                        if count == 0 {
                            context = line_around(&entry.text, link.start);
                        }
                        count += 1;
                    }
                }
            }
            if count > 0 {
                found.push(Backlink {
                    from: entry.name.clone(),
                    count,
                    context,
                });
            }
        }
        found
    }

    /// Pages whose name or text contains every word of `query` (ignoring case), best first: those
    /// matching in the name, then by how often the words occur. At most `limit` of them.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
        if words.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(u32, &Entry, bool, usize)> = Vec::new();
        for (key, entry) in &self.pages {
            let lower = entry.text.to_lowercase();
            let mut score = 0u32;
            let mut in_name = false;
            let mut first_at: Option<usize> = None;
            let mut matches_all = true;
            for word in &words {
                let name_hit = key.contains(word.as_str());
                let occurrences = lower.matches(word.as_str()).count();
                if !name_hit && occurrences == 0 {
                    matches_all = false;
                    break;
                }
                in_name |= name_hit;
                score += if name_hit { 100 } else { 0 } + occurrences.min(50) as u32;
                if let Some(at) = lower.find(word.as_str()) {
                    first_at = Some(first_at.map_or(at, |f| f.min(at)));
                }
            }
            if matches_all {
                // `lower` can differ in length from the text (a few letters change size), so the
                // match is carried over by counting characters, not bytes.
                let chars_before = first_at.map_or(0, |at| lower[..at].chars().count());
                let at = entry
                    .text
                    .char_indices()
                    .nth(chars_before)
                    .map_or(0, |(i, _)| i);
                scored.push((score, entry, in_name, at));
            }
        }
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.name.key().cmp(&b.1.name.key()))
        });
        scored
            .into_iter()
            .take(limit)
            .map(|(_, entry, in_name, at)| Hit {
                page: entry.name.clone(),
                snippet: snippet_around(&entry.text, at),
                in_name,
            })
            .collect()
    }

    /// Move the page `old` (and every page below it) to `new`, so that `Foo` and `Foo:Bar` become
    /// `Baz` and `Baz:Bar`. With `update_links`, every link in the notebook that led to an existing
    /// page still leads to that page afterwards, rewritten where it has to be (links to pages that
    /// moved, and relative links on pages that moved, or whose meaning changed because of the
    /// move), and left exactly as written otherwise.
    pub fn rename(
        &mut self,
        old: &PageName,
        new: &PageName,
        update_links: bool,
    ) -> Result<RenameReport, RenameError> {
        let old_key = old.key();
        let moving = self.keys_in_tree(&old_key);
        if moving.is_empty() {
            return Err(RenameError::NothingThere(old.clone()));
        }
        if new.is_inside(old) {
            return Err(RenameError::IntoItself);
        }
        if old.as_str() == new.as_str() {
            return Ok(RenameReport::default());
        }
        let renamed = |name: &PageName| -> PageName {
            let rest: Vec<&str> = name.levels().skip(old.depth()).collect();
            if rest.is_empty() {
                new.clone()
            } else {
                new.child(&rest.join(":"))
                    .expect("a valid name below a valid name")
            }
        };
        let in_moved_tree = |name: &PageName| name.same_page(old) || name.is_inside(old);

        // Nothing may land on a page that is staying where it is.
        let leaving: HashSet<&String> = moving.iter().collect();
        for key in &moving {
            let target = renamed(&self.pages[key].name);
            if self.pages.contains_key(&target.key()) && !leaving.contains(&target.key()) {
                return Err(RenameError::Taken(self.pages[&target.key()].name.clone()));
            }
        }

        // Where every link led before: only the links that led to a page count, and each remembers
        // the page it must lead to afterwards.
        struct Job {
            page_key: String,
            link: usize,
            want: PageName,
        }
        let mut jobs = Vec::new();
        if update_links {
            for (page_key, entry) in &self.pages {
                for (index, link) in entry.links.iter().enumerate() {
                    if let Link::Page {
                        page, exists: true, ..
                    } = resolve(&entry.name, &link.target, self)
                    {
                        let want = if in_moved_tree(&page) {
                            renamed(&page)
                        } else {
                            page
                        };
                        jobs.push(Job {
                            page_key: page_key.clone(),
                            link: index,
                            want,
                        });
                    }
                }
            }
        }

        // The move itself.
        let mut report = RenameReport::default();
        let mut after_key: HashMap<String, String> = HashMap::new();
        let mut taken: Vec<(String, Entry)> = moving
            .iter()
            .map(|k| (k.clone(), self.pages.remove(k).expect("listed above")))
            .collect();
        for (old_page_key, entry) in taken.drain(..) {
            let name = renamed(&entry.name);
            report.moved.push((entry.name.clone(), name.clone()));
            after_key.insert(old_page_key, name.key());
            self.pages.insert(name.key(), Entry { name, ..entry });
        }

        // Rewrite what no longer leads where it did.
        let mut edits: BTreeMap<String, Vec<(usize, usize, String)>> = BTreeMap::new();
        for job in jobs {
            let key = after_key
                .get(&job.page_key)
                .cloned()
                .unwrap_or(job.page_key);
            let entry = &self.pages[&key];
            let link = &entry.links[job.link];
            let leads_to_want = matches!(resolve(&entry.name, &link.target, self), Link::Page { ref page, .. } if page.same_page(&job.want));
            if !leads_to_want {
                let text = rewritten_target(&entry.name, &link.target, &job.want, self);
                edits
                    .entry(key)
                    .or_default()
                    .push((link.target_start, link.target_end, text));
            }
        }
        for (key, mut changes) in edits {
            changes.sort_by_key(|c| std::cmp::Reverse(c.0));
            let entry = self.pages.get_mut(&key).expect("the page is there");
            let mut text = std::mem::take(&mut entry.text);
            report.links_changed += changes.len();
            for (start, end, replacement) in changes {
                text.replace_range(start..end, &replacement);
            }
            entry.links = links_in(&text);
            entry.text = text;
            report.rewritten.push(entry.name.clone());
        }
        report.moved.sort_by_key(|(from, _)| from.key());
        report.rewritten.sort_by_key(|n| n.key());
        Ok(report)
    }
}

/// The new text of a link target so that it leads to `want` from page `from`. A target keeps its
/// character where that still works (`:Absolute` stays absolute, `+Child` stays a sub-page link),
/// and its `#anchor`.
fn rewritten_target(from: &PageName, original: &str, want: &PageName, pages: &Notebook) -> String {
    let trimmed = original.trim();
    let anchor = trimmed.find('#').map(|i| &trimmed[i..]).unwrap_or("");
    let path = &trimmed[..trimmed.len() - anchor.len()];
    let leads_to_want = |text: &str| matches!(resolve(from, text, pages), Link::Page { ref page, .. } if page.same_page(want));
    let mut text = None;
    if path.starts_with(':') {
        text = Some(format!(":{want}"));
    } else if path.starts_with('+') && want.is_inside(from) {
        let rest: Vec<&str> = want.levels().skip(from.depth()).collect();
        let candidate = format!("+{}", rest.join(":"));
        if leads_to_want(&candidate) {
            text = Some(candidate);
        }
    }
    format!(
        "{}{anchor}",
        text.unwrap_or_else(|| link_to(from, want, pages))
    )
}

/// The line of `text` holding byte `at`, trimmed and cut to a readable length.
fn line_around(text: &str, at: usize) -> String {
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let line = text[start..end].trim();
    if line.chars().count() <= 160 {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(160).collect::<String>())
    }
}

/// About 160 characters of `text` around byte `at`, on one line.
fn snippet_around(text: &str, at: usize) -> String {
    let before: Vec<(usize, char)> = text[..at].char_indices().rev().take(60).collect();
    let from = before.last().map_or(at, |(i, _)| *i);
    let to = text[at..]
        .char_indices()
        .nth(100)
        .map_or(text.len(), |(i, _)| at + i);
    let mut snippet = text[from..to]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if from > 0 {
        snippet.insert(0, '…');
    }
    if to < text.len() {
        snippet.push('…');
    }
    snippet
}
