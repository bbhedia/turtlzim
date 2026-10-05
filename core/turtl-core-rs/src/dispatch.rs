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

/// Does our actual message dispatching
async fn dispatch(cmd: &String, turtl: &Turtl, data: Value) -> TResult<Value> {
    match cmd.as_ref() {
        "user:login" => {
            let username: String = jedi::get(&["2"], &data)?;
            let password: String = jedi::get(&["3"], &data)?;
            turtl.login(username, password).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
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
            let token = User::restore_login(user_id, key)?;
            turtl.login_token(token).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
        }
        "user:join" => {
            let username: String = jedi::get(&["2"], &data)?;
            let password: String = jedi::get(&["3"], &data)?;
            turtl.join(username, password).await?;
            let user_guard = lockr!(turtl.user);
            user_guard.data()
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
                "user": &user_guard.as_ref(),
                "spaces": &profile_guard.spaces,
                "boards": &profile_guard.boards,
                "invites": &profile_guard.invites,
            });
            Ok(profile_data)
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
            let note_id = jedi::get(&["2"], &data)?;
            let notes: Vec<Note> = turtl.load_notes(&vec![note_id])?;
            let bin = FileData::load_file(turtl, &notes[0])?;
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

/// process a message from the messaging system. this is the main communication
/// heart of turtl core.
pub async fn process(turtl: &Turtl, msg: &String) -> TResult<()> {
    if &msg[0..4] == "::ev" {
        let event: Event = jedi::parse(&String::from(&msg[4..]))?;
        let Event {e, d} = event;
        return dispatch_event(&e, turtl, d).await;
    }

    let data: Value = jedi::parse(msg)?;

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

