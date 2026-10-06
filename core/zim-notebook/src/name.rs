//! Page names.
//!
//! A page is called by its place in the notebook's hierarchy: `Projects:Garden:Plan` is the page
//! `Plan` below `Garden` below `Projects`. The rules are Zim's (its manual, "Pages"): `:` separates
//! the levels, and `? # / \ * " < > | %` may not appear in a name, because they mean something in
//! the wiki syntax or can't be written to common file systems.
//!
//! Names compare **without regard to case** (`help:links` is `Help:Links`; two files whose names
//! differ only in case could not live side by side on a case-insensitive file system), but keep the
//! spelling they were given. An underscore is a space: a file called `Auto_Formatting.txt` is the
//! page `Auto Formatting`, and the other way round, so a name never contains one.

use std::fmt;

/// Characters that may not appear in a page name (besides `:`, which separates the levels).
pub const FORBIDDEN: &[char] = &['?', '#', '/', '\\', '*', '"', '<', '>', '|', '%'];

/// Longest a single level of a name may be, in bytes: file systems allow 255 bytes per name, and
/// `.txt` has to fit as well, with room to spare.
const MAX_COMPONENT_BYTES: usize = 200;
const MAX_NAME_BYTES: usize = 1000;

/// A valid page name. Always canonical: levels joined by `:`, each trimmed, none empty.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PageName(String);

/// Why a name was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameError {
    Empty,
    /// Two colons in a row, or a colon at an end where the level beside it is empty.
    EmptyLevel,
    Forbidden(char),
    Control,
    /// A level starting with a dot would be a hidden file (and `..` would leave the folder).
    LeadingDot,
    TooLong,
    /// A path that isn't a page file (it doesn't end in `.txt`).
    NotAPageFile,
}

impl fmt::Display for NameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NameError::Empty => write!(f, "A page name can't be empty."),
            NameError::EmptyLevel => {
                write!(f, "A page name can't have an empty part between colons.")
            }
            NameError::Forbidden(c) => write!(
                f,
                "A page name can't contain {c:?}. These characters are not allowed: {}",
                FORBIDDEN
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
            NameError::Control => write!(f, "A page name can't contain control characters."),
            NameError::LeadingDot => write!(f, "A part of a page name can't start with a dot."),
            NameError::TooLong => write!(f, "That page name is too long."),
            NameError::NotAPageFile => write!(f, "Not a page file: page files end in .txt."),
        }
    }
}

impl std::error::Error for NameError {}

impl PageName {
    /// Read a name. A leading or trailing `:` (the marks of an absolute link or a section, as in
    /// `:Journal:`) is accepted and dropped, each level is trimmed, and underscores become spaces.
    pub fn parse(input: &str) -> Result<PageName, NameError> {
        let trimmed = input.trim();
        let trimmed = trimmed.strip_prefix(':').unwrap_or(trimmed);
        let trimmed = trimmed.strip_suffix(':').unwrap_or(trimmed);
        if trimmed.trim().is_empty() {
            return Err(NameError::Empty);
        }
        let mut levels = Vec::new();
        for level in trimmed.split(':') {
            let level = level.replace('_', " ");
            let level = level.trim();
            if level.is_empty() {
                return Err(NameError::EmptyLevel);
            }
            if let Some(c) = level.chars().find(|c| FORBIDDEN.contains(c)) {
                return Err(NameError::Forbidden(c));
            }
            if level.chars().any(|c| c.is_control()) {
                return Err(NameError::Control);
            }
            if level.starts_with('.') {
                return Err(NameError::LeadingDot);
            }
            if level.len() > MAX_COMPONENT_BYTES {
                return Err(NameError::TooLong);
            }
            levels.push(level.to_string());
        }
        let name = levels.join(":");
        if name.len() > MAX_NAME_BYTES {
            return Err(NameError::TooLong);
        }
        Ok(PageName(name))
    }

    /// The name as text, levels separated by `:`.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The levels, outermost first.
    pub fn levels(&self) -> impl DoubleEndedIterator<Item = &str> {
        self.0.split(':')
    }

    /// How many levels the name has (1 for a page at the top).
    pub fn depth(&self) -> usize {
        self.0.matches(':').count() + 1
    }

    /// The last level: what the page is called inside its section.
    pub fn last(&self) -> &str {
        self.0.rsplit(':').next().unwrap_or(&self.0)
    }

    /// The section the page is in, or `None` for a page at the top.
    pub fn parent(&self) -> Option<PageName> {
        self.0
            .rsplit_once(':')
            .map(|(parent, _)| PageName(parent.to_string()))
    }

    /// The name with its first `n` levels, `n >= 1`.
    pub fn prefix(&self, n: usize) -> PageName {
        let n = n.clamp(1, self.depth());
        PageName(self.levels().take(n).collect::<Vec<_>>().join(":"))
    }

    /// A page below this one: `Foo` + `Bar:Baz` is `Foo:Bar:Baz`.
    pub fn child(&self, relative: &str) -> Result<PageName, NameError> {
        // Nothing after the colon is not "this page" (parse would accept a trailing colon).
        if relative.trim().is_empty() {
            return Err(NameError::Empty);
        }
        PageName::parse(&format!("{}:{}", self.0, relative))
    }

    /// The comparison key: the name in lower case.
    pub fn key(&self) -> String {
        self.0.to_lowercase()
    }

    /// Whether the two names are the same page (case aside).
    pub fn same_page(&self, other: &PageName) -> bool {
        self.0 == other.0 || self.key() == other.key()
    }

    /// Whether this page is below `ancestor` (strictly: a page is not inside itself).
    pub fn is_inside(&self, ancestor: &PageName) -> bool {
        let (mine, theirs) = (self.key(), ancestor.key());
        mine.len() > theirs.len()
            && mine.starts_with(&theirs)
            && mine[theirs.len()..].starts_with(':')
    }

    /// Where the page's text lives in a notebook folder: levels become folders, spaces become
    /// underscores, and `.txt` is added: `Help:Auto Formatting` is `Help/Auto_Formatting.txt`.
    pub fn to_path(&self) -> String {
        format!("{}.txt", self.folder_path())
    }

    /// The folder named like the page, which holds its sub-pages and its attachments.
    pub fn folder_path(&self) -> String {
        self.levels()
            .map(|l| l.replace(' ', "_"))
            .collect::<Vec<_>>()
            .join("/")
    }

    /// The page a `.txt` file in a notebook folder holds (a path relative to the notebook, with
    /// `/` between folders). Fails for anything that isn't a page file or has an invalid name.
    pub fn from_path(path: &str) -> Result<PageName, NameError> {
        let without = path.strip_suffix(".txt").ok_or(NameError::NotAPageFile)?;
        Self::from_folder_path(without)
    }

    /// The page a folder in a notebook folder stands for (a section, even with no text of its own).
    pub fn from_folder_path(path: &str) -> Result<PageName, NameError> {
        if path.contains(':') {
            // A colon in a file name can't be a level separator: the file wasn't made by a notebook.
            return Err(NameError::Forbidden(':'));
        }
        PageName::parse(&path.replace('/', ":"))
    }
}

impl fmt::Display for PageName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
