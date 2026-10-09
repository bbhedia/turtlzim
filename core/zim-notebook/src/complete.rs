//! Completing a link that is being typed: the pages `[[Gar` may lead to, best first, each with the text to write for it.

use crate::name::PageName;
use crate::notebook::Notebook;

/// A page that the link being typed can lead to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkSuggestion {
    pub page: PageName,
    /// What to write between the brackets, on the page the link is typed on, to lead here: the shortest text that does
    /// (see `Notebook::link_to`).
    pub link: String,
    /// Whether the page has text of its own; a section only holds other pages.
    pub has_page: bool,
}

/// What the start of a link says about where to look.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Where {
    /// `Gar`: any page, the name or any part of it.
    Anywhere,
    /// `:Projects:Gar`: from the top of the notebook, so the start of a whole name.
    Top,
    /// `+Gar`: below the page the link is typed on, named from there.
    Below,
}

/// How well a name (its parts, in lower case) answers what was typed (lower case): lower is better, `None` is not at all.
fn rank(parts: &[String], typed: &str, at: Where) -> Option<u8> {
    if typed.is_empty() {
        return Some(5);
    }
    let whole = parts.join(":");
    if at == Where::Top {
        // (the nearer the top, and then the earlier in the alphabet, the better: that is how ties go, and the name that is
        // exactly what was typed comes before the longer ones that start with it)
        return whole.starts_with(typed).then_some(0);
    }
    let last = parts.last()?;
    if last == typed {
        Some(0)
    } else if last.starts_with(typed) {
        Some(1)
    } else if whole.starts_with(typed) {
        Some(2)
    } else if parts.iter().any(|part| part.starts_with(typed)) {
        Some(3)
    } else if whole.contains(typed) {
        Some(4)
    } else {
        None
    }
}

impl Notebook {
    /// The pages (and sections, which only hold pages) that the link `[[typed` written on page `from` can be completed to,
    /// the best first, at most `limit` of them: those whose last name is what was typed, then those that start with it, then
    /// those whose whole name does, then those with a part that does, then those that have it somewhere. Ties go to the
    /// page nearer the top of the notebook, then to the name. Case is ignored. `+typed` looks only below `from`
    /// (named from there), `:typed` only for a name that starts with it; nothing is offered for what has a bracket in it
    /// (it can't be written in a link's target; a `#` or `|` is in no page's name, so it finds nothing by itself). A page is
    /// not offered a link to itself.
    pub fn complete_link(&self, from: &PageName, typed: &str, limit: usize) -> Vec<LinkSuggestion> {
        let typed = typed.trim();
        if typed.contains(['[', ']']) {
            return Vec::new();
        }
        let (at, wanted) = match typed.chars().next() {
            Some('+') => (Where::Below, &typed[1..]),
            Some(':') => (Where::Top, &typed[1..]),
            _ => (Where::Anywhere, typed),
        };
        let wanted = wanted.trim_start().to_lowercase();
        let mut found = Vec::new();
        for node in self.tree() {
            if node.name.same_page(from) || (at == Where::Below && !node.name.is_inside(from)) {
                continue;
            }
            let skip = if at == Where::Below { from.depth() } else { 0 };
            let parts: Vec<String> = node.name.levels().skip(skip).map(str::to_lowercase).collect();
            if let Some(rank) = rank(&parts, &wanted, at) {
                found.push((rank, node.depth, node.name.key(), node));
            }
        }
        found.sort_by(|a, b| (a.0, a.1, &a.2).cmp(&(b.0, b.1, &b.2)));
        found
            .into_iter()
            .take(limit)
            .map(|(_, _, _, node)| LinkSuggestion { link: self.link_to(from, &node.name), has_page: node.has_page, page: node.name })
            .collect()
    }
}
