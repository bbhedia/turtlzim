//! End-to-end tests of the async core against a stand-in Turtl server: the user flows (join, login),
//! messages going through the dispatcher, both directions of sync, and the sync engine as a whole.
//!
//! Each scenario is a plain `async fn` written once. Natively `async_test!` runs it with
//! `exec::block_on` against `util::mock_server`; on wasm32 it becomes a `wasm_bindgen_test` (run by
//! `wasm-pack test --node`) against the Node server in `js/test_support.js` (`startFlowServer`). The
//! two servers must behave identically, so both are described here:
//!
//! ```text
//! One account lives on the server at a time; every test starts its own server.
//!
//! POST /users     {auth, username, data}  -> 200 {"id": "42", "data": <data>}      stores the account
//! POST /auth      Authorization: Basic base64("<username>:<auth>")
//!                                         -> 200 "42", or 401 {"error": "bad login"}
//! GET  /users/42                          -> 200 {"id": "42", ...<the stored data>}
//! PUT  /users/42  {user, auth, keychain}  -> 200 {"sync_ids": [102]}                replaces the account
//! POST|PUT|DELETE /spaces/...             -> 200 {}
//! POST /sync      [records]               -> 200 {"success": <the records, the first one with
//!                                                 "sync_ids": [101]>, "failures": [], "blocked": []}
//! GET  /sync/full                         -> 200 {"records": [], "sync_id": 7}
//! GET  /sync?...  (the first time)        -> 200 {"records": [<note n1>], "sync_id": 9}
//! GET  /sync?...  (after that)            -> 200 {"records": [], "sync_id": 9}
//! GET  /requests                          -> 200 ["<METHOD> <path>", ...] what the server was asked
//!                                            so far, oldest first (this route is not logged itself)
//! ```

use ::std::sync::{Arc, Mutex, RwLock};
use ::futures_util::future::join;
use ::jedi::{self, Value};
use ::lib_permissions::Role;
use crate::api::{Api, StatusCode};
use crate::dispatch;
use crate::error::TError;
use crate::models::invite::InviteRequest;
use crate::models::model::Model;
use crate::models::note::Note;
use crate::models::space::Space;
use crate::models::sync_record::SyncRecord;
use crate::models::user::User;
use crate::schema;
use crate::storage::Storage;
use crate::sync::{SyncConfig, Syncer};
use crate::sync::incoming::{self, SyncIncoming};
use crate::sync::outgoing::SyncOutgoing;
use crate::turtl::Turtl;
use crate::util::exec;

#[cfg(not(target_arch = "wasm32"))]
use crate::crypto;
#[cfg(not(target_arch = "wasm32"))]
use crate::util::mock_server::{MockServer, Request, Response};
#[cfg(target_arch = "wasm32")]
use ::wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use ::wasm_bindgen_futures::JsFuture;

// ---------------------------------------------------------------------------------------------
// the stand-in server
// ---------------------------------------------------------------------------------------------

/// A running stand-in server. The native one stops when this is dropped; on wasm32 they live until
/// the test run ends.
struct Server {
    url: String,
    #[cfg(not(target_arch = "wasm32"))]
    _server: MockServer,
}

#[cfg(not(target_arch = "wasm32"))]
struct Account {
    username: String,
    auth: String,
    data: Value,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
struct ServerState {
    account: Option<Account>,
    log: Vec<String>,
    polls: usize,
}

#[cfg(not(target_arch = "wasm32"))]
fn flow_route(state: &Mutex<ServerState>, req: &Request) -> Response {
    let mut state = lock!(state);
    if req.method == "GET" && req.path == "/requests" {
        return Response::json(200, &json!(state.log).to_string());
    }
    state.log.push(format!("{} {}", req.method, req.path));
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/users") => {
            let posted: Value = jedi::parse(&req.body).unwrap();
            let data = posted["data"].clone();
            state.account = Some(Account {
                username: String::from(posted["username"].as_str().unwrap()),
                auth: String::from(posted["auth"].as_str().unwrap()),
                data: data.clone(),
            });
            Response::json(200, &json!({"id": "42", "data": data}).to_string())
        }
        ("POST", "/auth") => {
            let expected = state.account.as_ref().map(|account| {
                let creds = format!("{}:{}", account.username, account.auth);
                format!("Basic {}", crypto::to_base64(&Vec::from(creds.as_bytes())).unwrap())
            });
            if expected.is_some() && req.header("authorization") == expected.as_deref() {
                Response::json(200, r#""42""#)
            } else {
                Response::json(401, r#"{"error":"bad login"}"#)
            }
        }
        ("GET", "/users/42") => match state.account.as_ref() {
            Some(account) => {
                let mut user = account.data.clone();
                user["id"] = json!("42");
                Response::json(200, &user.to_string())
            }
            None => Response::json(404, r#"{"error":"no such user"}"#),
        },
        ("PUT", "/users/42") => {
            let posted: Value = jedi::parse(&req.body).unwrap();
            let user = posted["user"].clone();
            state.account = Some(Account {
                username: String::from(user["username"].as_str().unwrap()),
                auth: String::from(posted["auth"].as_str().unwrap()),
                data: user,
            });
            Response::json(200, r#"{"sync_ids":[102]}"#)
        }
        (method, path) if method != "GET" && path.starts_with("/spaces/") => Response::json(200, "{}"),
        ("POST", "/sync") => {
            let mut records: Value = jedi::parse(&req.body).unwrap();
            if let Some(first) = records.get_mut(0) {
                first["sync_ids"] = json!([101]);
            }
            Response::json(200, &json!({"success": records, "failures": [], "blocked": []}).to_string())
        }
        ("GET", "/sync/full") => Response::json(200, r#"{"records":[],"sync_id":7}"#),
        ("GET", path) if path.starts_with("/sync?") => {
            state.polls += 1;
            let records = if state.polls == 1 {
                json!([{
                    "id": "1001", "type": "note", "action": "add", "item_id": "n1", "user_id": 42,
                    "data": {"id": "n1", "space_id": "s1", "user_id": 42, "board_id": null, "body": "AAYBAAw="},
                }])
            } else {
                json!([])
            };
            Response::json(200, &json!({"records": records, "sync_id": 9}).to_string())
        }
        _ => Response::json(404, r#"{"error":"unknown route"}"#),
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn start_server() -> Server {
    let state = Arc::new(Mutex::new(ServerState::default()));
    let server = MockServer::start(move |req: &Request| flow_route(&state, req));
    Server { url: server.url(), _server: server }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(module = "/js/test_support.js")]
extern "C" {
    /// Starts a stand-in Turtl server and resolves to its port.
    #[wasm_bindgen(js_name = startFlowServer)]
    fn start_flow_server() -> ::js_sys::Promise;
}

#[cfg(target_arch = "wasm32")]
async fn start_server() -> Server {
    let port = JsFuture::from(start_flow_server()).await.unwrap().as_f64().unwrap() as u16;
    Server { url: format!("http://127.0.0.1:{}", port) }
}

/// What the server has been asked so far (`"<METHOD> <path>"`, oldest first).
async fn requests(server: &Server) -> Vec<String> {
    let api = Api::new();
    api.set_endpoint(Some(server.url.clone()));
    api.get("/requests").unwrap().call().await.unwrap()
}

// ---------------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------------

/// Natively the config is the repo's config.yaml (loaded the way every other test of ours does).
#[cfg(not(target_arch = "wasm32"))]
fn init_config() {
    crate::init(String::from("{}")).unwrap();
}

/// On wasm32 there is no config file to load, so the values the flows read are set here: the same
/// ones config.yaml has.
#[cfg(target_arch = "wasm32")]
fn init_config() {
    ::config::load_config(Some(String::from(":null:"))).unwrap();
    ::config::merge(&json!({
        "wrap_errors": false,
        "data_folder": ":memory:",
        "integration_tests": {"data_folder": ":memory:"},
        "messaging": {
            "reqres": "inproc://turtl-req",
            "events": "inproc://turtl-events",
            "reqres_append_mid": false,
        },
        "api": {
            "endpoint": "http://127.0.0.1:1",
            "client_version_string": "core",
            "proxy": null,
            "allow_invalid_ssl": false,
        },
        "sync": {
            "enable_incoming": true,
            "enable_outgoing": true,
            "enable_files_incoming": true,
            "enable_files_outgoing": true,
            "poll_timeout": 25,
        },
    })).unwrap();
}

/// A fresh Turtl that talks to `server`.
fn test_turtl(server: &Server) -> Turtl {
    init_config();
    let turtl = Turtl::new().unwrap();
    turtl.api.set_endpoint(Some(server.url.clone()));
    turtl
}

/// What the sync parts are given: a config, an Api that talks to `server`, and an empty user db.
fn sync_parts(server: &Server) -> (Arc<RwLock<SyncConfig>>, Arc<Api>, Arc<Mutex<Option<Storage>>>) {
    init_config();
    let mut sync_config = SyncConfig::new();
    sync_config.enabled = true;
    let api = Api::new();
    api.set_endpoint(Some(server.url.clone()));
    let db = Storage::new(&String::from(":memory:"), schema::get_schema()).unwrap();
    (Arc::new(RwLock::new(sync_config)), Arc::new(api), Arc::new(Mutex::new(Some(db))))
}

/// All the sync records waiting in a user db.
fn sync_records(db: &Arc<Mutex<Option<Storage>>>) -> Vec<SyncRecord> {
    let db_guard = lock!(db);
    db_guard.as_ref().unwrap().all("sync").unwrap()
}

fn kv_get(db: &Arc<Mutex<Option<Storage>>>, key: &str) -> Option<String> {
    let db_guard = lock!(db);
    db_guard.as_ref().unwrap().kv_get(key).unwrap()
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/// Joining creates the account and logs us in with a profile of our own; a bad passphrase is refused
/// by the server; the right one logs us in again, with the encrypted part of our user record intact.
async fn join_and_login() {
    let server = start_server().await;
    let turtl = test_turtl(&server);

    turtl.join(String::from("Flow@Test.com"), String::from("flowflowflow")).await.unwrap();
    assert_eq!(turtl.user_id().unwrap(), "42");
    {
        let user_guard = lockr!(turtl.user);
        assert!(user_guard.logged_in);
        assert_eq!(user_guard.username, "flow@test.com");
        assert!(user_guard.pubkey.is_some());
        assert!(user_guard.privkey.is_some());
    }
    {
        // post_join gave us the default spaces and boards
        let profile_guard = lockr!(turtl.profile);
        assert_eq!(profile_guard.spaces.len(), 3);
        assert_eq!(profile_guard.boards.len(), 3);
    }

    turtl.logout().unwrap();
    assert!(!lockr!(turtl.user).logged_in);
    assert!(turtl.api.auth_header().is_none());

    let err = turtl.login(String::from("flow@test.com"), String::from("not the passphrase")).await.unwrap_err();
    match err.shed() {
        TError::Api(status, _) => assert_eq!(status, StatusCode::UNAUTHORIZED),
        other => panic!("expected an API error, got {:?}", other),
    }
    assert!(!lockr!(turtl.user).logged_in);
    assert!(turtl.api.auth_header().is_none());

    turtl.login(String::from("FLOW@test.com"), String::from("flowflowflow")).await.unwrap();
    {
        let user_guard = lockr!(turtl.user);
        assert!(user_guard.logged_in);
        assert_eq!(user_guard.id().map(|x| x.as_str()), Some("42"));
        // the private fields only came back because we could decrypt the user record
        assert!(user_guard.privkey.is_some());
    }
    assert_eq!(turtl.user_id().unwrap(), "42");
    assert!(turtl.api.auth_header().is_some());

    assert_eq!(requests(&server).await, vec!["POST /users", "POST /auth", "POST /auth", "GET /users/42"]);
}
async_test!(join_and_login_flow, join_and_login());

/// Messages go in through the dispatcher and answers come out on the response channel, whether the
/// command is synchronous, talks to the API, or fails.
async fn dispatcher() {
    let server = start_server().await;
    let turtl = test_turtl(&server);

    /// Send the dispatcher `["<mid>", ...args]` and fetch the response with that message id.
    async fn ask(turtl: &Turtl, args: Value) -> Value {
        let mid = String::from(args[0].as_str().unwrap());
        dispatch::process(turtl, &args.to_string()).await.unwrap();
        let mut others = Vec::new();
        while let Some(msg) = crate::recv_nb(None).unwrap() {
            let res: Value = jedi::parse(&msg).unwrap();
            if res["id"] == json!(mid) {
                return res;
            }
            others.push(msg);
        }
        panic!("no response to message {} (other responses: {:?})", mid, others);
    }

    let res = ask(&turtl, json!(["d1", "ping"])).await;
    assert_eq!((res["e"].as_i64(), &res["d"]), (Some(0), &json!("pong")));

    let res = ask(&turtl, json!(["d2", "user:join", "Dispatch@Test.com", "dispatchpass"])).await;
    assert_eq!(res["e"], json!(0));
    assert_eq!(res["d"]["username"], json!("dispatch@test.com"));
    assert_eq!(res["d"]["id"], json!("42"));

    let res = ask(&turtl, json!(["d3", "user:logout"])).await;
    assert_eq!(res["e"], json!(0));
    assert!(!lockr!(turtl.user).logged_in);

    // the server's refusal reaches the caller as the error it is
    let res = ask(&turtl, json!(["d4", "user:login", "dispatch@test.com", "wrong passphrase"])).await;
    assert_eq!(res["e"], json!(1));
    assert_eq!(res["d"]["type"], json!("api"));
    assert_eq!(res["d"]["subtype"], json!("Unauthorized"));

    let res = ask(&turtl, json!(["d5", "user:login", "dispatch@test.com", "dispatchpass"])).await;
    assert_eq!(res["e"], json!(0));
    assert_eq!(res["d"]["username"], json!("dispatch@test.com"));
    assert!(lockr!(turtl.user).logged_in);

    let res = ask(&turtl, json!(["d6", "no:such-command"])).await;
    assert_eq!(res["e"], json!(1));
    assert_eq!(res["d"]["type"], json!("missing_command"));
}
async_test!(dispatcher_flow, dispatcher());

/// The outgoing syncer sends what is waiting in the db in one batch, cleans up after the server
/// accepted it, and remembers which incoming syncs that will cause (to skip them later).
async fn outgoing_sync() {
    let server = start_server().await;
    let (sync_config, api, db) = sync_parts(&server);
    {
        let sync1: SyncRecord = jedi::from_val(json!({"id": "1", "action": "add", "item_id": "69", "user_id": 12, "type": "note"})).unwrap();
        let sync2: SyncRecord = jedi::from_val(json!({"id": "2", "action": "edit", "item_id": "69", "user_id": 12, "type": "note"})).unwrap();
        let mut db_guard = lock!(db);
        let dbo = db_guard.as_mut().unwrap();
        dbo.save(&sync1).unwrap();
        dbo.save(&sync2).unwrap();
    }
    assert_eq!(sync_records(&db).len(), 2);

    let mut outgoing = SyncOutgoing::new(sync_config, api, db.clone());
    outgoing.run_sync().await.unwrap();

    assert_eq!(requests(&server).await, vec!["POST /sync"]);
    assert_eq!(sync_records(&db).len(), 0);
    assert_eq!(kv_get(&db, "sync:incoming:ignore"), Some(String::from(r#"["101"]"#)));

    // with nothing left to send the server isn't bothered again
    outgoing.run_sync().await.unwrap();
    assert_eq!(requests(&server).await, vec!["POST /sync"]);
}
async_test!(outgoing_sync_flow, outgoing_sync());

/// The incoming syncer loads the whole profile the first time, then polls for what came after the
/// last sync id it saw; what it hears goes into the db and onto the queue the dispatcher drains.
async fn incoming_sync() {
    let server = start_server().await;
    let (sync_config, api, db) = sync_parts(&server);
    let mut incoming = SyncIncoming::new(sync_config.clone(), api, db.clone());

    incoming.init().await.unwrap();
    assert_eq!(kv_get(&db, "sync_id"), Some(String::from("7")));

    incoming.run_sync().await.unwrap();
    assert_eq!(kv_get(&db, "sync_id"), Some(String::from("9")));
    assert_eq!(requests(&server).await, vec!["GET /sync/full", "GET /sync?sync_id=7&type=poll"]);

    {
        let db_guard = lock!(db);
        let notes: Vec<Note> = db_guard.as_ref().unwrap().by_id("notes", &vec![String::from("n1")]).unwrap();
        assert_eq!(notes.len(), 1);
    }
    let queue = lockr!(sync_config).incoming_sync.clone();
    let queued = queue.try_pop().expect("the note should be waiting for the dispatcher");
    assert_eq!(queued.id().map(|x| x.as_str()), Some("1001"));
    assert!(queue.try_pop().is_none());

    // nothing new: the sync id stays put and nothing more is queued
    incoming.run_sync().await.unwrap();
    assert_eq!(kv_get(&db, "sync_id"), Some(String::from("9")));
    assert!(queue.try_pop().is_none());
}
async_test!(incoming_sync_flow, incoming_sync());

/// The whole engine under a logged-in user: `sync_start()` waits for the syncers to come up, the
/// outgoing one sends the profile that joining queued, and `sync_shutdown(true)` waits for the
/// syncers to wind down.
async fn sync_engine() {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    turtl.join(String::from("Engine@Test.com"), String::from("enginepass")).await.unwrap();
    let queued = sync_records(&turtl.db).len();
    assert!(queued > 0, "joining should have queued the new profile for upload");

    assert!(!turtl.sync_ready());
    turtl.sync_start().await.unwrap();
    assert!(turtl.sync_ready());
    assert!(turtl.sync_running());
    // incoming syncs are let through again once we're started
    assert!(!turtl.incoming_sync_held());

    // the outgoing syncer sends the queue as soon as it is running; give it some time
    let mut tries = 0;
    while sync_records(&turtl.db).len() > 0 {
        tries += 1;
        assert!(tries < 100, "the outgoing syncer never sent the queue");
        exec::sleep(100).await;
    }
    let log = requests(&server).await;
    assert!(log.contains(&String::from("GET /sync/full")), "{:?}", log);
    assert!(log.contains(&String::from("POST /sync")), "{:?}", log);

    turtl.sync_shutdown(true).await.unwrap();
    assert!(!turtl.sync_ready());
    assert!(!turtl.sync_running());
}
async_test!(sync_engine_flow, sync_engine());

/// While `sync_start()` holds incoming syncs back, applying them waits; once the hold is released it
/// goes through with what was queued.
async fn incoming_sync_hold() {
    init_config();
    let turtl = Turtl::new().unwrap();
    let invite: SyncRecord = jedi::from_val(json!({
        "id": "s1", "type": "invite", "action": "add", "item_id": "i1", "user_id": 42,
        "data": {
            "id": "i1", "space_id": "sp1", "from_user_id": "9", "from_username": "them@test.com",
            "to_user": "me@test.com", "role": "member", "is_passphrase_protected": false,
            "is_pubkey_protected": false, "title": "come on in",
        },
    })).unwrap();
    lockr!(turtl.sync_config).incoming_sync.push(invite);

    let hold = turtl.hold_incoming_sync();
    assert!(turtl.incoming_sync_held());

    let release = async {
        exec::sleep(150).await;
        // nothing has been applied while it was held back
        assert_eq!(lockr!(turtl.profile).invites.len(), 0);
        drop(hold);
        assert!(!turtl.incoming_sync_held());
    };
    let (processed, ()) = join(incoming::process_incoming_sync(&turtl), release).await;
    processed.unwrap();

    assert_eq!(lockr!(turtl.profile).invites.len(), 1);
    assert!(lockr!(turtl.sync_config).incoming_sync.try_pop().is_none());
}
async_test!(incoming_sync_hold_flow, incoming_sync_hold());

/// The space operations check what they may do, ask the server, and apply the answer, without keeping
/// the profile locked while the request is out.
async fn space_operations() {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    turtl.join(String::from("Spaces@Test.com"), String::from("spacespass")).await.unwrap();
    *lockw!(turtl.connected) = true;
    let space_id = lockr!(turtl.profile).spaces[0].id().unwrap().clone();
    let request = || InviteRequest {
        space_id: space_id.clone(),
        to_user: String::from("friend@test.com"),
        role: Role::Member,
        title: String::from("come on in"),
        their_pubkey: None,
        passphrase: None,
    };

    // an invite goes to the server and into the space
    let data = Space::send_invite(&turtl, request()).await.unwrap();
    assert_eq!(data["invites"].as_array().unwrap().len(), 1);
    let invite_id = String::from(data["invites"][0]["id"].as_str().unwrap());
    assert_eq!(requests(&server).await.last().unwrap(), &format!("POST /spaces/{}/invites", space_id));

    // the same invite again is refused, and so is anything that doesn't add up, before the server is asked
    let asked = requests(&server).await.len();
    match Space::send_invite(&turtl, request()).await.unwrap_err().shed() {
        TError::BadValue(msg) => assert!(msg.contains("already invited"), "{}", msg),
        other => panic!("expected a bad value, got {:?}", other),
    }
    match Space::set_owner(&turtl, &space_id, &String::from("nobody")).await.unwrap_err().shed() {
        TError::NotFound(_) => {}
        other => panic!("expected not found, got {:?}", other),
    }
    match Space::delete_invite(&turtl, &space_id, &String::from("no-such-invite")).await.unwrap_err().shed() {
        TError::NotFound(_) => {}
        other => panic!("expected not found, got {:?}", other),
    }
    match Space::leave(&turtl, &String::from("no-such-space")).await.unwrap_err().shed() {
        TError::MissingData(_) => {}
        other => panic!("expected missing data, got {:?}", other),
    }
    assert_eq!(requests(&server).await.len(), asked);

    // the invite can be taken back
    let data = Space::delete_invite(&turtl, &space_id, &invite_id).await.unwrap();
    assert_eq!(data["invites"].as_array().unwrap().len(), 0);
    assert_eq!(requests(&server).await.last().unwrap(), &format!("DELETE /spaces/{}/invites/{}", space_id, invite_id));

    // leaving answers with the space as it was (the space itself goes away through an event)
    let data = Space::leave(&turtl, &space_id).await.unwrap();
    assert_eq!(data["id"], json!(space_id));
    assert_eq!(requests(&server).await.last().unwrap(), &format!("DELETE /spaces/{}/members/42", space_id));
}
async_test!(space_operations_flow, space_operations());

/// Changing the passphrase checks the current one, tells the server, and from then on only the new
/// one logs in.
async fn change_password() {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    turtl.join(String::from("Change@Test.com"), String::from("oldpassphrase")).await.unwrap();
    *lockw!(turtl.connected) = true;

    // the current passphrase has to be right
    let wrong = User::change_password(&turtl, String::from("change@test.com"), String::from("not mine"),
                                      String::from("change@test.com"), String::from("newpassphrase")).await;
    match wrong.unwrap_err().shed() {
        TError::BadValue(_) => {}
        other => panic!("expected a bad value, got {:?}", other),
    }
    assert!(!requests(&server).await.contains(&String::from("PUT /users/42")));

    User::change_password(&turtl, String::from("change@test.com"), String::from("oldpassphrase"),
                          String::from("New@Test.com"), String::from("newpassphrase")).await.unwrap();
    assert!(requests(&server).await.contains(&String::from("PUT /users/42")));
    assert!(lockr!(turtl.user).logged_in);

    turtl.logout().unwrap();
    match turtl.login(String::from("change@test.com"), String::from("oldpassphrase")).await.unwrap_err().shed() {
        TError::Api(status, _) => assert_eq!(status, StatusCode::UNAUTHORIZED),
        other => panic!("expected an API error, got {:?}", other),
    }
    turtl.login(String::from("new@test.com"), String::from("newpassphrase")).await.unwrap();
    assert!(lockr!(turtl.user).logged_in);
    // the user record came back (and decrypted) under the new key
    assert!(lockr!(turtl.user).privkey.is_some());
}
async_test!(change_password_flow, change_password());
