//! Zim notebook semantics, as pure logic.
//!
//! A notebook is a set of pages with names, and files (attachments) in folders named like them.
//! This crate knows what the names mean (`name`), where a link leads (`link`), where a reference
//! to a file leads and what to call a new attachment (`files`), and, for a whole notebook, the
//! page tree, backlinks, search and renames that keep every link and every reference to a file
//! pointing at the same page or file (`notebook`). It does no I/O: a storage backend (a folder of
//! `.txt` files, a database in the browser, encrypted records) feeds it pages and the paths of
//! files (never their bytes), so the same rules serve every shell. Page text is parsed with
//! `zim-format`.

pub mod complete;
pub mod files;
pub mod journal;
pub mod link;
pub mod name;
pub mod notebook;
pub mod tags;

pub use complete::LinkSuggestion;
pub use files::{check_file_path, images_in, relative_file_text, resolve_file, safe_file_name, unique_file_name, FileError, FileSet, FileTarget, ImageRef};
pub use link::{anchors_in, classify, heading_id, link_to, links_in, resolve, AnchorRef, Link, LinkKind, LinkRef, PageSet};
pub use journal::{days_in_month, is_leap_year, Day, JOURNAL};
pub use name::{NameError, PageName, FORBIDDEN};
pub use notebook::{new_page_text, Backlink, Hit, MovePlan, MovedPage, Notebook, RenameError, RenameReport, TagInfo, TreeNode};
pub use tags::{tag_key, tags_in, TagRef};
