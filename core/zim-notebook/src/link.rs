//! Links: what a `[[target]]` means, and where it leads.
//!
//! The rules are Zim's (its manual, "Links"):
//!
//! * `https://...`, `mailto:...` and other `scheme://` targets are addresses; a target containing
//!   `/` or `\` is a file; one starting with `#` is a place on the same page (`#heading-id`); one
//!   containing `?` is an interwiki link (`wp?wiki`).
//! * Everything else is a page. `:Foo:Bar` starts from the top of the notebook; `+Bar` is a sub-page
//!   of the page the link is in; and a plain `Bar` is looked up *beside the page, then beside each
//!   of its parents*: it names the first page of that name found going up from the page's own
//!   section. For a link in `Zim:Examples:Linking:Relative`, `Absolute` is
//!   `Zim:Examples:Linking:Absolute`, and `Examples:Calendar` is `Zim:Examples:Calendar`: only the
//!   first part (`Examples`) is searched for in the sections above, the rest follows it.
//! * `Page#id` leads to a heading or anchor inside that page.
//!
//! A link to a page that doesn't exist yet still says which page it means (the one that would be
//! created: beside the page holding the link, unless its first part was found higher up).

use crate::name::{NameError, PageName};
use zim_format::{highlight, SpanKind};

/// What a notebook can tell the link rules about its pages.
pub trait PageSet {
    /// The page or section called `name` (compared without regard to case), as spelled in the
    /// notebook, if there is one. A section counts even if it has no text of its own, as long as
    /// pages lie below it.
    fn find(&self, name: &PageName) -> Option<PageName>;
}

impl<F: Fn(&PageName) -> Option<PageName>> PageSet for F {
    fn find(&self, name: &PageName) -> Option<PageName> {
        self(name)
    }
}

/// The kind of thing a link target is, which doesn't depend on any notebook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    Page,
    /// A heading or anchor on the page holding the link.
    Anchor,
    Url,
    File,
    Email,
    Interwiki,
    Invalid,
}

/// Where a link leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    /// A page, which may not exist yet (`exists` says), and a place in it.
    Page {
        page: PageName,
        exists: bool,
        anchor: Option<String>,
    },
    /// A place on the same page: a heading id or an anchor name.
    Anchor(String),
    Url(String),
    /// As written (`./pictures/a.png`, `~/notes`, `/etc/hosts`, `file:///tmp/x`).
    File(String),
    /// A `mailto:` address.
    Email(String),
    /// `key?page`: the page `page` on the site called `key`.
    Interwiki {
        key: String,
        page: String,
    },
    /// Not a link that can be followed, and why.
    Invalid(String),
}

impl Link {
    pub fn kind(&self) -> LinkKind {
        match self {
            Link::Page { .. } => LinkKind::Page,
            Link::Anchor(_) => LinkKind::Anchor,
            Link::Url(_) => LinkKind::Url,
            Link::File(_) => LinkKind::File,
            Link::Email(_) => LinkKind::Email,
            Link::Interwiki { .. } => LinkKind::Interwiki,
            Link::Invalid(_) => LinkKind::Invalid,
        }
    }
}

/// The scheme of `target` if it begins with `scheme:` (letters, digits, `+`, `-`, `.`).
fn scheme(target: &str) -> Option<&str> {
    let colon = target.find(':')?;
    let name = &target[..colon];
    let mut chars = name.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)))
        .then_some(name)
}

fn is_email_address(target: &str) -> bool {
    let Some((local, domain)) = target.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._%+-".contains(c))
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// What kind of target `target` is. (Whether a page link leads anywhere is for [`resolve`].)
pub fn classify(target: &str) -> LinkKind {
    let t = target.trim();
    if t.is_empty() {
        return LinkKind::Invalid;
    }
    // A leading ':' or '+' makes a page link whatever follows; a page name can't look like an address.
    if t.starts_with(':') || t.starts_with('+') {
        return LinkKind::Page;
    }
    if let Some(s) = scheme(t) {
        if s.eq_ignore_ascii_case("mailto") {
            return LinkKind::Email;
        }
        if t[s.len() + 1..].starts_with("//") {
            return if s.eq_ignore_ascii_case("file") {
                LinkKind::File
            } else {
                LinkKind::Url
            };
        }
    }
    if t.contains('/') || t.contains('\\') {
        return LinkKind::File;
    }
    if t.starts_with('#') {
        return LinkKind::Anchor;
    }
    if t.contains('?') {
        return LinkKind::Interwiki;
    }
    if is_email_address(t) {
        return LinkKind::Email;
    }
    LinkKind::Page
}

/// Where the link `target`, written on page `from`, leads, given the pages that exist.
pub fn resolve(from: &PageName, target: &str, pages: &dyn PageSet) -> Link {
    let t = target.trim();
    match classify(t) {
        LinkKind::Invalid => Link::Invalid("An empty link leads nowhere.".to_string()),
        LinkKind::Url => Link::Url(t.to_string()),
        LinkKind::File => Link::File(t.to_string()),
        LinkKind::Email => {
            let address = if scheme(t).is_some_and(|s| s.eq_ignore_ascii_case("mailto")) {
                t.to_string()
            } else {
                format!("mailto:{t}")
            };
            Link::Email(address)
        }
        LinkKind::Anchor => Link::Anchor(t[1..].trim().to_string()),
        LinkKind::Interwiki => {
            let (key, page) = t.split_once('?').unwrap_or((t, ""));
            if key.is_empty() {
                Link::Invalid("An interwiki link needs a name before the ?.".to_string())
            } else {
                Link::Interwiki {
                    key: key.to_string(),
                    page: page.to_string(),
                }
            }
        }
        LinkKind::Page => resolve_page(from, t, pages),
    }
}

/// `name`, with the spelling of whichever of its leading parts exist in the notebook.
fn canonical(name: PageName, pages: &dyn PageSet) -> (PageName, bool) {
    if let Some(found) = pages.find(&name) {
        return (found, true);
    }
    for n in (1..name.depth()).rev() {
        if let Some(found) = pages.find(&name.prefix(n)) {
            let rest: Vec<&str> = name.levels().skip(n).collect();
            if let Ok(joined) = found.child(&rest.join(":")) {
                return (joined, false);
            }
        }
    }
    (name, false)
}

fn resolve_page(from: &PageName, target: &str, pages: &dyn PageSet) -> Link {
    let (path, anchor) = match target.split_once('#') {
        Some((path, anchor)) => (
            path.trim(),
            Some(anchor.trim().to_string()).filter(|a| !a.is_empty()),
        ),
        None => (target.trim(), None),
    };
    let invalid = |e: NameError| Link::Invalid(e.to_string());

    let (page, exists) = if let Some(rest) = path.strip_prefix(':') {
        match PageName::parse(rest) {
            Ok(name) => canonical(name, pages),
            Err(e) => return invalid(e),
        }
    } else if let Some(rest) = path.strip_prefix('+') {
        match from.child(rest) {
            Ok(name) => canonical(name, pages),
            Err(e) => return invalid(e),
        }
    } else {
        let relative = match PageName::parse(path) {
            Ok(name) => name,
            Err(e) => return invalid(e),
        };
        let first = relative.prefix(1);
        let rest: Vec<&str> = relative.levels().skip(1).collect();
        // The sections above the page, nearest first, ending with the top of the notebook.
        let mut found = None;
        for depth in (0..from.depth()).rev() {
            let candidate = if depth == 0 {
                Some(first.clone())
            } else {
                from.prefix(depth).child(first.as_str()).ok()
            };
            if let Some(hit) = candidate.and_then(|c| pages.find(&c)) {
                found = Some(hit);
                break;
            }
        }
        let start = match found {
            Some(hit) => hit,
            // Nothing by that name above: the page would be created beside the one holding the link.
            None => match from.parent() {
                Some(section) => match section.child(first.as_str()) {
                    Ok(name) => name,
                    Err(e) => return invalid(e),
                },
                None => first,
            },
        };
        let full = if rest.is_empty() {
            Ok(start)
        } else {
            start.child(&rest.join(":"))
        };
        match full {
            Ok(name) => canonical(name, pages),
            Err(e) => return invalid(e),
        }
    };
    Link::Page {
        page,
        exists,
        anchor,
    }
}

/// The shortest link text that, written on page `from`, leads to page `to` (which may not exist
/// yet) in the notebook as it is now. It is checked, not guessed: whatever is returned resolves to
/// `to`. A sub-page is `+Sub`; otherwise the shortest tail of the name that resolves correctly
/// (`Sibling`, `Section:Page`); and `:Full:Name` as the last resort, which always does.
pub fn link_to(from: &PageName, to: &PageName, pages: &dyn PageSet) -> String {
    let leads_to = |text: &str| matches!(resolve(from, text, pages), Link::Page { ref page, .. } if page.same_page(to));
    if to.is_inside(from) {
        let rest: Vec<&str> = to.levels().skip(from.depth()).collect();
        let candidate = format!("+{}", rest.join(":"));
        if leads_to(&candidate) {
            return candidate;
        }
    }
    for start in (0..to.depth()).rev() {
        let candidate = to.levels().skip(start).collect::<Vec<_>>().join(":");
        if leads_to(&candidate) {
            return candidate;
        }
    }
    format!(":{to}")
}

/// The id Zim gives a heading, for a link such as `#link-to-a-heading` to find it: the text in
/// lower case, spaces as `-`, everything that isn't a letter, digit, `_` or `-` dropped.
pub fn heading_id(text: &str) -> String {
    let mut id = String::new();
    let mut pending_dash = false;
    for c in text.trim().chars() {
        if c.is_whitespace() {
            pending_dash = !id.is_empty();
        } else if c.is_alphanumeric() || c == '_' || c == '-' {
            if pending_dash {
                id.push('-');
                pending_dash = false;
            }
            id.extend(c.to_lowercase());
        }
    }
    id
}

/// One `[[link]]` in a page's text. Offsets are bytes into the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRef {
    /// The whole link, brackets included.
    pub start: usize,
    pub end: usize,
    /// The target text: what is replaced when a link is rewritten.
    pub target_start: usize,
    pub target_end: usize,
    pub target: String,
    pub display: Option<String>,
}

/// The `[[links]]` in `text`, in order.
pub fn links_in(text: &str) -> Vec<LinkRef> {
    let spans = highlight(text);
    let mut links = Vec::new();
    for (i, link) in spans
        .iter()
        .enumerate()
        .filter(|(_, s)| s.kind == SpanKind::Link)
    {
        let mut target = None;
        let mut display = None;
        for span in spans[i + 1..].iter().take_while(|s| s.start < link.end) {
            match span.kind {
                SpanKind::LinkTarget if target.is_none() => target = Some((span.start, span.end)),
                SpanKind::LinkDisplay if display.is_none() => {
                    display = Some(text[span.start..span.end].to_string())
                }
                _ => {}
            }
        }
        // A link with no target text (`[[|text]]`, `[[]]`) has an empty target right after `[[`.
        let (target_start, target_end) = target.unwrap_or((link.start + 2, link.start + 2));
        links.push(LinkRef {
            start: link.start,
            end: link.end,
            target_start,
            target_end,
            target: text[target_start..target_end].to_string(),
            display,
        });
    }
    links
}

/// A place a link can lead to inside a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchorRef {
    /// The id to put after `#`: a heading's [`heading_id`], or the name in `{{id: name}}`.
    pub id: String,
    /// Where it is in the text (a byte offset).
    pub at: usize,
}

/// The headings and `{{id: ...}}` anchors of `text`, in order.
pub fn anchors_in(text: &str) -> Vec<AnchorRef> {
    let mut anchors = Vec::new();
    for span in highlight(text) {
        match span.kind {
            SpanKind::Heading => {
                let bars = 7 - span.detail as usize;
                let inner = &text[span.start + bars + 1..span.end - bars - 1];
                let id = heading_id(inner);
                if !id.is_empty() {
                    anchors.push(AnchorRef { id, at: span.start });
                }
            }
            SpanKind::Anchor => {
                let name = text[span.start + 5..span.end - 2].trim();
                if !name.is_empty() {
                    anchors.push(AnchorRef {
                        id: name.to_string(),
                        at: span.start,
                    });
                }
            }
            _ => {}
        }
    }
    anchors
}
