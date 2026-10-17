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

/// The page of a day, `Journal:2026:10:09`, or nothing if there is no such day.
#[wasm_bindgen(js_name = journalPage)]
pub fn journal_page(year: u32, month: u32, day: u32) -> Option<String> {
    nb::Day::new(year, month, day).map(|d| d.page().to_string())
}

/// The day a page is the page of, as `[year, month, day]`, or nothing if it is not one.
#[wasm_bindgen(js_name = journalDayOf)]
pub fn journal_day_of(page: &str) -> Option<Vec<u32>> {
    let name = nb::PageName::parse(page).ok()?;
    nb::Day::of_page(&name).map(|d| vec![d.year, d.month, d.day])
}

/// What a day is called at the top of its page (`Friday 09 October 2026`), or nothing if there is no such day.
#[wasm_bindgen(js_name = journalTitle)]
pub fn journal_title(year: u32, month: u32, day: u32) -> Option<String> {
    nb::Day::new(year, month, day).map(|d| d.title())
}

/// The text a new page of a day starts with (see `newPageText`), or nothing if there is no such day.
#[wasm_bindgen(js_name = journalPageText)]
pub fn journal_page_text(year: u32, month: u32, day: u32, created: &str) -> Option<String> {
    nb::Day::new(year, month, day).map(|d| d.page_text(created))
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

/// The `{{images}}` in a text, as JSON `[{start, end, pathStart, pathEnd, path, query, alt}]` with
/// offsets in UTF-16 units; `query` is `[[key, value or null], ...]` as written after the `?`.
#[wasm_bindgen(js_name = imagesIn)]
pub fn images_in(text: &str) -> String {
    let at = utf16_offsets(text);
    J::Arr(
        nb::images_in(text)
            .into_iter()
            .map(|i| {
                J::Obj(vec![
                    ("start", J::Num(at[i.start])),
                    ("end", J::Num(at[i.end])),
                    ("pathStart", J::Num(at[i.path_start])),
                    ("pathEnd", J::Num(at[i.path_end])),
                    ("path", s(i.path)),
                    (
                        "query",
                        J::Arr(
                            i.query
                                .into_iter()
                                .map(|(k, v)| J::Arr(vec![s(k), opt(v)]))
                                .collect(),
                        ),
                    ),
                    ("alt", opt(i.alt)),
                ])
            })
            .collect(),
    )
    .render()
}

/// What to call a file that people call `wanted`, so that it is safe to write in a link or an image
/// (no `/ \ ? # | [ ] { } < > : * " %`, no leading dot) and never empty.
#[wasm_bindgen(js_name = safeFileName)]
pub fn safe_file_name(wanted: &str) -> String {
    nb::safe_file_name(wanted)
}

/// Why `path` can't be the path of a file in a notebook, or nothing if it can.
#[wasm_bindgen(js_name = checkFilePath)]
pub fn check_file_path(path: &str) -> Option<String> {
    nb::check_file_path(path).err().map(|e| e.to_string())
}

/// The text that, written on page `from` as a file reference, leads to the file at `path` (a
/// notebook path): `./a.png`, `../a.png`, ... Throws if `from` isn't a valid page name.
#[wasm_bindgen(js_name = relativeFileText)]
pub fn relative_file_text(from: &str, path: &str, dot_prefix: bool) -> Result<String, JsError> {
    Ok(nb::relative_file_text(&name(from)?, path, dot_prefix))
}

fn file_target_json(target: &nb::FileTarget) -> J {
    match target {
        nb::FileTarget::Notebook { path, exists } => J::Obj(vec![
            ("kind", s("notebook")),
            ("path", s(path.as_str())),
            ("exists", J::Bool(*exists)),
        ]),
        nb::FileTarget::Outside => J::Obj(vec![("kind", s("outside"))]),
    }
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

    /// The days of a month that have a journal page (with text), as day numbers in order.
    #[wasm_bindgen(js_name = journalDays)]
    pub fn journal_days(&self, year: u32, month: u32) -> Vec<u32> {
        self.inner.journal_days(year, month)
    }

    /// Every `@tag` written in the notebook with the pages that write it, as JSON `[{name, pages}]`,
    /// by the tag's name (case ignored; `name` is spelled as the first page that has it spells it).
    pub fn tags(&self) -> String {
        J::Arr(
            self.inner
                .tags()
                .into_iter()
                .map(|t| {
                    J::Obj(vec![
                        ("name", s(t.name)),
                        ("pages", J::Arr(t.pages.iter().map(|p| s(p.as_str())).collect())),
                    ])
                })
                .collect(),
        )
        .render()
    }

    /// The pages that write the tag (with or without its `@`, in any case), in name order.
    #[wasm_bindgen(js_name = pagesWithTag)]
    pub fn pages_with_tag(&self, tag: &str) -> Vec<String> {
        self.inner.pages_with_tag(tag).iter().map(|p| p.to_string()).collect()
    }

    /// The tags a page writes, each once, in the order they first appear, as written there.
    #[wasm_bindgen(js_name = tagsOf)]
    pub fn tags_of(&self, page: &str) -> Vec<String> {
        match nb::PageName::parse(page) {
            Ok(n) => self.inner.tags_of(&n),
            Err(_) => Vec::new(),
        }
    }

    /// The pages that the link being typed on page `from`, `[[typed`, can be completed to, best first, at most
    /// `limit`, as JSON `[{page, link, exists}]`: `link` is what to write between the brackets to lead there from
    /// `from`, `exists` whether the page has text of its own (a section only holds other pages).
    #[wasm_bindgen(js_name = completeLink)]
    pub fn complete_link(&self, from: &str, typed: &str, limit: usize) -> Result<String, JsError> {
        let from = name(from)?;
        Ok(J::Arr(
            self.inner
                .complete_link(&from, typed, limit)
                .into_iter()
                .map(|c| J::Obj(vec![("page", s(c.page.as_str())), ("link", s(c.link)), ("exists", J::Bool(c.has_page))]))
                .collect(),
        )
        .render())
    }

    /// Pages whose name or text contains every word of `query`, and that write every `@tag` in it,
    /// best first, as JSON `[{page, snippet, inName}]`.
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

    // ---- files (attachments): their paths only; the bytes are for the store

    /// Record a file at `path` (relative to the notebook, `/` between folders). Throws, with a
    /// message ready to show, if it can't be a file in a notebook.
    #[wasm_bindgen(js_name = putFile)]
    pub fn put_file(&mut self, path: &str) -> Result<(), JsError> {
        self.inner
            .put_file(path)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Forget the file at `path`. Whether there was one.
    #[wasm_bindgen(js_name = removeFile)]
    pub fn remove_file(&mut self, path: &str) -> bool {
        self.inner.remove_file(path)
    }

    #[wasm_bindgen(js_name = hasFile)]
    pub fn has_file(&self, path: &str) -> bool {
        self.inner.has_file(path)
    }

    /// The path of a file as the notebook spells it (paths ignore case), if there is one.
    #[wasm_bindgen(js_name = filePath)]
    pub fn file_path(&self, path: &str) -> Option<String> {
        self.inner.file_path(path).map(str::to_string)
    }

    /// Every file, in path order.
    pub fn files(&self) -> Vec<String> {
        self.inner.files().map(str::to_string).collect()
    }

    #[wasm_bindgen(js_name = fileCount)]
    pub fn file_count(&self) -> usize {
        self.inner.file_count()
    }

    /// The files in the folder named like `page`: its attachments.
    #[wasm_bindgen(js_name = filesOf)]
    pub fn files_of(&self, page: &str) -> Vec<String> {
        nb::PageName::parse(page).map_or_else(|_| Vec::new(), |n| self.inner.files_of(&n))
    }

    /// The files in the folder named like `page` and in all folders below it.
    #[wasm_bindgen(js_name = filesBelow)]
    pub fn files_below(&self, page: &str) -> Vec<String> {
        nb::PageName::parse(page).map_or_else(|_| Vec::new(), |n| self.inner.files_below(&n))
    }

    /// Forget the files `filesBelow` lists, and return them (what goes when a page is deleted).
    #[wasm_bindgen(js_name = removeFilesBelow)]
    pub fn remove_files_below(&mut self, page: &str) -> Vec<String> {
        match nb::PageName::parse(page) {
            Ok(n) => self.inner.remove_files_below(&n),
            Err(_) => Vec::new(),
        }
    }

    /// Where a file reference (the path of an image, or of a `[[./file]]` link) written on page
    /// `from` leads, as JSON: `{kind: "notebook", path, exists}` or `{kind: "outside"}`.
    #[wasm_bindgen(js_name = resolveFile)]
    pub fn resolve_file(&self, from: &str, target: &str) -> Result<String, JsError> {
        Ok(file_target_json(&self.inner.resolve_file(&name(from)?, target)).render())
    }

    /// The path for a new attachment of `page` that people call `wanted`: in the page's folder,
    /// with a safe name that is not in use. Throws if `page` isn't a valid page name.
    #[wasm_bindgen(js_name = attachmentPath)]
    pub fn attachment_path(&self, page: &str, wanted: &str) -> Result<String, JsError> {
        self.inner
            .attachment_path(&name(page)?, wanted)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// The text that, written on `from` as a file reference, leads to the file at `path`.
    #[wasm_bindgen(js_name = fileLink)]
    pub fn file_link(&self, from: &str, path: &str) -> Result<String, JsError> {
        Ok(self.inner.file_link(&name(from)?, path))
    }

    /// Work out moving `page` to the notebook `dest` as `newName` (with what lies below it if `withSubpages`, otherwise the page alone and the files of its own folder), and change nothing, here or
    /// there. JSON `{pages: [{from, to, text}], files: [[from, to]], incoming: [{from, count, context}], leavingLinks, linksChanged}`: the pages that go with the text each has
    /// there (links among them written for their new names), the files that go with them, the pages that stay and link to what goes, how many links and pictures of what goes lead to
    /// something that stays, and how many links were written again. Throws, with a message ready to show, if there is nothing to move or if something in `dest` is in the way.
    #[wasm_bindgen(js_name = planMove)]
    pub fn plan_move(&self, page: &str, new_name: &str, with_subpages: bool, dest: &Notebook) -> Result<String, JsError> {
        let plan = self
            .inner
            .plan_move(&name(page)?, &name(new_name)?, with_subpages, &dest.inner)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(J::Obj(vec![
            (
                "pages",
                J::Arr(
                    plan.pages
                        .iter()
                        .map(|m| J::Obj(vec![("from", s(m.from.as_str())), ("to", s(m.to.as_str())), ("text", s(m.text.as_str()))]))
                        .collect(),
                ),
            ),
            ("files", J::Arr(plan.files.iter().map(|(from, to)| J::Arr(vec![s(from.as_str()), s(to.as_str())])).collect())),
            (
                "incoming",
                J::Arr(
                    plan.incoming
                        .iter()
                        .map(|b| J::Obj(vec![("from", s(b.from.as_str())), ("count", J::Num(b.count)), ("context", s(b.context.as_str()))]))
                        .collect(),
                ),
            ),
            ("leavingLinks", J::Num(plan.leaving_links)),
            ("linksChanged", J::Num(plan.links_changed)),
        ])
        .render())
    }

    /// Move a page and everything below it; with `updateLinks`, rewrite links so that every one
    /// still leads where it did. JSON `{moved: [[from, to]], rewritten: [page], linksChanged,
    /// filesMoved: [[from, to]]}` (the files of the pages moved go with them).
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
            (
                "filesMoved",
                J::Arr(
                    report
                        .files_moved
                        .iter()
                        .map(|(from, to)| J::Arr(vec![s(from.as_str()), s(to.as_str())]))
                        .collect(),
                ),
            ),
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

    #[test]
    #[allow(clippy::ok_expect)]
    fn the_shape_of_a_plan_to_move_a_page_to_another_notebook() {
        let mut src = Notebook::new();
        src.put("Garden", "see [[+Beans]] {{./plan.png}}").ok().expect("ok");
        src.put("Garden:Beans", "beans").ok().expect("ok");
        src.put("Home", "[[Garden]]").ok().expect("ok");
        src.put_file("Garden/plan.png").ok().expect("ok");
        let dest = Notebook::new();
        let plan = src.plan_move("Garden", "Plants", true, &dest).ok().expect("a plan");
        assert_eq!(
            plan,
            r#"{"pages":[{"from":"Garden","to":"Plants","text":"see [[+Beans]] {{./plan.png}}"},{"from":"Garden:Beans","to":"Plants:Beans","text":"beans"}],"files":[["Garden/plan.png","Plants/plan.png"]],"incoming":[{"from":"Home","count":1,"context":"Garden"}],"leavingLinks":0,"linksChanged":0}"#
        );
        assert_eq!(src.len(), 3, "a plan changes nothing");
        assert!(dest.is_empty());
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
            nb.complete_link("Start", "lin", 5).ok().expect("ok"),
            r#"[{"page":"Help:Links","link":"Help:Links","exists":true}]"#
        );
        assert_eq!(nb.complete_link("Help", "+", 5).ok().expect("ok"), r#"[{"page":"Help:Links","link":"+Links","exists":true}]"#);
        assert_eq!(nb.complete_link("Start", "nothing like it", 5).ok().expect("ok"), "[]");
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
            r#"{"moved":[["Help:Links","Help:Linking"]],"rewritten":["Help","Start"],"linksChanged":2,"filesMoved":[]}"#
        );
        assert!(nb.has("Help:Linking") && !nb.has("Help:Links"));
        assert!(nb.get("Start").unwrap().contains("[[Help:Linking]]"));
        assert_eq!(nb.remove_tree("Help"), ["Help", "Help:Linking"]);
        assert_eq!(nb.names(), ["Start"]);
    }

    #[test]
    #[allow(clippy::ok_expect)]
    fn files_cross_as_paths_and_a_rename_moves_them() {
        let mut nb = sample();
        for path in ["Help/Links/a.png", "Help/b.pdf", "top.png"] {
            nb.put_file(path).ok().expect("a valid path");
        }
        // (the error for a path that can't be a file is a JsError, which exists only in the browser:
        // the web package's tests cover it)
        assert_eq!(nb.file_count(), 3);
        assert_eq!(nb.files_of("Help"), ["Help/b.pdf"]);
        assert_eq!(nb.files_below("help"), ["Help/b.pdf", "Help/Links/a.png"]);
        assert_eq!(nb.file_path("HELP/B.PDF").as_deref(), Some("Help/b.pdf"));
        assert_eq!(
            nb.resolve_file("Help:Links", "./a.png").ok().expect("ok"),
            r#"{"kind":"notebook","path":"Help/Links/a.png","exists":true}"#
        );
        assert_eq!(
            nb.resolve_file("Help:Links", "../b.pdf").ok().expect("ok"),
            r#"{"kind":"notebook","path":"Help/b.pdf","exists":true}"#
        );
        assert_eq!(
            nb.resolve_file("Help:Links", "./nope.png").ok().expect("ok"),
            r#"{"kind":"notebook","path":"Help/Links/nope.png","exists":false}"#
        );
        assert_eq!(
            nb.resolve_file("Help:Links", "/etc/hosts").ok().expect("ok"),
            r#"{"kind":"outside"}"#
        );
        assert_eq!(
            nb.attachment_path("Help:Links", "a.png").ok().expect("ok"),
            "Help/Links/a 2.png"
        );
        assert_eq!(
            nb.file_link("Help:Links", "Help/b.pdf").ok().expect("ok"),
            "../b.pdf"
        );
        let report = nb.rename("Help", "Docs", true).ok().expect("ok");
        assert!(report.ends_with(
            r#""filesMoved":[["Help/b.pdf","Docs/b.pdf"],["Help/Links/a.png","Docs/Links/a.png"]]}"#
        ));
        assert_eq!(nb.files(), ["Docs/b.pdf", "Docs/Links/a.png", "top.png"]);
        assert_eq!(nb.remove_files_below("Docs"), ["Docs/b.pdf", "Docs/Links/a.png"]);
        assert_eq!(nb.files(), ["top.png"]);
        assert!(nb.remove_file("TOP.png"));
        assert_eq!(check_file_path("a/../b").as_deref().map(|m| m.contains("..")), Some(true));
        assert_eq!(check_file_path("a/b.png"), None);
        assert_eq!(safe_file_name("a/b?.png"), "b_.png");
    }

    #[test]
    fn images_are_reported_in_utf16_units() {
        let text = "😀 {{./a b.png?width=20&x|Alt}} and {{id: here}} {{../c.png}}\n";
        assert_eq!(
            images_in(text),
            r#"[{"start":3,"end":31,"pathStart":5,"pathEnd":14,"path":"./a b.png","query":[["width","20"],["x",null]],"alt":"Alt"},{"start":49,"end":61,"pathStart":51,"pathEnd":59,"path":"../c.png","query":[],"alt":null}]"#
        );
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
