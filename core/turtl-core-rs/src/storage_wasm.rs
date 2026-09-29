//! TODO(wasm): wasm32 stand-in for storage.rs.
//!
//! The real `Storage` (src/storage.rs) wraps `rusqlite`/`dumpy` -- real native SQLite, which has
//! no `wasm32-unknown-unknown` build story via this path (see docs/wasm-port-plan.md §1). The
//! real wasm32 storage backend is `sqlite-wasm-rs` (decision 2.2), its own future milestone, same
//! shape as the crypto PoC already landed at core/wasm-crypto-poc -- not attempted here.
//!
//! This file exists so that everything *downstream* of `Storage` (sync_model.rs, profile.rs, and
//! practically every model in src/models/) keeps compiling unchanged: they only ever call
//! `Storage`'s public, generic methods, never touch `rusqlite`/`dumpy` types directly, so as long
//! as this stub preserves those method signatures, none of that code needs to know or care that
//! there's no real backend yet. Every method returns `TError::NotImplemented`.

use ::jedi::Value;
use ::error::{TError, TResult};
use ::models::protected::Protected;
use ::models::storable::Storable;

/// Given a db filename, return the full path we'll use for the db file.
///
/// Unlike the rest of this file, this is real, unmodified logic (ported verbatim from
/// storage.rs): it's pure path/string handling with no SQLite involved, so it works as-is.
pub fn db_location(db_name: &String) -> TResult<String> {
    if cfg!(test) {
        return Ok(String::from(":memory:"))
    }
    let data_folder = ::config::get::<String>(&["data_folder"])?;
    let db_location = if data_folder == ":memory:" {
        String::from(":memory:")
    } else {
        format!("{}/{}.sqlite", data_folder, db_name)
    };
    Ok(db_location)
}

/// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md. Real storage doesn't exist
/// yet on wasm32, so there's no client id to persist/read.
pub fn setup_client_id(_storage: ::std::sync::Arc<::std::sync::RwLock<Storage>>) -> TResult<()> {
    TErr!(TError::NotImplemented)
}

/// This structure holds state for persisting (encrypted) data to disk.
///
/// TODO(wasm): a zero-sized placeholder -- the real struct's `conn`/`dumpy` fields are
/// rusqlite/dumpy types, neither a wasm32 dependency (see module docs above). Nothing on wasm32
/// constructs a working `Storage` yet (`Storage::new()` below always errors), so there's nothing
/// to store here.
pub struct Storage;

impl Storage {
    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn new(_location: &String, _schema: Value) -> TResult<Storage> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn save<T>(&self, _model: &T) -> TResult<()>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    #[allow(dead_code)]
    pub fn get<T>(&self, _table: &str, _id: &String) -> TResult<Option<T>>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn delete<T>(&self, _model: &T) -> TResult<()>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn all_limit<T>(&self, _table: &str, _limit: Option<i32>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn all<T>(&self, table: &str) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        self.all_limit(table, None)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn find<T>(&self, _table: &str, _index: &str, _vals: &Vec<String>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn by_id<T>(&self, _table: &str, _ids: &Vec<String>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn kv_get(&self, _key: &str) -> TResult<Option<String>> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn kv_set(&self, _key: &str, _val: &String) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn kv_delete(&self, _key: &str) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }

    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn close(&mut self) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }
}

// NOTE: no manual `Sync` impl needed here (unlike the real storage.rs's `unsafe impl Sync for
// Storage {}`) -- this is a zero-field placeholder struct, so it's already `Send + Sync`
// automatically; an explicit impl would conflict with that auto-derivation.
