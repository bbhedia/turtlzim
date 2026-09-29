//! TODO(wasm): wasm32 stand-in for search.rs.
//!
//! The real `Search` wraps `clouseau` (its own real-SQLite FTS4 index, see the `clouseau`
//! crate/its `rusqlite` dependency) -- same "no wasm32-unknown-unknown build story" problem as
//! storage.rs, and explicitly the *hardest* part of the storage story per
//! docs/wasm-port-plan.md §1 ("clouseau + src/search.rs ... is not representable in IndexedDB
//! without hand-building a full-text search engine from scratch"). The real fix is the same
//! `sqlite-wasm-rs` migration as storage.rs (decision 2.2), a future milestone -- not attempted
//! here.
//!
//! `Query` is plain, storage-independent data (a serde struct with no SQL involved), so it's
//! duplicated here verbatim rather than stubbed, keeping `dispatch.rs`'s "profile:search"-style
//! commands type-checking unchanged. Every `Search` method returns `TError::NotImplemented`.

use ::error::{TError, TResult};
use ::models::note::Note;

/// A query builder
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Query {
    pub text: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    pub space_id: String,
    #[serde(default)]
    pub boards: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub exclude_tags: Vec<String>,
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub url: Option<String>,
    pub has_file: Option<bool>,
    pub color: Option<i32>,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub sort_direction: String,
    #[serde(default)]
    pub page: i32,
    #[serde(default)]
    pub per_page: i32,
}

/// TODO(wasm): a placeholder -- see module docs above. Nothing on wasm32 constructs a working
/// `Search` yet (`Search::new()` below always errors).
pub struct Search;

impl Search {
    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn new() -> TResult<Search> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn index_note(&mut self, _note: &Note) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn unindex_note(&mut self, _note: &Note) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn reindex_note(&mut self, _note: &Note) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn find(&self, _query: &Query) -> TResult<(Vec<String>, i32)> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn find_tags(&self, _query: &Query) -> TResult<Vec<(String, i32)>> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    #[allow(dead_code)]
    pub fn tags_by_notes(&self, _note_ids: &Vec<String>) -> TResult<Vec<(String, i32)>> {
        TErr!(TError::NotImplemented)
    }
}
