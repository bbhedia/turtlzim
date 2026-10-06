//! Zim notebook semantics, as pure logic.
//!
//! A notebook is a set of pages with names. This crate knows what the names mean (`name`), where
//! a link leads (`link`), and, for a whole notebook, the page tree, backlinks, search and renames
//! that keep every link pointing at the same page (`notebook`). It does no I/O: a storage backend
//! (a folder of `.txt` files, a database in the browser, encrypted records) feeds it pages, so the
//! same rules serve every shell. Page text is parsed with `zim-format`.

pub mod link;
pub mod name;
pub mod notebook;

pub use link::{anchors_in, classify, heading_id, link_to, links_in, resolve, AnchorRef, Link, LinkKind, LinkRef, PageSet};
pub use name::{NameError, PageName, FORBIDDEN};
pub use notebook::{new_page_text, Backlink, Hit, Notebook, RenameError, RenameReport, TreeNode};
