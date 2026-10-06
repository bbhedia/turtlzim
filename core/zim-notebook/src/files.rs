//! Files in a notebook: attachments, and the images and links that refer to them.
//!
//! Zim keeps a page's attachments in the folder named like the page: `Usage/GTD_flowchart.png` is
//! an attachment of the page `Usage`, and `Help/Export/a.png` one of `Help:Export` (the same folder
//! holds the page's sub-pages, which are the `.txt` files in it). A reference to a file in a page
//! (`{{./a.png}}`, `[[../report.pdf]]`) is a path relative to *that folder*: `./a.png` is in it,
//! `../a.png` is in the folder above, where the page's own text file is. Zim's own manual does
//! exactly this (its `Usage:Getting Things Done` shows `{{../GTD_flowchart.png}}`, which is
//! `Usage/GTD_flowchart.png`). A path that starts with `/` or `~`, names a drive or a share, or is
//! an address is not in the notebook.
//!
//! This module knows paths and what refers to them, never the bytes of a file: those are for a
//! storage backend. Paths are notebook-relative, with `/` between folders, compared without regard
//! to case (like page names) and kept as spelled.

use std::fmt;

use zim_format::inline::parse_image;
use zim_format::{highlight, SpanKind};

use crate::name::PageName;

/// What the file rules can ask a notebook about its files.
pub trait FileSet {
    /// The file at `path` (compared without regard to case), as spelled in the notebook.
    fn find_file(&self, path: &str) -> Option<String>;
}

/// Where a file reference leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileTarget {
    /// A path in the notebook (as the notebook spells it, if there is such a file), and whether
    /// there is one.
    Notebook { path: String, exists: bool },
    /// Not in the notebook: an absolute path, `~/...`, a drive or share, an address, or a path that
    /// goes up past the top of the notebook.
    Outside,
}

/// Why a path can't be a file in a notebook.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileError {
    pub path: String,
    pub reason: &'static str,
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?} can't be a file in a notebook: it {}.",
            self.path, self.reason
        )
    }
}

impl std::error::Error for FileError {}

/// The longest a single name in a path may be, in bytes (what most file systems allow).
const MAX_NAME_BYTES: usize = 255;

/// Whether `path` can be the path of a file in a notebook: relative, with every part a real name
/// (not empty, not `.` or `..`, not hidden, no control characters, no backslash).
pub fn check_file_path(path: &str) -> Result<(), FileError> {
    let bad = |reason| {
        Err(FileError {
            path: path.to_string(),
            reason,
        })
    };
    if path.is_empty() {
        return bad("is empty");
    }
    if path.starts_with('/') {
        return bad("has to be relative to the notebook");
    }
    if path.contains('\\') {
        return bad("has a backslash");
    }
    for part in path.split('/') {
        if part.is_empty() {
            return bad("has an empty part");
        }
        if part == "." || part == ".." {
            return bad("has a . or .. part");
        }
        if part.starts_with('.') {
            return bad("is hidden (a part starts with a dot)");
        }
        if part.chars().any(char::is_control) {
            return bad("has a control character");
        }
        if part.len() > MAX_NAME_BYTES {
            return bad("has a name that is too long");
        }
    }
    Ok(())
}

/// Whether a file reference is relative to the page's folder (rather than to the file system root,
/// a home folder, a drive, a share or an address).
fn is_relative(target: &str) -> bool {
    if target.is_empty() || target.starts_with(['/', '\\', '~']) {
        return false;
    }
    let bytes = target.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false; // `C:\...`
    }
    if let Some(at) = target.find("://") {
        if target[..at]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        {
            return false; // `https://...`, `file://...`, `smb://...`
        }
    }
    true
}

/// `relative` applied to the folder `base`: `.` stays, `..` goes up. `None` if that goes above the
/// top of the notebook, or leaves nothing.
fn join(base: &[&str], relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.to_vec();
    for part in relative.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// `text` with its `%XX` escapes decoded, if it has any and they make valid UTF-8.
fn percent_decode(text: &str) -> Option<String> {
    if !text.contains('%') {
        return None;
    }
    let bytes = text.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out)
        .ok()
        .filter(|decoded| decoded != text)
}

/// Where the file reference `target`, written on page `from`, leads, given the files that exist.
/// A path with `%20`-style escapes is looked up as written first, then decoded.
pub fn resolve_file(from: &PageName, target: &str, files: &dyn FileSet) -> FileTarget {
    let target = target.trim();
    if !is_relative(target) {
        return FileTarget::Outside;
    }
    let folder = from.folder_path();
    let base: Vec<&str> = folder.split('/').collect();
    let Some(path) = join(&base, target) else {
        return FileTarget::Outside;
    };
    if let Some(found) = files.find_file(&path) {
        return FileTarget::Notebook {
            path: found,
            exists: true,
        };
    }
    if let Some(decoded) = percent_decode(target) {
        if let Some(found) = join(&base, &decoded).and_then(|p| files.find_file(&p)) {
            return FileTarget::Notebook {
                path: found,
                exists: true,
            };
        }
    }
    FileTarget::Notebook {
        path,
        exists: false,
    }
}

/// The text that, written on page `from` as a file reference, leads to `path`: `./name` for a file
/// in the page's folder (or just `name`, with `dot_prefix` false), `../name` for one in the folder
/// above, and so on. Checked by [`resolve_file`] to lead where it should.
pub fn relative_file_text(from: &PageName, path: &str, dot_prefix: bool) -> String {
    let folder = from.folder_path();
    let base: Vec<&str> = folder.split('/').collect();
    let target: Vec<&str> = path.split('/').collect();
    let dir = &target[..target.len() - 1];
    let mut common = 0;
    while common < base.len()
        && common < dir.len()
        && base[common].to_lowercase() == dir[common].to_lowercase()
    {
        common += 1;
    }
    let ups = base.len() - common;
    let rest = target[common..].join("/");
    if ups > 0 {
        format!("{}{rest}", "../".repeat(ups))
    } else if dot_prefix {
        format!("./{rest}")
    } else {
        rest
    }
}

/// What to call a file attached under the name `wanted`: the last part of it, with anything that
/// would break the syntax of a link or an image (`/ \ ? # | [ ] { } < > : * " %` and control
/// characters) replaced by `_`, no leading dot (that would hide it) and no trailing dot or space,
/// and not too long. Never empty.
pub fn safe_file_name(wanted: &str) -> String {
    let last = wanted.rsplit(['/', '\\']).next().unwrap_or(wanted);
    let replaced: String = last
        .chars()
        .map(|c| {
            if c.is_control() || "?#|[]{}<>:*\"%".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        return "file".to_string();
    }
    if trimmed.len() <= 120 {
        return trimmed.to_string();
    }
    // Too long: keep the end (the extension), cut the middle of the name.
    let (stem, extension) = match trimmed.rfind('.') {
        Some(dot) if trimmed.len() - dot <= 16 => (&trimmed[..dot], &trimmed[dot..]),
        _ => (trimmed, ""),
    };
    let mut keep = 120 - extension.len();
    while !stem.is_char_boundary(keep) {
        keep -= 1;
    }
    format!("{}{extension}", stem[..keep].trim_end())
}

/// `name` made different from every name `taken` says is in use: `a.png`, `a 2.png`, `a 3.png`.
pub fn unique_file_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot <= 16 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem} {n}{extension}"))
        .find(|candidate| !taken(candidate))
        .expect("some number is free")
}

/// One `{{image}}` in a page's text. Offsets are bytes into the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageRef {
    /// The whole image, braces included.
    pub start: usize,
    pub end: usize,
    /// The path text: what is replaced when the image is retargeted.
    pub path_start: usize,
    pub path_end: usize,
    pub path: String,
    /// The `?key=value&flag` tokens after the path, as written (see `zim_format::Image`).
    pub query: Vec<(String, Option<String>)>,
    /// The text after the last `|`.
    pub alt: Option<String>,
}

impl ImageRef {
    /// The value of the query parameter `key` (compared without regard to case), if it has one.
    pub fn param(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .and_then(|(_, v)| v.as_deref())
    }
}

/// The `{{images}}` in `text`, in order. (`{{id: name}}` anchors are not images.)
pub fn images_in(text: &str) -> Vec<ImageRef> {
    highlight(text)
        .iter()
        .filter(|s| s.kind == SpanKind::Image)
        .map(|s| {
            let inner_start = s.start + 2;
            let image = parse_image(&text[inner_start..s.end - 2]);
            ImageRef {
                start: s.start,
                end: s.end,
                path_start: inner_start,
                path_end: inner_start + image.path.len(),
                path: image.path,
                query: image.query,
                alt: image.alt,
            }
        })
        .collect()
}
