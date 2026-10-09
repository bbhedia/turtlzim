//! A whole notebook: its pages by name, and what follows from them.
//!
//! The notebook is a plain in-memory set of pages. Where the pages are kept (a folder of `.txt`
//! files, a database in a browser, encrypted records on a server) is for a storage backend to
//! decide; it feeds pages in with [`Notebook::put`] and writes out what changed. Everything else a
//! notebook offers (the page tree, links and backlinks, search, and renames that keep links intact)
//! is worked out here, the same for every shell.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use zim_format::plain_text;

use crate::files::{
    check_file_path, images_in, relative_file_text, resolve_file, safe_file_name, unique_file_name, FileError, FileSet, FileTarget,
    ImageRef,
};
use crate::link::{classify, link_to, links_in, resolve, Link, LinkKind, LinkRef, PageSet};
use crate::name::PageName;
use crate::tags::{tag_key, tags_in, TagRef};

struct Entry {
    name: PageName,
    text: String,
    /// The `[[links]]` in `text`, found once when the text is set.
    links: Vec<LinkRef>,
    /// The `{{images}}` in `text`.
    images: Vec<ImageRef>,
    /// The `@tags` in `text`, and the keys of them (see `tag_key`).
    tags: Vec<TagRef>,
    tag_keys: HashSet<String>,
    /// What the page reads as with its markup tidied away (see `zim_format::plain_text`), and that in
    /// lower case: what a search looks through.
    plain: String,
    plain_lower: String,
}

impl Entry {
    fn new(name: PageName, text: String) -> Entry {
        let mut entry = Entry { name, text: String::new(), links: Vec::new(), images: Vec::new(), tags: Vec::new(), tag_keys: HashSet::new(), plain: String::new(), plain_lower: String::new() };
        entry.set_text(text);
        entry
    }

    fn set_text(&mut self, text: String) {
        self.links = links_in(&text);
        self.images = images_in(&text);
        self.tags = tags_in(&text);
        self.tag_keys = self.tags.iter().map(|t| tag_key(&t.name)).collect();
        self.plain = plain_text(&text);
        self.plain_lower = self.plain.to_lowercase();
        self.text = text;
    }
}

/// The pages of a notebook.
#[derive(Default)]
pub struct Notebook {
    /// By key (the name in lower case), so that lookups ignore case and a walk is in name order.
    pages: BTreeMap<String, Entry>,
    /// The paths of the files (attachments) by key (the path in lower case), as spelled. The bytes
    /// are not here: a storage backend keeps them.
    files: BTreeMap<String, String>,
}

impl FileSet for Notebook {
    fn find_file(&self, path: &str) -> Option<String> {
        self.files.get(&path.to_lowercase()).cloned()
    }
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

/// A tag, and the pages that have it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagInfo {
    /// The tag as the first page that has it (in name order) spells it, without the `@`.
    pub name: String,
    /// The pages that write it, in name order.
    pub pages: Vec<PageName>,
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
    /// A file of the pages moving would land on this file, which stays where it is.
    FileTaken(String),
    /// The move would make this path both a file and a folder (a file that stays is where a folder
    /// of the pages moving would be, or a folder of files that stay is where a file would land).
    FileAndFolder(String),
}

impl std::fmt::Display for RenameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenameError::NothingThere(name) => write!(f, "There is no page called {name}."),
            RenameError::IntoItself => write!(f, "A page can't be moved below itself."),
            RenameError::Taken(name) => write!(f, "A page called {name} already exists."),
            RenameError::FileTaken(path) => write!(f, "A file called {path} already exists."),
            RenameError::FileAndFolder(path) => write!(f, "{path} would be both a file and a folder."),
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
    /// How many links (and images) were rewritten.
    pub links_changed: usize,
    /// Every file that moved with the pages (a page's folder holds its attachments), from its old
    /// path to its new one.
    pub files_moved: Vec<(String, String)>,
}

/// The text of a new page, as Zim starts one: its header and a title heading.
/// `created` is a time such as `2026-10-06T09:41:03+02:00`.
pub fn new_page_text(name: &PageName, created: &str) -> String {
    page_text_titled(name.last(), created)
}

/// The text of a new page whose title is `title` (see `new_page_text`).
pub(crate) fn page_text_titled(title: &str, created: &str) -> String {
    let created: String = created.chars().filter(|c| !c.is_control()).collect();
    format!("Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: {created}\n\n====== {title} ======\n")
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
        match self.pages.get_mut(&name.key()) {
            Some(entry) => entry.set_text(text),
            None => {
                self.pages.insert(name.key(), Entry::new(name.clone(), text));
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

    // ---- tags

    /// Every tag in the notebook with the pages that have it, in the order of the tags' names (case
    /// ignored).
    pub fn tags(&self) -> Vec<TagInfo> {
        let mut found: BTreeMap<String, TagInfo> = BTreeMap::new();
        for entry in self.pages.values() {
            for key in &entry.tag_keys {
                let spelled = entry.tags.iter().find(|t| &tag_key(&t.name) == key).map_or(key.as_str(), |t| t.name.as_str());
                found.entry(key.clone()).or_insert_with(|| TagInfo { name: spelled.to_string(), pages: Vec::new() }).pages.push(entry.name.clone());
            }
        }
        found.into_values().collect()
    }

    /// The pages that write the tag `tag` (with or without its `@`, in any case), in name order.
    pub fn pages_with_tag(&self, tag: &str) -> Vec<PageName> {
        let key = tag_key(tag);
        self.pages.values().filter(|e| e.tag_keys.contains(&key)).map(|e| e.name.clone()).collect()
    }

    /// The tags a page writes, each once, in the order they first appear, as written there.
    pub fn tags_of(&self, name: &PageName) -> Vec<String> {
        let mut seen = HashSet::new();
        match self.pages.get(&name.key()) {
            Some(entry) => entry.tags.iter().filter(|t| seen.insert(tag_key(&t.name))).map(|t| t.name.clone()).collect(),
            None => Vec::new(),
        }
    }

    /// Where the link `target`, written on page `from`, leads in this notebook.
    pub fn resolve(&self, from: &PageName, target: &str) -> Link {
        resolve(from, target, self)
    }

    /// The shortest link text that, written on `from`, leads to `to`.
    pub fn link_to(&self, from: &PageName, to: &PageName) -> String {
        link_to(from, to, self)
    }

    // ---- files (attachments)

    /// Record that the notebook has a file at `path` (a path relative to the notebook, with `/`
    /// between folders). A file that is already there keeps its spelling. A path can't be both a
    /// file and a folder, so this refuses one that has a file for a folder above it, or that is the
    /// folder of files already here.
    pub fn put_file(&mut self, path: &str) -> Result<(), FileError> {
        check_file_path(path)?;
        let key = path.to_lowercase();
        if self.files.contains_key(&key) {
            return Ok(());
        }
        if let Some(other) = self.file_folder_clash(&key) {
            return Err(FileError {
                path: path.to_string(),
                reason: format!("would be both a file and a folder (see {other})"),
            });
        }
        self.files.insert(key, path.to_string());
        Ok(())
    }

    /// A file that stops `key` (a lower-case path, not itself a file) from being a file: one that is
    /// a folder above it, or one that has it for a folder.
    fn file_folder_clash(&self, key: &str) -> Option<String> {
        if let Some(file) = self.folder_blocked_by_file(key) {
            return Some(file);
        }
        let below = format!("{key}/");
        self.files
            .range(below.clone()..)
            .next()
            .filter(|(k, _)| k.starts_with(&below))
            .map(|(_, path)| path.clone())
    }

    /// A file that stops `folder` (a lower-case path) from being a folder: itself, or one above it.
    fn folder_blocked_by_file(&self, folder: &str) -> Option<String> {
        folder
            .match_indices('/')
            .map(|(at, _)| &folder[..at])
            .chain(std::iter::once(folder))
            .find_map(|prefix| self.files.get(prefix).cloned())
    }

    /// Whether `path` is already taken for a new file: by a file, by a folder some file is in, or by
    /// the folder of a page or section.
    fn path_in_use(&self, path: &str) -> bool {
        let key = path.to_lowercase();
        let below = format!("{key}/");
        self.files.contains_key(&key)
            || self.files.range(below.clone()..).next().is_some_and(|(k, _)| k.starts_with(&below))
            || PageName::from_folder_path(path).ok().is_some_and(|name| self.find(&name).is_some())
    }

    /// Forget the file at `path`. Whether there was one.
    pub fn remove_file(&mut self, path: &str) -> bool {
        self.files.remove(&path.to_lowercase()).is_some()
    }

    pub fn has_file(&self, path: &str) -> bool {
        self.files.contains_key(&path.to_lowercase())
    }

    /// The path of the file as the notebook spells it, if there is one.
    pub fn file_path(&self, path: &str) -> Option<&str> {
        self.files.get(&path.to_lowercase()).map(String::as_str)
    }

    /// Every file, in path order (ignoring case).
    pub fn files(&self) -> impl Iterator<Item = &str> {
        self.files.values().map(String::as_str)
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    /// The files in the folder named like `page`: its attachments, not those of the pages below it.
    pub fn files_of(&self, page: &PageName) -> Vec<String> {
        let prefix = format!("{}/", page.folder_path().to_lowercase());
        self.files
            .iter()
            .filter(|(key, _)| key.strip_prefix(&prefix).is_some_and(|rest| !rest.contains('/')))
            .map(|(_, path)| path.clone())
            .collect()
    }

    /// The files in the folder named like `page` and in every folder below it: what goes with the
    /// page when it is moved or deleted.
    pub fn files_below(&self, page: &PageName) -> Vec<String> {
        let prefix = format!("{}/", page.folder_path().to_lowercase());
        self.files
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, path)| path.clone())
            .collect()
    }

    /// Forget the files [`files_below`](Notebook::files_below) lists, and return them.
    pub fn remove_files_below(&mut self, page: &PageName) -> Vec<String> {
        let prefix = format!("{}/", page.folder_path().to_lowercase());
        let keys: Vec<String> = self.files.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.iter().filter_map(|k| self.files.remove(k)).collect()
    }

    /// Where the file reference `target` (the path of an image, or of a `[[./file]]` link),
    /// written on page `from`, leads in this notebook.
    pub fn resolve_file(&self, from: &PageName, target: &str) -> FileTarget {
        resolve_file(from, target, self)
    }

    /// The `{{images}}` in a page's text.
    pub fn images(&self, name: &PageName) -> &[ImageRef] {
        self.pages.get(&name.key()).map_or(&[], |e| &e.images)
    }

    /// The path for a new attachment of `page` that people call `wanted`: in the page's folder, with
    /// a name that is safe in a link, doesn't end in `.txt`, and isn't in use, not even as the name
    /// of a folder or of a page below it. Refused, with the reason, if a file is where the page's
    /// folder would be.
    pub fn attachment_path(&self, page: &PageName, wanted: &str) -> Result<String, FileError> {
        let folder = page.folder_path();
        if let Some(file) = self.folder_blocked_by_file(&folder.to_lowercase()) {
            return Err(FileError {
                path: folder,
                reason: format!("can't hold attachments: there is a file called {file}"),
            });
        }
        let name = unique_file_name(&safe_file_name(wanted), |n| self.path_in_use(&format!("{folder}/{n}")));
        Ok(format!("{folder}/{name}"))
    }

    /// The text that, written on `from` as a file reference, leads to the file at `path`.
    pub fn file_link(&self, from: &PageName, path: &str) -> String {
        relative_file_text(from, path, true)
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
                            context = context_line(&entry.text, link.start);
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

    /// Pages whose name or text contains every word of `query` (ignoring case) and that have every
    /// `@tag` in it, best first: those matching in the name, then by how often the words and tags
    /// occur. A word that starts with `@` (and has more after it) is a tag: the page has to write that
    /// tag, exactly (`@mail` is not `@mailing`). At most `limit` of them.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let mut words: Vec<String> = Vec::new();
        let mut wanted_tags: Vec<String> = Vec::new();
        for word in query.split_whitespace() {
            match word.strip_prefix('@') {
                Some(tag) if !tag.is_empty() => wanted_tags.push(tag.to_lowercase()),
                _ => words.push(word.to_lowercase()),
            }
        }
        if words.is_empty() && wanted_tags.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(u32, &Entry, bool, usize)> = Vec::new();
        for (key, entry) in &self.pages {
            let lower = &entry.plain_lower;
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
                for tag in &wanted_tags {
                    if !entry.tag_keys.contains(tag) {
                        matches_all = false;
                        break;
                    }
                    let written = entry.tags.iter().filter(|t| &tag_key(&t.name) == tag).count();
                    score += 100 + written.min(50) as u32;
                    if let Some(at) = find_tag(lower, tag) {
                        first_at = Some(first_at.map_or(at, |f| f.min(at)));
                    }
                }
            }
            if matches_all {
                // `lower` can differ in length from the text (a few letters change size), so the
                // match is carried over by counting characters, not bytes.
                let chars_before = first_at.map_or(0, |at| lower[..at].chars().count());
                let at = entry.plain.char_indices().nth(chars_before).map_or(0, |(i, _)| i);
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
                snippet: snippet_around(&entry.plain, at),
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

        // The files go with the pages: a page's folder (its attachments, and the files of the pages
        // below it) moves to the folder named like the new page.
        let old_folder = format!("{}/", old.folder_path().to_lowercase());
        let new_folder = new.folder_path();
        let mut file_moves: Vec<(String, String, String)> = Vec::new(); // old key, old path, new path
        for (key, path) in &self.files {
            if key.starts_with(&old_folder) {
                let rest: Vec<&str> = path.split('/').skip(old.depth()).collect();
                file_moves.push((key.clone(), path.clone(), format!("{new_folder}/{}", rest.join("/"))));
            }
        }
        let moving_files: HashSet<&String> = file_moves.iter().map(|(key, _, _)| key).collect();
        let stays = |key: &str| !moving_files.contains(&key.to_string());
        // a file that stays and is, or is above, `folder` (a lower-case path)
        let file_in_the_way = |folder: &str| -> Option<String> {
            folder
                .match_indices('/')
                .map(|(at, _)| &folder[..at])
                .chain(std::iter::once(folder))
                .find_map(|prefix| self.files.get(prefix).filter(|_| stays(prefix)).cloned())
        };
        for (_, _, new_path) in &file_moves {
            let key = new_path.to_lowercase();
            if let Some(existing) = self.files.get(&key) {
                if stays(&key) {
                    return Err(RenameError::FileTaken(existing.clone()));
                }
            }
            // not inside a "folder" that is a file that stays
            if let Some((at, _)) = key.rmatch_indices('/').next() {
                if let Some(file) = file_in_the_way(&key[..at]) {
                    return Err(RenameError::FileAndFolder(file));
                }
            }
            // and not where a folder of files that stay is
            let below = format!("{key}/");
            if let Some((_, file)) = self.files.range(below.clone()..).take_while(|(k, _)| k.starts_with(&below)).find(|(k, _)| stays(k)) {
                return Err(RenameError::FileAndFolder(file.clone()));
            }
        }
        // the folders of the pages that move can't be files that stay either
        for key in &moving {
            let destination = renamed(&self.pages[key].name).folder_path().to_lowercase();
            if let Some(file) = file_in_the_way(&destination) {
                return Err(RenameError::FileAndFolder(file));
            }
        }
        let moved_file: HashMap<String, String> = file_moves.iter().map(|(key, _, new)| (key.clone(), new.clone())).collect();

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

        // The same for links and images that lead to a file in the notebook.
        enum FileRef {
            Link(usize),
            Image(usize),
        }
        struct FileJob {
            page_key: String,
            what: FileRef,
            want: String,
        }
        let mut file_jobs = Vec::new();
        if update_links {
            for (page_key, entry) in &self.pages {
                let mut consider = |what: FileRef, target: &str| {
                    if let FileTarget::Notebook { path, exists: true } = resolve_file(&entry.name, target, self) {
                        let want = moved_file.get(&path.to_lowercase()).cloned().unwrap_or(path);
                        file_jobs.push(FileJob { page_key: page_key.clone(), what, want });
                    }
                };
                for (index, link) in entry.links.iter().enumerate() {
                    if classify(&link.target) == LinkKind::File {
                        consider(FileRef::Link(index), &link.target);
                    }
                }
                for (index, image) in entry.images.iter().enumerate() {
                    consider(FileRef::Image(index), &image.path);
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
        for (old_key, _, _) in &file_moves {
            self.files.remove(old_key);
        }
        for (_, _, new_path) in &file_moves {
            self.files.insert(new_path.to_lowercase(), new_path.clone());
        }
        report.files_moved = file_moves.iter().map(|(_, old, new)| (old.clone(), new.clone())).collect();

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
        for job in file_jobs {
            let key = after_key.get(&job.page_key).cloned().unwrap_or(job.page_key);
            let entry = &self.pages[&key];
            let (target, start, end) = match job.what {
                FileRef::Link(i) => (entry.links[i].target.as_str(), entry.links[i].target_start, entry.links[i].target_end),
                FileRef::Image(i) => (entry.images[i].path.as_str(), entry.images[i].path_start, entry.images[i].path_end),
            };
            let leads_to_want = matches!(resolve_file(&entry.name, target, self), FileTarget::Notebook { exists: true, ref path } if path.to_lowercase() == job.want.to_lowercase());
            if !leads_to_want {
                // an image may be written without `./`; a link has to have a `/` to be a file link at all
                let dot = matches!(job.what, FileRef::Link(_)) || target.trim_start().starts_with("./");
                let text = relative_file_text(&entry.name, &job.want, dot);
                edits.entry(key).or_default().push((start, end, text));
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
            entry.set_text(text);
            report.rewritten.push(entry.name.clone());
        }
        report.files_moved.sort_by_key(|(from, _)| from.to_lowercase());
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

/// The line of `text` holding the link at byte `at`, as plain text (without its markup), cut to a
/// readable length. A line that is nothing but markup is shown as written.
fn context_line(text: &str, at: usize) -> String {
    let raw = line_around(text, at);
    let plain = plain_text(&raw);
    let plain = plain.trim();
    if plain.is_empty() {
        raw
    } else {
        cut(plain)
    }
}

fn cut(line: &str) -> String {
    if line.chars().count() <= 160 {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(160).collect::<String>())
    }
}

/// The line of `text` holding byte `at`, trimmed.
fn line_around(text: &str, at: usize) -> String {
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    text[start..end].trim().to_string()
}

/// Where the tag `@key` is written in `lower` (a page's plain text in lower case): the first `@key`
/// that is a whole tag, not the start of a longer one nor the end of a word.
fn find_tag(lower: &str, key: &str) -> Option<usize> {
    let wanted = format!("@{key}");
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    lower.match_indices(wanted.as_str()).map(|(at, _)| at).find(|&at| {
        let before_ok = !lower[..at].chars().next_back().map_or(false, word);
        let after_ok = !lower[at + wanted.len()..].chars().next().map_or(false, word);
        before_ok && after_ok
    })
}

/// About 160 characters of `text` around byte `at`, on one line. A window that would leave out only
/// a few characters at an end reaches the end instead of starting or stopping with an ellipsis.
fn snippet_around(text: &str, at: usize) -> String {
    const BEFORE: usize = 60;
    const AFTER: usize = 100;
    const CLOSE_ENOUGH: usize = 12;
    let before: Vec<(usize, char)> = text[..at].char_indices().rev().take(BEFORE).collect();
    let mut from = before.last().map_or(at, |(i, _)| *i);
    let mut to = text[at..].char_indices().nth(AFTER).map_or(text.len(), |(i, _)| at + i);
    if text[..from].chars().count() <= CLOSE_ENOUGH {
        from = 0;
    }
    if text[to..].chars().count() <= CLOSE_ENOUGH {
        to = text.len();
    }
    let mut snippet = text[from..to].split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        snippet.insert(0, '…');
    }
    if to < text.len() {
        snippet.push('…');
    }
    snippet
}
