//! Shared test helpers.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use zim_notebook::{PageName, PageSet};

/// A page set made of a list of names, the way a notebook answers `find`: an exact page, or a
/// section some page lies below (spelled as in that page's name).
pub struct Pages(pub Vec<PageName>);

impl Pages {
    pub fn new(names: &[&str]) -> Pages {
        Pages(
            names
                .iter()
                .map(|n| PageName::parse(n).expect("a valid name"))
                .collect(),
        )
    }
}

impl PageSet for Pages {
    fn find(&self, name: &PageName) -> Option<PageName> {
        let key = name.key();
        if let Some(page) = self.0.iter().find(|p| p.key() == key) {
            return Some(page.clone());
        }
        let below = format!("{key}:");
        self.0
            .iter()
            .filter(|p| p.key().starts_with(&below))
            .map(|p| p.prefix(name.depth()))
            .min_by_key(|p| p.as_str().to_string())
    }
}

pub fn name(text: &str) -> PageName {
    PageName::parse(text).unwrap_or_else(|e| panic!("{text:?}: {e}"))
}

/// A fixed-seed xorshift generator, so a failure reproduces.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Every directory below `dirs` that holds a `notebook.zim` file: a Zim notebook.
pub fn notebook_roots(dirs: &std::ffi::OsStr) -> Vec<PathBuf> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        if dir.join("notebook.zim").is_file() {
            found.push(dir.to_path_buf());
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if entry.file_type().is_ok_and(|t| t.is_dir()) && !hidden {
                walk(&entry.path(), found);
            }
        }
    }
    let mut found = Vec::new();
    for dir in std::env::split_paths(dirs) {
        walk(&dir, &mut found);
    }
    found
}

/// The pages of a notebook folder: every `.txt` file, named by its path, with the text the file holds.
pub fn read_notebook(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, pages: &mut BTreeMap<String, String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                walk(root, &path, pages);
            } else if path.extension().is_some_and(|e| e == "txt") {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let Ok(page_name) = PageName::from_path(&relative) else {
                    continue;
                };
                let Ok(file) = zim_format::PageFile::decode(&std::fs::read(&path).unwrap()) else {
                    continue;
                };
                pages.insert(page_name.to_string(), file.text);
            }
        }
    }
    let mut pages = BTreeMap::new();
    walk(root, root, &mut pages);
    pages
}

/// The files of a notebook folder that are not pages (attachments): paths relative to the
/// notebook with `/` between folders; hidden files and `notebook.zim` left out.
pub fn read_files(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, files: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                walk(root, &path, files);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative != "notebook.zim" && !relative.ends_with(".txt") {
                    files.push(relative);
                }
            }
        }
    }
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort();
    files
}

/// Rename `old` to `new` in `nb` (links updated) and check, link by link, what must hold:
///
/// * every page of the tree moved and nothing else did;
/// * every link that led to an existing page still leads to the same page (as renamed), which still
///   exists unless it was a section with no text whose pages have all moved away;
/// * links that led nowhere were left exactly as written;
/// * pages differ from before in nothing but link targets, and not at all if nothing was rewritten.
///
/// A refused rename must change nothing. Panics, naming `context`, when something doesn't hold.
pub fn rename_checked(
    nb: &mut zim_notebook::Notebook,
    old: &PageName,
    new: &PageName,
    context: &str,
) -> Result<zim_notebook::RenameReport, zim_notebook::RenameError> {
    use zim_notebook::{links_in, Link};
    let texts = |nb: &zim_notebook::Notebook| -> BTreeMap<String, String> {
        nb.names()
            .map(|n| (n.to_string(), nb.get(n).unwrap().to_string()))
            .collect()
    };
    let all: Vec<PageName> = nb.names().cloned().collect();
    let before = texts(nb);

    // the files, and where every reference to a file led (page key, is an image, index) -> (text, target)
    use zim_notebook::{classify, FileTarget, LinkKind};
    let files_before: Vec<String> = nb.files().map(String::from).collect();
    let mut file_led: BTreeMap<(String, bool, usize), (String, FileTarget)> = BTreeMap::new();
    for p in &all {
        for (i, link) in nb.links(p).iter().enumerate() {
            if classify(&link.target) == LinkKind::File {
                file_led.insert(
                    (p.key(), false, i),
                    (link.target.clone(), nb.resolve_file(p, &link.target)),
                );
            }
        }
        for (i, image) in nb.images(p).iter().enumerate() {
            file_led.insert(
                (p.key(), true, i),
                (image.path.clone(), nb.resolve_file(p, &image.path)),
            );
        }
    }

    // where each link led before
    let mut led: BTreeMap<(String, usize), (PageName, bool, bool)> = BTreeMap::new();
    for p in &all {
        for (i, link) in nb.links(p).iter().enumerate() {
            if let Link::Page { page, exists, .. } = nb.resolve(p, &link.target) {
                let had_text = nb.has_page(&page);
                led.insert((p.key(), i), (page, exists, had_text));
            }
        }
    }

    let report = match nb.rename(old, new, true) {
        Ok(report) => report,
        Err(e) => {
            assert_eq!(
                texts(nb),
                before,
                "{context}: a refused rename changed something"
            );
            assert_eq!(
                nb.files().map(String::from).collect::<Vec<_>>(),
                files_before,
                "{context}: a refused rename moved a file"
            );
            return Err(e);
        }
    };

    let moved: BTreeMap<String, PageName> = report
        .moved
        .iter()
        .map(|(from, to)| (from.key(), to.clone()))
        .collect();
    let map = |n: &PageName| -> PageName {
        if n.same_page(old) || n.is_inside(old) {
            let rest: Vec<&str> = n.levels().skip(old.depth()).collect();
            if rest.is_empty() {
                new.clone()
            } else {
                new.child(&rest.join(":")).unwrap()
            }
        } else {
            n.clone()
        }
    };
    // (naming a page what it is already called is not a move)
    for p in &all {
        let should_move = old.as_str() != new.as_str() && (p.same_page(old) || p.is_inside(old));
        assert_eq!(moved.contains_key(&p.key()), should_move, "{context}: {p}");
    }
    for ((page_key, i), (target, exists, had_text)) in &led {
        let from_before = all.iter().find(|p| &p.key() == page_key).unwrap();
        let from_after = map(from_before);
        let links = nb.links(&from_after);
        let link = &links[*i];
        let now = nb.resolve(&from_after, &link.target);
        if *exists {
            let Link::Page {
                page,
                exists: still_exists,
                ..
            } = now
            else {
                panic!("{context}: renaming {old} to {new}: a link on {from_before} to {target} now leads to {now:?}");
            };
            assert!(
                page.same_page(&map(target)),
                "{context}: renaming {old} to {new}: a link on {from_before} ({:?}) to {target} now leads to {page}, not {}",
                before[from_before.as_str()].lines().find(|l| l.contains("[[")).unwrap_or(""),
                map(target),
            );
            assert!(still_exists || !had_text, "{context}: renaming {old} to {new}: the page {target} (with text) a link on {from_before} led to is gone");
        } else {
            let original = &links_in(&before[from_before.as_str()])[*i];
            assert_eq!(
                link.target, original.target,
                "{context}: a link to a missing page was rewritten"
            );
        }
    }
    for p in &all {
        let after_name = map(p);
        let (b, a) = (&before[p.as_str()], nb.get(&after_name).unwrap());
        if report.rewritten.iter().all(|r| !r.same_page(&after_name)) {
            assert_eq!(
                a, b,
                "{context}: {p} changed though no link on it was rewritten"
            );
        } else {
            let strip = |t: &str| -> String {
                let mut ranges: Vec<(usize, usize)> = links_in(t)
                    .iter()
                    .map(|l| (l.target_start, l.target_end))
                    .collect();
                ranges.extend(
                    zim_notebook::images_in(t)
                        .iter()
                        .map(|im| (im.path_start, im.path_end)),
                );
                ranges.sort_by_key(|r| std::cmp::Reverse(r.0));
                let mut out = t.to_string();
                for (start, end) in ranges {
                    out.replace_range(start..end, "");
                }
                out
            };
            assert_eq!(
                strip(a),
                strip(b),
                "{context}: {p} changed outside link targets"
            );
        }
        // and what comes out is still a page that round-trips
        assert_eq!(
            zim_format::parse(a).serialize(),
            *a,
            "{context}: {after_name} no longer round-trips"
        );
    }

    // The files: those in the folder of the page that moved went with it (a folder is named like its
    // page), and no other file moved.
    let old_folder = format!("{}/", old.folder_path().to_lowercase());
    let renamed = old.as_str() != new.as_str();
    let map_file = |path: &str| -> String {
        if renamed && path.to_lowercase().starts_with(&old_folder) {
            let rest: Vec<&str> = path.split('/').skip(old.depth()).collect();
            format!("{}/{}", new.folder_path(), rest.join("/"))
        } else {
            path.to_string()
        }
    };
    let mut expected_files: Vec<String> = files_before.iter().map(|f| map_file(f)).collect();
    expected_files.sort_by_key(|f| f.to_lowercase());
    assert_eq!(
        nb.files().map(String::from).collect::<Vec<_>>(),
        expected_files,
        "{context}: renaming {old} to {new} left the wrong files"
    );
    let mut expected_moves: Vec<(String, String)> = files_before
        .iter()
        .filter(|f| renamed && f.to_lowercase().starts_with(&old_folder))
        .map(|f| (f.clone(), map_file(f)))
        .collect();
    expected_moves.sort_by_key(|m| m.0.to_lowercase());
    assert_eq!(
        report.files_moved, expected_moves,
        "{context}: renaming {old} to {new}: the report of moved files"
    );
    // every reference that led to a file still leads to it (as moved); the others are left as written
    for ((page_key, is_image, i), (text, target)) in &file_led {
        let from_before = all.iter().find(|p| &p.key() == page_key).unwrap();
        let from_after = map(from_before);
        let text_after = if *is_image {
            nb.images(&from_after)[*i].path.clone()
        } else {
            nb.links(&from_after)[*i].target.clone()
        };
        match target {
            FileTarget::Notebook { path, exists: true } => {
                let want = map_file(path);
                match nb.resolve_file(&from_after, &text_after) {
                    FileTarget::Notebook { path: now, exists: true } => assert_eq!(
                        now.to_lowercase(),
                        want.to_lowercase(),
                        "{context}: renaming {old} to {new}: {text:?} on {from_before} led to {path} and now ({text_after:?} on {from_after}) leads to {now}, not {want}"
                    ),
                    other => panic!("{context}: renaming {old} to {new}: {text:?} on {from_before} led to {path}; {text_after:?} on {from_after} now leads to {other:?}"),
                }
            }
            _ => assert_eq!(
                &text_after, text,
                "{context}: a reference that led to no file was rewritten"
            ),
        }
    }
    Ok(report)
}
