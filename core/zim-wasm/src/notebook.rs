//! A notebook for JavaScript: the rules of `zim-notebook`, behind a handle and a few free functions.
//!
//! Page names and link targets cross as strings and results as small JSON texts (the web package
//! parses them into typed objects). A name that isn't valid is an exception whose message says what
//! to fix, ready to show a person; queries about a name that isn't valid simply find nothing.

use wasm_bindgen::prelude::*;
use zim_format::utf16_offsets;
use zim_notebook as nb;

use crate::json::{opt, s, J};

fn name(input: &str) -> Result<nb::PageName, JsError> {
    nb::PageName::parse(input).map_err(|e| JsError::new(&e.to_string()))
}

fn kind_name(kind: nb::LinkKind) -> &'static str {
    match kind {
        nb::LinkKind::Page => "page",
        nb::LinkKind::Anchor => "anchor",
        nb::LinkKind::Url => "url",
        nb::LinkKind::File => "file",
        nb::LinkKind::Email => "email",
        nb::LinkKind::Interwiki => "interwiki",
        nb::LinkKind::Invalid => "invalid",
    }
}

fn link_json(link: &nb::Link) -> J {
    let kind = ("kind", s(kind_name(link.kind())));
    match link {
        nb::Link::Page {
            page,
            exists,
            anchor,
        } => J::Obj(vec![
            kind,
            ("page", s(page.as_str())),
            ("exists", J::Bool(*exists)),
            ("anchor", opt(anchor.clone())),
        ]),
        nb::Link::Anchor(anchor) => J::Obj(vec![kind, ("anchor", s(anchor.as_str()))]),
        nb::Link::Url(url) => J::Obj(vec![kind, ("url", s(url.as_str()))]),
        nb::Link::File(path) => J::Obj(vec![kind, ("path", s(path.as_str()))]),
        nb::Link::Email(address) => J::Obj(vec![kind, ("address", s(address.as_str()))]),
        nb::Link::Interwiki { key, page } => J::Obj(vec![
            kind,
            ("key", s(key.as_str())),
            ("page", s(page.as_str())),
        ]),
        nb::Link::Invalid(reason) => J::Obj(vec![kind, ("reason", s(reason.as_str()))]),
    }
}

/// The name as the notebook would write it (levels trimmed, underscores as spaces, a leading or
/// trailing colon dropped). Throws, with a message fit for the person typing it, if it isn't a
/// valid page name.
#[wasm_bindgen(js_name = parsePageName)]
pub fn parse_page_name(input: &str) -> Result<String, JsError> {
    Ok(name(input)?.to_string())
}

/// The key a page is filed under: its name in lower case, which is what makes two spellings of a
/// name the same page. Throws if the name isn't valid.
#[wasm_bindgen(js_name = pageKey)]
pub fn page_key(input: &str) -> Result<String, JsError> {
    Ok(name(input)?.key())
}

/// What kind of target a link target is, without a notebook to look in: `"page"`, `"anchor"`,
/// `"url"`, `"file"`, `"email"`, `"interwiki"` or `"invalid"`.
#[wasm_bindgen(js_name = classifyLink)]
pub fn classify_link(target: &str) -> String {
    kind_name(nb::classify(target)).to_string()
}

/// The id a heading has for `#links` to find it.
#[wasm_bindgen(js_name = headingId)]
pub fn heading_id(text: &str) -> String {
    nb::heading_id(text)
}

/// Where a page is kept in a notebook folder: `Help:Auto Formatting` is `Help/Auto_Formatting.txt`.
#[wasm_bindgen(js_name = pageToPath)]
pub fn page_to_path(page: &str) -> Result<String, JsError> {
    Ok(name(page)?.to_path())
}

/// The page a `.txt` file in a notebook folder holds. Throws for anything that isn't a page file.
#[wasm_bindgen(js_name = pathToPage)]
pub fn path_to_page(path: &str) -> Result<String, JsError> {
    nb::PageName::from_path(path)
        .map(|n| n.to_string())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// The text of a new page, as Zim starts one (header and title); `created` is a time such as
/// `2026-10-06T09:41:03+02:00`.
#[wasm_bindgen(js_name = newPageText)]
pub fn new_page_text(page: &str, created: &str) -> Result<String, JsError> {
    Ok(nb::new_page_text(&name(page)?, created))
}

/// The `[[links]]` in a text, as JSON `[{start, end, targetStart, targetEnd, target, display}]`
/// with offsets in UTF-16 units (positions in a JavaScript string).
#[wasm_bindgen(js_name = linksIn)]
pub fn links_in(text: &str) -> String {
    let at = utf16_offsets(text);
    J::Arr(
        nb::links_in(text)
            .into_iter()
            .map(|l| {
                J::Obj(vec![
                    ("start", J::Num(at[l.start])),
                    ("end", J::Num(at[l.end])),
                    ("targetStart", J::Num(at[l.target_start])),
                    ("targetEnd", J::Num(at[l.target_end])),
                    ("target", s(l.target)),
                    ("display", opt(l.display)),
                ])
            })
            .collect(),
    )
    .render()
}

/// The headings and `{{id: ...}}` anchors of a text, as JSON `[{id, at}]` (`at` in UTF-16 units):
/// the places a `[[#id]]` link can lead to.
#[wasm_bindgen(js_name = anchorsIn)]
pub fn anchors_in(text: &str) -> String {
    let at = utf16_offsets(text);
    J::Arr(
        nb::anchors_in(text)
            .into_iter()
            .map(|a| J::Obj(vec![("id", s(a.id)), ("at", J::Num(at[a.at]))]))
            .collect(),
    )
    .render()
}

/// A notebook: pages by name, and what follows from them. Call `free()` when done with it.
#[wasm_bindgen]
pub struct Notebook {
    inner: nb::Notebook,
}

impl Default for Notebook {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Notebook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Notebook {
        Notebook {
            inner: nb::Notebook::new(),
        }
    }

    /// Set a page's text, creating the page if there is none. Throws if the name isn't valid.
    pub fn put(&mut self, page: &str, text: &str) -> Result<(), JsError> {
        self.inner.put(&name(page)?, text);
        Ok(())
    }

    /// The text of a page, if it has any.
    pub fn get(&self, page: &str) -> Option<String> {
        self.inner
            .get(&nb::PageName::parse(page).ok()?)
            .map(str::to_string)
    }

    /// Whether the page has text.
    pub fn has(&self, page: &str) -> bool {
        nb::PageName::parse(page).is_ok_and(|n| self.inner.has_page(&n))
    }

    /// The page or section called this (ignoring case), spelled as the notebook spells it.
    pub fn find(&self, page: &str) -> Option<String> {
        use nb::PageSet;
        self.inner
            .find(&nb::PageName::parse(page).ok()?)
            .map(|n| n.to_string())
    }

    /// Remove a page (what lies below it stays). Whether there was one.
    pub fn remove(&mut self, page: &str) -> bool {
        nb::PageName::parse(page).is_ok_and(|n| self.inner.remove(&n))
    }

    /// Remove a page and everything below it. The names removed.
    #[wasm_bindgen(js_name = removeTree)]
    pub fn remove_tree(&mut self, page: &str) -> Vec<String> {
        match nb::PageName::parse(page) {
            Ok(n) => self
                .inner
                .remove_tree(&n)
                .into_iter()
                .map(|n| n.to_string())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// How many pages have text.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Every page with text, in name order.
    pub fn names(&self) -> Vec<String> {
        self.inner.names().map(|n| n.to_string()).collect()
    }

    /// The tree of pages and sections in display order, as JSON
    /// `[{name, depth, hasPage, children}]`.
    pub fn tree(&self) -> String {
        J::Arr(
            self.inner
                .tree()
                .into_iter()
                .map(|n| {
                    J::Obj(vec![
                        ("name", s(n.name.as_str())),
                        ("depth", J::Num(n.depth)),
                        ("hasPage", J::Bool(n.has_page)),
                        ("children", J::Num(n.children)),
                    ])
                })
                .collect(),
        )
        .render()
    }

    /// Where the link `target`, written on page `from`, leads, as JSON: `{kind: "page", page,
    /// exists, anchor}`, `{kind: "anchor", anchor}`, `{kind: "url", url}`, `{kind: "file", path}`,
    /// `{kind: "email", address}`, `{kind: "interwiki", key, page}` or `{kind: "invalid", reason}`.
    pub fn resolve(&self, from: &str, target: &str) -> Result<String, JsError> {
        Ok(link_json(&self.inner.resolve(&name(from)?, target)).render())
    }

    /// The shortest link text that, written on `from`, leads to `to`.
    #[wasm_bindgen(js_name = linkTo)]
    pub fn link_to(&self, from: &str, to: &str) -> Result<String, JsError> {
        Ok(self.inner.link_to(&name(from)?, &name(to)?))
    }

    /// The pages whose links lead to this one, as JSON `[{from, count, context}]`.
    pub fn backlinks(&self, page: &str) -> String {
        let found = match nb::PageName::parse(page) {
            Ok(n) => self.inner.backlinks(&n),
            Err(_) => Vec::new(),
        };
        J::Arr(
            found
                .into_iter()
                .map(|b| {
                    J::Obj(vec![
                        ("from", s(b.from.as_str())),
                        ("count", J::Num(b.count)),
                        ("context", s(b.context)),
                    ])
                })
                .collect(),
        )
        .render()
    }

    /// Pages whose name or text contains every word of `query`, best first, as JSON
    /// `[{page, snippet, inName}]`.
    pub fn search(&self, query: &str, limit: usize) -> String {
        J::Arr(
            self.inner
                .search(query, limit)
                .into_iter()
                .map(|h| {
                    J::Obj(vec![
                        ("page", s(h.page.as_str())),
                        ("snippet", s(h.snippet)),
                        ("inName", J::Bool(h.in_name)),
                    ])
                })
                .collect(),
        )
        .render()
    }

    /// Move a page and everything below it; with `updateLinks`, rewrite links so that every one
    /// still leads where it did. JSON `{moved: [[from, to]], rewritten: [page], linksChanged}`.
    /// Throws, with a message ready to show, if the rename can't be done (and changes nothing).
    pub fn rename(&mut self, old: &str, new: &str, update_links: bool) -> Result<String, JsError> {
        let report = self
            .inner
            .rename(&name(old)?, &name(new)?, update_links)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(J::Obj(vec![
            (
                "moved",
                J::Arr(
                    report
                        .moved
                        .iter()
                        .map(|(from, to)| J::Arr(vec![s(from.as_str()), s(to.as_str())]))
                        .collect(),
                ),
            ),
            (
                "rewritten",
                J::Arr(report.rewritten.iter().map(|n| s(n.as_str())).collect()),
            ),
            ("linksChanged", J::Num(report.links_changed)),
        ])
        .render())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::ok_expect)]
    fn sample() -> Notebook {
        let mut nb = Notebook::new();
        for (page, text) in [
            ("Help", "====== Help ======\nsee [[+Links]]\n"),
            (
                "Help:Links",
                "back to [[Help]] and [[Start]] and [[nowhere]] and [[https://example.org]]\n",
            ),
            ("Start", "go to [[Help:Links]]\n"),
        ] {
            nb.put(page, text).ok().expect("a valid name");
        }
        nb
    }

    // `JsError` isn't `Debug`, so these tests take the `Ok` of each result with `.ok().expect()`.
    #[test]
    #[allow(clippy::ok_expect)]
    fn the_shapes_javascript_receives() {
        let nb = sample();
        assert_eq!(
            (nb.len(), nb.is_empty(), nb.names()),
            (
                3,
                false,
                ["Help", "Help:Links", "Start"].map(String::from).to_vec()
            )
        );
        assert_eq!(
            nb.get("help:links").unwrap().lines().next().unwrap(),
            "back to [[Help]] and [[Start]] and [[nowhere]] and [[https://example.org]]"
        );
        assert_eq!(nb.find("HELP").as_deref(), Some("Help"));
        assert_eq!(
            nb.get("not a : valid * name"),
            None,
            "an invalid name finds nothing"
        );
        assert_eq!(
            nb.tree(),
            r#"[{"name":"Help","depth":0,"hasPage":true,"children":1},{"name":"Help:Links","depth":1,"hasPage":true,"children":0},{"name":"Start","depth":0,"hasPage":true,"children":0}]"#
        );
        assert_eq!(
            nb.resolve("Help:Links", "Start").ok().expect("ok"),
            r#"{"kind":"page","page":"Start","exists":true,"anchor":null}"#
        );
        assert_eq!(
            nb.resolve("Help:Links", "nowhere#top").ok().expect("ok"),
            r#"{"kind":"page","page":"Help:nowhere","exists":false,"anchor":"top"}"#
        );
        assert_eq!(
            nb.resolve("Help", "https://example.org").ok().expect("ok"),
            r#"{"kind":"url","url":"https://example.org"}"#
        );
        assert_eq!(
            nb.resolve("Help", "#x").ok().expect("ok"),
            r#"{"kind":"anchor","anchor":"x"}"#
        );
        assert_eq!(
            nb.link_to("Start", "Help:Links").ok().expect("ok"),
            "Help:Links"
        );
        assert_eq!(
            nb.backlinks("Help"),
            r#"[{"from":"Help:Links","count":1,"context":"back to Help and Start and nowhere and https://example.org"}]"#
        );
        assert_eq!(
            nb.search("example", 5),
            r#"[{"page":"Help:Links","snippet":"back to Help and Start and nowhere and https://example.org","inName":false}]"#
        );
    }

    #[test]
    #[allow(clippy::ok_expect)]
    fn a_rename_reports_what_it_did() {
        let mut nb = sample();
        let report = nb
            .rename("Help:Links", "Help:Linking", true)
            .ok()
            .expect("ok");
        assert_eq!(
            report,
            r#"{"moved":[["Help:Links","Help:Linking"]],"rewritten":["Help","Start"],"linksChanged":2}"#
        );
        assert!(nb.has("Help:Linking") && !nb.has("Help:Links"));
        assert!(nb.get("Start").unwrap().contains("[[Help:Linking]]"));
        assert_eq!(nb.remove_tree("Help"), ["Help", "Help:Linking"]);
        assert_eq!(nb.names(), ["Start"]);
    }

    #[test]
    fn positions_are_in_utf16_units() {
        let text = "😀 see [[Zü]] and {{id: spot}}\n====== Ö ======\n";
        // the smiley is two UTF-16 units but four bytes, so every byte offset after it is two too big
        assert_eq!(
            links_in(text),
            r#"[{"start":7,"end":13,"targetStart":9,"targetEnd":11,"target":"Zü","display":null}]"#
        );
        assert_eq!(
            anchors_in(text),
            r#"[{"id":"spot","at":18},{"id":"ö","at":31}]"#
        );
        assert_eq!(classify_link("wp?x"), "interwiki");
        assert_eq!(heading_id("Link to a heading"), "link-to-a-heading");
    }
}
