//! TODO(wasm): wasm32 stand-in for sync/incoming.rs.
//!
//! The real `SyncIncoming` (long-polls the API for changes, applies them to the local db inside
//! a SQL transaction) needs both a working `::api::Api` (blocking reqwest, see src/api.rs) and a
//! working `::storage::Storage` (rusqlite, see src/storage.rs) -- neither is ported to wasm32
//! yet (docs/wasm-port-plan.md decisions 2.2 storage / 2.3 networking, separate future
//! milestones), so this file is never actually used as a `Syncer` on wasm32 (see
//! `sync::start()`'s wasm32 stub in sync/mod.rs).
//!
//! It exists at all because `SyncIncoming::ignore_on_next()` is called directly from
//! src/models/user.rs regardless of target, so that one function needs a same-signature stand-in
//! here to keep the crate's public interface identical across targets.

use ::jedi::{self, Value};
use ::error::{TError, TResult};
use ::storage::Storage;
use ::models::protected::{Protected, Keyfinder};
use ::models::model::Model;
use ::models::user::User;
use ::models::keychain::KeychainEntry;
use ::models::space::Space;
use ::models::invite::Invite;
use ::models::board::Board;
use ::models::note::Note;
use ::models::file::FileData;
use ::models::sync_record::{SyncType, SyncRecord, SyncAction};
use ::sync::sync_model::MemorySaver;
use ::turtl::Turtl;
use ::std::mem;

pub struct SyncIncoming;

impl SyncIncoming {
    /// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
    pub fn ignore_on_next(_db: &mut Storage, _sync_ids: &Vec<i64>) -> TResult<()> {
        TErr!(TError::NotImplemented)
    }
}

/// Real, unmodified logic (ported verbatim from sync/incoming.rs): just plumbing around
/// `SyncIncoming::ignore_on_next()` above, which is what's actually stubbed on wasm32 -- so this
/// will correctly just log a warning (via that stub's NotImplemented error) rather than silently
/// doing nothing.
pub fn ignore_syncs_maybe(turtl: &Turtl, val_with_sync_ids: &Value, errtype: &str) {
    match jedi::get_opt::<Vec<i64>>(&["sync_ids"], val_with_sync_ids) {
        Some(x) => {
            let mut db_guard = lock!(turtl.db);
            if db_guard.is_some() {
                match SyncIncoming::ignore_on_next(db_guard.as_mut().expect("turtl::sync_incoming::ignore_syncs_maybe() -- db is None"), &x) {
                    Ok(..) => {},
                    Err(e) => warn!("{} -- error ignoring sync items: {}", errtype, e),
                }
            }
        }
        None => {}
    }
}

/// Drain and apply any queued in-memory incoming syncs.
///
/// Unlike the rest of this file's real counterpart (sync/incoming.rs), this function is genuine,
/// unmodified logic, not a stub: it only ever drains `turtl.sync_config.incoming_sync` (an
/// in-process queue), touching neither the API nor local storage directly. Since wasm32's
/// `sync::start()` never runs the real long-polling thread that would push items onto that
/// queue (see docs/wasm-port-plan.md), the queue is always empty here today -- so this loop
/// correctly no-ops -- but the moment a wasm32-side sync producer exists, this same code will
/// apply its items correctly with no further changes needed.
pub fn process_incoming_sync(turtl: &Turtl) -> TResult<()> {
    let sync_incoming_queue = {
        let sync_config_guard = lockr!(turtl.sync_config);
        sync_config_guard.incoming_sync.clone()
    };
    loop {
        let sync_incoming_lock = turtl.incoming_sync_lock.lock();
        let sync_item = match sync_incoming_queue.try_pop() {
            Some(x) => x,
            None => break,
        };
        fn mem_save<T>(turtl: &Turtl, mut sync_item: SyncRecord) -> TResult<()>
            where T: Protected + MemorySaver + Keyfinder
        {
            let model = if &sync_item.action == &SyncAction::Delete {
                let mut model: T = Default::default();
                model.set_id(sync_item.item_id.clone());
                model
            } else {
                let mut data = Value::Null;
                match sync_item.data.as_mut() {
                    Some(x) => mem::swap(&mut data, x),
                    None => return TErr!(TError::MissingData(format!("sync item missing `data` field."))),
                }
                let mut model: T = jedi::from_val(data)?;
                if model.should_deserialize_on_mem_update() {
                    turtl.find_model_key(&mut model)?;
                    model.deserialize()?;
                }
                model
            };
            model.run_mem_update(turtl, sync_item.action.clone())?;
            Ok(())
        }
        match sync_item.ty.clone() {
            SyncType::User => mem_save::<User>(turtl, sync_item)?,
            SyncType::Keychain => mem_save::<KeychainEntry>(turtl, sync_item)?,
            SyncType::Space => mem_save::<Space>(turtl, sync_item)?,
            SyncType::Board => mem_save::<Board>(turtl, sync_item)?,
            SyncType::Note => mem_save::<Note>(turtl, sync_item)?,
            SyncType::File => mem_save::<FileData>(turtl, sync_item)?,
            SyncType::Invite => mem_save::<Invite>(turtl, sync_item)?,
            _ => (),
        }
        drop(sync_incoming_lock);
    }
    Ok(())
}
