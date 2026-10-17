//! Dispatch takes messages sent from our wonderful UI and runs the needed core
//! code to generate the response. Essentially, it's the RPC endpoint for core.
//!
//! Each message sent in is in the following format (JSON):
//! 
//!     ["<message id>", "<command>", arg1, arg2, ...]
//!
//! where the arg\* can be any valid JSON object. The Message ID is passed in
//! when responding so the client knows which request we are responding to.

use ::jedi::{self, Value};
use crate::error::{TResult, TError};
use ::config;
use crate::util::logger;
use crate::util::exec;
use crate::turtl::Turtl;
use crate::seal;
use crate::search::Query;
use crate::profile::{Profile, Export, ImportMode};
use crate::models::model::Model;
use crate::models::protected::Protected;
use crate::models::user::User;
use crate::models::space::Space;
use crate::models::space_member::SpaceMember;
use crate::models::note::Note;
use crate::models::invite::{Invite, InviteRequest};
use crate::models::file::FileData;
use crate::models::sync_record::{SyncAction, SyncType, SyncRecord};
use crate::models::feedback::Feedback;
#[cfg(not(target_arch = "wasm32"))]
use ::clippo::{self, CustomParser};
use crate::sync::sync_model;
use crate::sync;
use crate::messaging::{self, Event};
#[cfg(not(target_arch = "wasm32"))]
use ::migrate;
use crate::crypto::{self, Key};
use crate::vault_backup;

/// The commands a core that runs without a server (`local_only`) answers. Every other is for a core with a
/// server: it would talk to the server, or hand out something secret (the master key in a login token, the
/// private key), or change what the core talks to. It is refused before it runs, whoever asks: a page's
/// scripts can send the core any message they like, and the page's policy can't be counted on to keep what
/// the core sends from going anywhere (it doesn't reach a Worker unless the host sends it there).
pub(crate) const LOCAL_COMMANDS: &[&str] = &[
    "ping",
    "user:join",
    "user:login",
    "user:logout",
    "user:local-accounts",
    "user:change-passphrase",
    "vault:backup:make",
    "vault:backup:read",
    "vault:backup:drop",
    "vault:restore:write",
    "vault:restore:commit",
    "vault:restore:cancel",
    "seal:master:status",
    "seal:master:make",
    "seal:master:wrap",
    "seal:master:unwrap",
    "seal:master:forget",
    "seal:objects:seal",
    "seal:objects:open",
    "seal:index:seal",
    "seal:index:open",
    "profile:load",
    "profile:batch:begin",
    "profile:batch:commit",
    "profile:batch:rollback",
    "profile:sync:model",
    "profile:get-notes",
    "profile:find-notes",
    "profile:find-tags",
    "profile:note:get-file",
    "app:shutdown",
];

/// The most a piece of a backup that the host asks for may be: a piece is a message, which is made into text.
const MAX_BACKUP_PIECE: usize = 8 << 20;

/// The commands for a vault are for a core without a server: another has no vault.
fn local_only_or_refuse(turtl: &Turtl, cmd: &str) -> TResult<()> {
    if turtl.local_only {
        return Ok(());
    }
    TErr!(TError::PermissionDenied(format!("`{}` is a command of a core without a server", cmd)))
}

/// The user, as the host is told of it. A core without a server tells its host nothing it can do without:
/// not the user's private key (what the host needs is who is logged in, and that the passphrase was right).
fn user_for_host(turtl: &Turtl, user: &User) -> TResult<Value> {
    let mut data = jedi::to_val(user)?;
    if turtl.local_only {
        if let Value::Object(fields) = &mut data {
            fields.remove("privkey");
        }
    }
    Ok(data)
}

/// Does our actual message dispatching
async fn dispatch(cmd: &String, turtl: &Turtl, data: Value) -> TResult<Value> {
    if turtl.local_only && !LOCAL_COMMANDS.contains(&cmd.as_str()) {
        return TErr!(TError::PermissionDenied(format!("`{}` is not a command of a core that runs without a server", cmd)));
    }
    match cmd.as_ref() {
        "user:login" => {
            let username: String = jedi::get(&["2"], &data)?;
            let password: String = jedi::get(&["3"], &data)?;
            turtl.login(username, password).await?;
            let user_guard = lockr!(turtl.user);
            user_for_host(turtl, &user_guard)
        }
        "user:login-from-token" => {
            let token: String = jedi::get(&["2"], &data)?;
            turtl.login_token(token).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
        }
        "user:login-from-saved" => {
            let user_id: String = jedi::get(&["2"], &data)?;
            let key: Key = jedi::get(&["3"], &data)?;
            let token = User::restore_login(turtl, user_id, key)?;
            turtl.login_token(token).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
        }
        "user:join" => {
            let username: String = jedi::get(&["2"], &data)?;
            let password: String = jedi::get(&["3"], &data)?;
            turtl.join(username, password).await?;
            let user_guard = lockr!(turtl.user);
            user_for_host(turtl, &user_guard)
        }
        #[cfg(not(target_arch = "wasm32"))]
        "user:can-migrate" => {
            let old_username: String = jedi::get(&["2"], &data)?;
            let old_password: String = jedi::get(&["3"], &data)?;
            match migrate::check_login(&old_username, &old_password) {
                Ok(x) => {
                    match x {
                        Some(_) => Ok(json!(true)),
                        None => Ok(json!(false)),
                    }
                }
                Err(_) => Ok(json!(false)),
            }
        }
        // TODO(wasm): the legacy Turtl-v1 account importer (`migrate` crate) isn't ported to
        // wasm32 -- see docs/wasm-port-plan.md ("migrate is a red herring for this work") and
        // Cargo.toml's native-only dependency table.
        #[cfg(target_arch = "wasm32")]
        "user:can-migrate" => Ok(json!(false)),
        "user:join-migrate" => {
            let old_username: String = jedi::get(&["2"], &data)?;
            let old_password: String = jedi::get(&["3"], &data)?;
            let new_username: String = jedi::get(&["4"], &data)?;
            let new_password: String = jedi::get(&["5"], &data)?;
            turtl.join_migrate(old_username, old_password, new_username, new_password).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
        }
        #[cfg(not(target_arch = "wasm32"))]
        "user:migrate-auth-debug" => {
            let old_username: String = jedi::get(&["2"], &data)?;
            let old_password: String = jedi::get(&["3"], &data)?;
            let result_v0 = ::migrate::user::generate_auth_debug(&old_username, &old_password, 0)?;
            let result_v1 = ::migrate::user::generate_auth_debug(&old_username, &old_password, 1)?;
            Ok(json!({
                "v0": result_v0.1,
                "v1": result_v1.1,
            }))
        }
        // TODO(wasm): see "user:can-migrate" above -- migrate crate not ported to wasm32.
        #[cfg(target_arch = "wasm32")]
        "user:migrate-auth-debug" => {
            TErr!(TError::NotImplemented)
        }
        "user:logout" => {
            let clear_cookie: bool = match jedi::get(&["2"], &data) {
                Ok(x) => x,
                Err(_) => true,
            };
            if clear_cookie {
                messaging::ui_event("user:logout:clear-cookie", &Value::Null)
                    .unwrap_or_else(|e| error!("dispatch::dispatch() -- error sending ui event: {}", e));
            }
            turtl.logout()?;
            exec::sleep(1000).await;
            Ok(json!({}))
        }
        "user:change-password" => {
            let current_username: String = jedi::get(&["2"], &data)?;
            let current_password: String = jedi::get(&["3"], &data)?;
            let new_username: String = jedi::get(&["4"], &data)?;
            let new_password: String = jedi::get(&["5"], &data)?;
            turtl.change_user_password(current_username, current_password, new_username, new_password).await?;
            Ok(json!({}))
        }
        "user:delete-account" => {
            messaging::ui_event("user:logout:clear-cookie", &Value::Null)
                .unwrap_or_else(|e| error!("dispatch::dispatch() -- error sending ui event: {}", e));
            turtl.delete_account().await?;
            Ok(json!({}))
        }
        "user:resend-confirmation" => {
            User::resend_confirmation(turtl).await?;
            Ok(json!({}))
        }
        "user:get-login-token" => {
            let confirmation: String = jedi::get_opt(&["2"], &data).unwrap_or(String::from("WRONG"));
            if confirmation != "I understand this token contains the user's master key and their account may be compromised if the token is misplaced." {
                return TErr!(TError::PermissionDenied(String::from("Please send the confirmation string to get the token")));
            }
            let token = User::get_login_token(turtl)?;
            Ok(Value::String(token))
        }
        // the accounts made on this device by a core that runs without a server (`local_only`)
        "user:local-accounts" => {
            Ok(jedi::to_val(&User::local_accounts(turtl)?)?)
        }
        // the passphrase of the account such a core is logged into: [current, new]. Says how many of the
        // things the user's key seals (the notebooks' keys, and the user's own record if it is kept in the
        // database) it sealed with the new key, and how many it could not open (and so left as they were).
        "user:change-passphrase" => {
            let current: String = jedi::get(&["2"], &data)?;
            let new: String = jedi::get(&["3"], &data)?;
            let found = User::change_local_passphrase(turtl, current, new)?;
            Ok(json!({"sealed": found.moved, "unreadable": found.unreadable}))
        }
        // a backup of the vault, which only a core without a server has (see `vault_backup`): `make` makes it and says how big it is,
        // `read` hands out a piece of it ([offset, length], as base64) and `drop` lets go of it
        "vault:backup:make" => {
            local_only_or_refuse(turtl, cmd)?;
            let backup = vault_backup::make(turtl)?;
            let size = backup.len();
            *lock!(turtl.backup) = Some(backup);
            Ok(json!({"size": size}))
        }
        "vault:backup:read" => {
            local_only_or_refuse(turtl, cmd)?;
            let offset: usize = jedi::get(&["2"], &data)?;
            let length: usize = jedi::get(&["3"], &data)?;
            if length > MAX_BACKUP_PIECE {
                return TErr!(TError::BadValue(format!("a piece of a backup is at most {} bytes", MAX_BACKUP_PIECE)));
            }
            let backup_guard = lock!(turtl.backup);
            let backup = match backup_guard.as_ref() {
                Some(backup) => backup,
                None => return TErr!(TError::NotFound(String::from("there is no backup made"))),
            };
            if offset > backup.len() {
                return TErr!(TError::BadValue(format!("a backup is {} bytes: there is nothing at {}", backup.len(), offset)));
            }
            let end = offset + ::std::cmp::min(length, backup.len() - offset);
            Ok(Value::String(crypto::to_base64(&backup[offset..end])?))
        }
        // sealed copies of a notebook, for a place that must not read it (see `seal`): the key stays in the vault's keychain
        "seal:master:status" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::master_status(turtl)
        }
        "seal:master:make" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::master_make(turtl, &data)
        }
        "seal:master:wrap" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::master_wrap(turtl, &data)
        }
        "seal:master:unwrap" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::master_unwrap(turtl, &data)
        }
        "seal:master:forget" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::master_forget(turtl, &data)
        }
        "seal:objects:seal" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::seal_objects(turtl, &data)
        }
        "seal:objects:open" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::open_objects(turtl, &data)
        }
        "seal:index:seal" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::seal_index_command(turtl, &data)
        }
        "seal:index:open" => {
            local_only_or_refuse(turtl, cmd)?;
            seal::open_index_command(turtl, &data)
        }
        "vault:backup:drop" | "vault:restore:cancel" => {
            local_only_or_refuse(turtl, cmd)?;
            *lock!(turtl.backup) = None;
            Ok(json!({}))
        }
        // a backup is put back in pieces, one after the other ([offset, piece as base64]), and then `commit` restores it
        "vault:restore:write" => {
            local_only_or_refuse(turtl, cmd)?;
            let offset: usize = jedi::get(&["2"], &data)?;
            let piece: String = jedi::get(&["3"], &data)?;
            let piece = crypto::from_base64(&piece)?;
            let mut backup_guard = lock!(turtl.backup);
            if offset == 0 {
                *backup_guard = Some(Vec::new());
            }
            let backup = match backup_guard.as_mut() {
                Some(backup) => backup,
                None => return TErr!(TError::BadValue(String::from("a backup is sent from its start"))),
            };
            if backup.len() != offset {
                return TErr!(TError::BadValue(format!("the pieces of a backup are sent in order: {} bytes are here, and this one is for {}", backup.len(), offset)));
            }
            if backup.len() + piece.len() > vault_backup::MAX_BACKUP_BYTES {
                *backup_guard = None;
                return TErr!(TError::BadValue(format!("a backup of more than {} MiB can't be restored", vault_backup::MAX_BACKUP_BYTES >> 20)));
            }
            backup.extend_from_slice(&piece);
            Ok(json!({"size": backup.len()}))
        }
        "vault:restore:commit" => {
            local_only_or_refuse(turtl, cmd)?;
            // (it is taken: what was received is let go of whichever way this ends)
            let backup = match lock!(turtl.backup).take() {
                Some(backup) => backup,
                None => return TErr!(TError::BadValue(String::from("no backup was sent"))),
            };
            vault_backup::restore(turtl, &backup)
        }
        "user:save-login" => {
            let key = User::save_login(turtl)?;
            Ok(json!({"user_id": turtl.user_id()?, "key": key}))
        }
        "user:find-by-email" => {
            let email: String = jedi::get(&["2"], &data)?;
            let user = User::find_by_email(turtl, &email).await?;
            Ok(jedi::to_val(&user)?)
        }
        "app:connected" => {
            let connguard = lockr!(turtl.connected);
            let connected: bool = *connguard;
            drop(connguard);
            Ok(Value::Bool(connected))
        }
        "app:wipe-user-data" => {
            messaging::ui_event("user:logout:clear-cookie", &Value::Null)
                .unwrap_or_else(|e| error!("dispatch::dispatch() -- error sending ui event: {}", e));
            turtl.wipe_user_data().await?;
            Ok(json!({}))
        }
        "app:wipe-app-data" => {
            messaging::ui_event("user:logout:clear-cookie", &Value::Null)
                .unwrap_or_else(|e| error!("dispatch::dispatch() -- error sending ui event: {}", e));
            turtl.wipe_app_data().await?;
            Ok(json!({}))
        }
        "app:api:set-config" => {
            let api_config: Value = jedi::get(&["2"], &data)?;
            let config_merge = json!({
                "api": api_config,
            });
            config::merge(&config_merge)?;
            Ok(json!(config::get::<Value>(&["api"])?))
        }
        "app:api:get-config" => {
            Ok(config::get::<Value>(&["api"])?)
        }
        "app:get-config" => {
            Ok(config::dump()?)
        }
        "app:get-log" => {
            let lines: i32 = jedi::get(&["2"], &data)?;
            let contents = logger::read_log(lines)?;
            Ok(Value::String(contents))
        }
        "app:shutdown" => {
            turtl.sync_shutdown(false).await?;
            messaging::stop();
            Ok(json!({}))
        }
        "sync:start" => {
            turtl.sync_start().await?;
            Ok(json!({}))
        }
        "sync:pause" => {
            turtl.sync_pause();
            Ok(json!({}))
        }
        "sync:resume" => {
            turtl.sync_resume();
            Ok(json!({}))
        }
        "sync:status" => {
            Ok(Value::Bool(turtl.sync_running()))
        }
        "sync:shutdown" => {
            let wait: bool = jedi::get_opt(&["2"], &data).unwrap_or(true);
            turtl.sync_shutdown(wait).await?;
            Ok(json!({}))
        }
        "sync:get-pending" => {
            let pending = SyncRecord::get_all_pending(turtl)?;
            Ok(jedi::to_val(&pending)?)
        }
        "sync:unfreeze-item" => {
            let sync_id: String = jedi::get(&["2"], &data)?;
            SyncRecord::kick_frozen_sync(turtl, &sync_id)?;
            Ok(json!({}))
        }
        "sync:delete-item" => {
            let sync_id: String = jedi::get(&["2"], &data)?;
            SyncRecord::delete_sync_item(turtl, &sync_id)?;
            Ok(json!({}))
        }
        "profile:load" => {
            let user_guard = lockr!(turtl.user);
            let profile_guard = lockr!(turtl.profile);
            let profile_data = json!({
                "user": user_for_host(turtl, &user_guard)?,
                "spaces": &profile_guard.spaces,
                "boards": &profile_guard.boards,
                "invites": &profile_guard.invites,
            });
            Ok(profile_data)
        }
        // changes made between `begin` and `commit` happen whole or not at all (see `Turtl::batch_begin()`)
        "profile:batch:begin" => {
            turtl.batch_begin()?;
            Ok(json!({}))
        }
        "profile:batch:commit" => {
            turtl.batch_commit()?;
            Ok(json!({}))
        }
        "profile:batch:rollback" => {
            turtl.batch_rollback()?;
            Ok(json!({}))
        }
        "profile:sync:model" => {
            let action: SyncAction = match jedi::get(&["2"], &data) {
                Ok(action) => action,
                Err(e) => return TErr!(TError::BadValue(format!("bad sync action: {}", e))),
            };
            let ty: SyncType = jedi::get(&["3"], &data)?;
            let modeldata: Value = jedi::get(&["4"], &data)?;
            // construct a sync record and hand to our sync dispatcher
            let mut sync_record = SyncRecord::default();
            sync_record.action = action;
            sync_record.ty = ty;
            sync_record.data = Some(modeldata);
            sync_model::dispatch(turtl, sync_record)
        }
        "profile:space:set-owner" => {
            let space_id: String = jedi::get(&["2"], &data)?;
            let user_id: String = jedi::get(&["3"], &data)?;
            Space::set_owner(turtl, &space_id, &user_id).await
        }
        "profile:space:edit-member" => {
            let member: SpaceMember = jedi::get(&["2"], &data)?;
            Space::edit_member(turtl, &member).await
        }
        "profile:space:delete-member" => {
            let space_id: String = jedi::get(&["2"], &data)?;
            let user_id: String = jedi::get(&["3"], &data)?;
            Space::delete_member(turtl, &space_id, &user_id).await
        }
        "profile:space:leave" => {
            let space_id: String = jedi::get(&["2"], &data)?;
            Space::leave(turtl, &space_id).await
        }
        "profile:space:send-invite" => {
            let req: InviteRequest = jedi::get(&["2"], &data)?;
            Space::send_invite(turtl, req).await
        }
        "profile:space:edit-invite" => {
            let invite: Invite = jedi::get(&["2"], &data)?;
            Space::edit_invite(turtl, &invite).await
        }
        "profile:space:delete-invite" => {
            let space_id: String = jedi::get(&["2"], &data)?;
            let invite_id: String = jedi::get(&["3"], &data)?;
            Space::delete_invite(turtl, &space_id, &invite_id).await
        }
        "profile:accept-invite" => {
            let mut invite: Invite = jedi::get(&["2"], &data)?;
            let passphrase: Option<String> = jedi::get_opt(&["3"], &data);
            let space = Space::accept_invite(turtl, &mut invite, passphrase).await?;
            Ok(space.data()?)
        }
        "profile:delete-invite" => {
            let invite_id: String = jedi::get(&["2"], &data)?;
            Invite::delete_user_invite(turtl, &invite_id).await?;
            Ok(json!({}))
        }
        "profile:get-notes" => {
            let note_ids = jedi::get(&["2"], &data)?;
            let notes: Vec<Note> = turtl.load_notes(&note_ids)?;
            Ok(jedi::to_val(&notes)?)
        }
        "profile:find-notes" => {
            let qry: Query = match jedi::get(&["2"], &data) {
                Ok(x) => x,
                Err(e) => {
                    return TErr!(TError::BadValue(format!("error deserializing search query: {}", e)));
                }
            };
            let search_guard = lock!(turtl.search);
            if search_guard.is_none() {
                return TErr!(TError::MissingField(format!("turtl is missing `search` object")));
            }
            let search = search_guard.as_ref().expect("turtl::dispatch::dispatch() -- profile:find-notes -- search_guard is none");
            let (note_ids, total) = search.find(&qry)?;
            let notes: Vec<Note> = turtl.load_notes(&note_ids)?;
            let tags: Vec<(String, i32)> = search.find_tags(&qry)?;
            Ok(json!({
                "notes": notes,
                "tags": tags,
                "total": total,
            }))
        }
        "profile:find-tags" => {
            let qry: Query = match jedi::get(&["2"], &data) {
                Ok(x) => x,
                Err(e) => {
                    return TErr!(TError::BadValue(format!("error deserializing search query: {}", e)));
                }
            };
            let search_guard = lock!(turtl.search);
            if search_guard.is_none() {
                return TErr!(TError::MissingField(format!("turtl is missing `search` object")));
            }
            let search = search_guard.as_ref().expect("turtl::dispatch::dispatch() -- profile:find-tags -- search_guard is none");
            let tags: Vec<(String, i32)> = search.find_tags(&qry)?;
            Ok(json!({
                "tags": tags,
            }))
        }
        "profile:note:get-file" => {
            let note_id: String = jedi::get(&["2"], &data)?;
            let notes: Vec<Note> = turtl.load_notes(&vec![note_id.clone()])?;
            let note = match notes.first() {
                Some(note) => note,
                None => return TErr!(TError::NotFound(format!("note {} not found", note_id))),
            };
            let bin = FileData::load_file(turtl, note)?;
            let base64 = crypto::to_base64(&bin)?;
            Ok(Value::String(base64))
        }
        "profile:export" => {
            let export = Profile::export(turtl)?;
            Ok(jedi::to_val(&export)?)
        }
        "profile:import" => {
            let mode: ImportMode = jedi::get(&["2"], &data)?;
            let export: Export = jedi::get(&["3"], &data)?;
            let result = Profile::import(turtl, mode, export)?;
            Ok(jedi::to_val(&result)?)
        }
        "feedback:send" => {
            let feedback: Feedback = jedi::get(&["2"], &data)?;
            feedback.send(turtl).await?;
            Ok(json!({}))
        }
        #[cfg(not(target_arch = "wasm32"))]
        "clip" => {
            let url: String = jedi::get(&["2"], &data)?;
            let custom_parsers: Vec<CustomParser> = jedi::get(&["3"], &data)?;
            let proxy_cfg: Option<String> = config::get(&["api", "proxy"])
                .unwrap_or(None);
            let res = clippo::clip(&url, &custom_parsers, proxy_cfg)?;
            Ok(jedi::to_val(&res)?)
        }
        // TODO(wasm): clippo (web-clipping via blocking reqwest + regex + html5ever/scraper) is
        // not ported to wasm32 -- see docs/wasm-port-plan.md and Cargo.toml's native-only
        // dependency table.
        #[cfg(target_arch = "wasm32")]
        "clip" => {
            TErr!(TError::NotImplemented)
        }
        "ping" => {
            info!("ping!");
            messaging::ui_event("pong", &Value::Null)?;
            Ok(Value::String(String::from("pong")))
        }
        _ => {
            TErr!(TError::MissingCommand(cmd.clone()))
        }
    }
}

/// Event dispatching. This acts as a way for parts of the app that don't have
/// access to the Turtl object to trigger events.
async fn dispatch_event(cmd: &String, turtl: &Turtl, data: Value) -> TResult<()> {
    info!("dispatch::dispatch_event() -- {}", cmd);
    match cmd.as_ref() {
        "sync:connected" => {
            let yesno: bool = jedi::from_val(data)?;
            let mut connguard = lockw!(turtl.connected);
            let cur_yesno = *connguard;
            *connguard = yesno;
            if cur_yesno != yesno {
                // only send the ui event if we've changed state
                messaging::ui_event("sync:connected", &yesno)
                    .unwrap_or_else(|e| error!("dispatch::dispatch_event() -- error sending connected UI event: {}", e));
            }
        }
        "sync:incoming" => {
            sync::incoming::process_incoming_sync(turtl).await?;
        }
        "user:edit" => {
            let mut user_guard = lockw!(turtl.user);
            user_guard.merge_fields(&data)?;
        }
        "user:change-password:logout" => {
            messaging::ui_event("user:change-password:logout", &json!({}))?;
            exec::sleep(3000).await;
            turtl.logout()?;
        }
        "user:wipe-data" => {
            turtl.wipe_user_data().await?;
        }
        "space:delete" => {
            let space_id: String = jedi::get(&["0"], &data)?;
            let skip_remote_sync: bool = match jedi::get_opt(&["1"], &data) {
                Some(x) => x,
                None => false,
            };
            sync_model::delete_model::<Space>(turtl, &space_id, skip_remote_sync)?;
        }
        _ => {
            warn!("dispatch_event() -- encountered unknown event: {}", cmd);
        }
    }
    Ok(())
}

/// The id a message that can't be parsed was sent with: the first element of the array, as a plain string
/// (`["<id>", ...`). Nothing cleverer: the message is not to be trusted to be JSON.
fn request_id(msg: &str) -> Option<String> {
    let rest = msg.trim_start().strip_prefix('[')?.trim_start().strip_prefix('"')?;
    let id = &rest[..rest.find('"')?];
    if id.is_empty() || id.contains('\\') { None } else { Some(String::from(id)) }
}

/// process a message from the messaging system. this is the main communication
/// heart of turtl core.
pub async fn process(turtl: &Turtl, msg: &String) -> TResult<()> {
    if msg.starts_with("::ev") {
        let event: Event = jedi::parse(&String::from(&msg[4..]))?;
        let Event {e, d} = event;
        return dispatch_event(&e, turtl, d).await;
    }

    let data: Value = match jedi::parse(msg) {
        Ok(data) => data,
        Err(e) => {
            // a message that can't be read is still answered, if it says who is asking: without an answer the
            // one that sent it waits for ever
            if let Some(mid) = request_id(msg) {
                let err: TError = From::from(e);
                if let Err(send_err) = turtl.msg_error(&mid, &err) {
                    error!("dispatch::process() -- problem sending (parse error) response (mid {}): {}", mid, send_err);
                }
                return Ok(());
            }
            return Err(From::from(e));
        }
    };

    // grab the request id from the data
    let mid: String = match jedi::get(&["0"], &data) {
        Ok(x) => x,
        Err(_) => return TErr!(TError::MissingField(String::from("missing mid (0)"))),
    };
    // grab the command from the data
    let cmd: String = match jedi::get(&["1"], &data) {
        Ok(x) => x,
        Err(_) => return TErr!(TError::MissingField(String::from("missing cmd (1)"))),
    };

    info!("dispatch({}): {}", mid, cmd);

    let res = exec::catch_panic(async {
        match dispatch(&cmd, turtl, data).await {
            Ok(val) => {
                match turtl.msg_success(&mid, val) {
                    Err(e) => error!("dispatch::process() -- problem sending response (mid {}): {}", mid, e),
                    _ => {},
                }
            },
            Err(e) => {
                match turtl.msg_error(&mid, &e) {
                    Err(e) => error!("dispatch:process() -- problem sending (error) response (mod {}): {}", mid, e),
                    _ => {},
                }
            },
        }
    }).await;
    match res {
        Ok(..) => {}
        Err(e) => {
            let err = exec::panic_message(&*e);
            error!("dispatch::process() -- panic: {}", err);
            match turtl.msg_error(&mid, &TError::Panic(format!("dispatch panic: {}", err))) {
                Err(e) => error!("dispatch:process() -- problem sending (panic) response (mod {}): {}", mid, e),
                _ => {},
            }
        }
    }
    Ok(())
}

