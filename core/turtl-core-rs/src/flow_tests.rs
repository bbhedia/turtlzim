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
//! PUT  /notes/<id>/attachment  <bytes>    -> 200 {}   stores a note's file
//! GET  /notes/<id>/attachment             -> 200 "http://<host>/notes/<id>/file"   where to download it
//! GET  /notes/<id>/file                   -> 200 <the stored bytes>, or 404
//! POST /seed {account, full_sync}         -> 200 {}   test-only: preloads the account ({username, auth,
//!                                                     data}) and the records GET /sync/full answers with
//! POST /sync      [records]               -> 200 {"success": <the records, the first one with
//!                                                 "sync_ids": [101]>, "failures": [], "blocked": []}
//! GET  /sync/full                         -> 200 {"records": <seeded, or []>, "sync_id": 7}
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
pub(crate) struct Server {
    pub(crate) url: String,
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
    full_sync: Vec<Value>,
    attachments: ::std::collections::HashMap<String, Vec<u8>>,
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
        (method, path) if path.starts_with("/notes/") && (path.ends_with("/attachment") || path.ends_with("/file")) => {
            let id = String::from(path.trim_start_matches("/notes/").trim_end_matches("/attachment").trim_end_matches("/file"));
            match (method, path.ends_with("/attachment")) {
                ("PUT", true) => {
                    state.attachments.insert(id, req.body_bytes.clone());
                    Response::json(200, "{}")
                }
                ("GET", true) => {
                    let url = format!("http://{}/notes/{}/file", req.header("host").unwrap_or("localhost"), id);
                    Response::json(200, &json!(url).to_string())
                }
                ("GET", false) => match state.attachments.get(&id) {
                    Some(bytes) => Response::bytes(200, "application/octet-stream", bytes.clone()),
                    None => Response::json(404, r#"{"error":"no such file"}"#),
                },
                _ => Response::json(404, r#"{"error":"unknown route"}"#),
            }
        }
        ("POST", "/sync") => {
            let mut records: Value = jedi::parse(&req.body).unwrap();
            if let Some(first) = records.get_mut(0) {
                first["sync_ids"] = json!([101]);
            }
            Response::json(200, &json!({"success": records, "failures": [], "blocked": []}).to_string())
        }
        ("POST", "/seed") => {
            let seed: Value = jedi::parse(&req.body).unwrap();
            let account = &seed["account"];
            state.account = Some(Account {
                username: String::from(account["username"].as_str().unwrap()),
                auth: String::from(account["auth"].as_str().unwrap()),
                data: account["data"].clone(),
            });
            state.full_sync = seed["full_sync"].as_array().cloned().unwrap_or_default();
            Response::json(200, "{}")
        }
        ("GET", "/sync/full") => Response::json(200, &json!({"records": state.full_sync, "sync_id": 7}).to_string()),
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
pub(crate) async fn start_server() -> Server {
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
pub(crate) async fn start_server() -> Server {
    let port = JsFuture::from(start_flow_server()).await.unwrap().as_f64().unwrap() as u16;
    Server { url: format!("http://127.0.0.1:{}", port) }
}

/// Seed the stand-in server with an account and the records it should hand out as the full profile.
pub(crate) async fn seed(server: &Server, account: Value, full_sync: Value) {
    let api = Api::new();
    api.set_endpoint(Some(server.url.clone()));
    let _: Value = api.post("/seed").unwrap().json(&json!({"account": account, "full_sync": full_sync})).call().await.unwrap();
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

/// The config is whatever `init()` makes of it: natively the repo's config.yaml (the way every other
/// test of ours does it), on wasm32 the built-in defaults.
pub(crate) fn init_config() {
    crate::init(String::from("{}")).unwrap();
}

/// A fresh Turtl that talks to `server`.
pub(crate) fn test_turtl(server: &Server) -> Turtl {
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

/// Like `ask`, and the events that the core sent while it was answering too.
async fn ask_and_events(turtl: &Turtl, args: Value) -> (Value, Vec<Value>) {
    drain_events();
    let res = ask(turtl, args).await;
    (res, drain_events())
}

/// The events that the core has sent and nobody has taken (and none, afterwards).
fn drain_events() -> Vec<Value> {
    let mut events = Vec::new();
    while let Some(msg) = crate::recv_event_nb().unwrap() {
        events.push(jedi::parse(&msg).unwrap());
    }
    events
}

/// The `finished` of the `user:passphrase:settled` events among `events` that are of the account `account` (the tests run
/// side by side, and the queue of events is the process's: another test's are in it too).
fn settled_in(events: &[Value], account: &str) -> Vec<bool> {
    events.iter().filter(|event| event["e"] == json!("user:passphrase:settled") && event["d"]["account"] == json!(account)).map(|event| event["d"]["finished"].as_bool().unwrap()).collect()
}

/// Messages go in through the dispatcher and answers come out on the response channel, whether the
/// command is synchronous, talks to the API, or fails.
async fn dispatcher() {
    let server = start_server().await;
    let turtl = test_turtl(&server);

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

/// "Remember me": the core saves an encrypted login, hands the UI the key, and the UI can later log
/// in with that key alone. (Natively the saved login is a file in the data folder, on wasm32 a value
/// in the kv store.)
async fn saved_login() {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    #[cfg(not(target_arch = "wasm32"))]
    crate::util::create_dir(crate::util::file_folder(None).unwrap()).unwrap();

    let joined = ask(&turtl, json!(["l1", "user:join", "Saved@Test.com", "savedpassphrase"])).await;
    assert_eq!(joined.get("e"), Some(&json!(0)), "{}", joined);
    let saved = ask(&turtl, json!(["l2", "user:save-login"])).await;
    assert_eq!(saved["e"], json!(0), "{}", saved);
    let (user_id, key) = (saved["d"]["user_id"].clone(), saved["d"]["key"].clone());
    assert_eq!(user_id, json!("42"));

    assert_eq!(ask(&turtl, json!(["l3", "user:logout"])).await["e"], json!(0));
    assert!(!lockr!(turtl.user).logged_in);

    // the wrong key doesn't open it...
    let wrong_key = json!(crypto::to_base64(&vec![7u8; 32]).unwrap());
    let refused = ask(&turtl, json!(["l4", "user:login-from-saved", user_id, wrong_key])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    assert!(!lockr!(turtl.user).logged_in);

    // ...the right one logs us in again
    let back = ask(&turtl, json!(["l5", "user:login-from-saved", user_id, key])).await;
    assert_eq!(back["e"], json!(0), "{}", back);
    assert_eq!(back["d"]["username"], json!("saved@test.com"));
    assert!(lockr!(turtl.user).logged_in);

    // nothing saved for someone else
    assert_eq!(ask(&turtl, json!(["l6", "user:login-from-saved", "99", key])).await["e"], json!(1));
}
async_test!(saved_login_flow, saved_login());

/// A note's file: saved encrypted under the note's key, uploaded by the file sync loop, then downloaded
/// and decrypted by a second device that knows the account only from the server.
async fn attachments() {
    let server = start_server().await;
    let first = test_turtl(&server);
    first.join(String::from("Files@Test.com"), String::from("filespassphrase")).await.unwrap();

    // a note with a file attached, the way the UI makes one (bytes that aren't text, on purpose)
    let space_id = lockr!(first.profile).spaces[0].id().unwrap().clone();
    let original: Vec<u8> = vec![72, 105, 0, 255, 254, 13, 10, 65, 66, 67, 0, 200, 100, 50];
    let added = ask(&first, json!(["f1", "profile:sync:model", "add", "note", {
        "space_id": space_id, "user_id": "0", "type": "file", "title": "with a file",
        "file": {"name": "hi.bin", "type": "application/octet-stream", "filedata": {"data": crypto::to_base64(&original).unwrap()}},
    }])).await;
    assert_eq!(added["e"], json!(0), "{}", added);
    let note_id = String::from(added["d"]["id"].as_str().unwrap());

    // it can be read back right away
    let read = ask(&first, json!(["f2", "profile:note:get-file", note_id])).await;
    assert_eq!(read["e"], json!(0), "{}", read);
    assert_eq!(crypto::from_base64(&String::from(read["d"].as_str().unwrap())).unwrap(), original);

    // what a server would hand a second device: the profile's records, and a `file` record for the note
    let mut for_second_device: Vec<Value> = {
        let db_guard = lock!(first.db);
        let records: Vec<SyncRecord> = db_guard.as_ref().unwrap().all("sync").unwrap();
        records.iter()
            .filter(|record| record.ty != crate::models::sync_record::SyncType::FileOutgoing)
            .map(|record| jedi::to_val(record).unwrap())
            .collect()
    };
    for_second_device.push(json!({
        "id": "file-sync-1", "type": "file", "action": "add", "item_id": note_id, "user_id": 42, "data": {"id": note_id},
    }));

    // the file loop uploads it
    first.sync_start().await.unwrap();
    let upload = format!("PUT /notes/{}/attachment", note_id);
    let mut tries = 0;
    while !requests(&server).await.contains(&upload) {
        tries += 1;
        assert!(tries < 150, "the file was never uploaded");
        exec::sleep(100).await;
    }
    first.sync_shutdown(true).await.unwrap();

    // the first device forgets its copy (natively the two "devices" would otherwise share the file)
    {
        let mut db_guard = lock!(first.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&note_id)).unwrap();
    }
    let gone = ask(&first, json!(["f3", "profile:note:get-file", note_id])).await;
    assert_eq!(gone["e"], json!(1), "the file is gone from the first device: {}", gone);

    // the second device logs in, syncs, and downloads the file
    let (username, passphrase) = (String::from("files@test.com"), String::from("filespassphrase"));
    let (_, auth) = crate::models::user::generate_auth(&username, &passphrase, 0).unwrap();
    let account_data: Value = {
        let api = Api::new();
        api.set_endpoint(Some(server.url.clone()));
        api.get("/users/42").unwrap().call().await.unwrap()
    };
    seed(&server, json!({"username": username, "auth": auth, "data": account_data}), json!(for_second_device)).await;
    let second = test_turtl(&server);
    second.login(username, passphrase).await.unwrap();
    second.sync_start().await.unwrap();
    let download = format!("GET /notes/{}/file", note_id);
    let mut tries = 0;
    loop {
        let read = ask(&second, json!(["f4", "profile:note:get-file", note_id])).await;
        if read["e"] == json!(0) {
            // it decrypts to the original, bytes and all
            assert_eq!(crypto::from_base64(&String::from(read["d"].as_str().unwrap())).unwrap(), original);
            break;
        }
        tries += 1;
        assert!(tries < 150, "the file was never downloaded: {}", read);
        exec::sleep(100).await;
    }
    assert!(requests(&server).await.contains(&download));
    second.sync_shutdown(true).await.unwrap();
}
async_test!(attachments_flow, attachments());

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

/// A core that runs without a server (`local_only`): accounts are made and logged into on this device,
/// what is saved is encrypted and never queued for a server, no request ever goes out, and what only a
/// server could do is refused.
async fn local_only() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();

    assert_eq!(ask(&turtl, json!(["l1", "user:local-accounts"])).await["d"], json!([]));

    // the rules for a passphrase are the same, and a refusal leaves nothing behind
    let refused = ask(&turtl, json!(["l2", "user:join", "Vault-One", "abc"])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("validation")), "{}", refused);
    assert!(!lockr!(turtl.user).logged_in);
    assert_eq!(ask(&turtl, json!(["l3", "user:local-accounts"])).await["d"], json!([]));

    // joining makes the account and logs in, with no spaces: nothing is made that wasn't asked for
    let joined = ask(&turtl, json!(["l4", "user:join", "Vault-One", "a passphrase to keep"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    assert_eq!(joined["d"]["username"], json!("vault-one"));
    let user_id = String::from(joined["d"]["id"].as_str().unwrap());
    assert!(!user_id.is_empty() && user_id != "42");
    {
        let user_guard = lockr!(turtl.user);
        assert!(user_guard.logged_in);
        assert!(user_guard.pubkey.is_some() && user_guard.privkey.is_some());
    }
    // the host is told who is logged in, and not the user's private key (which the core keeps to itself)
    assert!(joined["d"].get("privkey").is_none() && joined["d"].get("pubkey").is_some(), "{}", joined);
    let loaded = ask(&turtl, json!(["l4b", "profile:load"])).await;
    assert!(loaded["d"]["user"].get("privkey").is_none() && loaded["d"]["user"]["username"] == json!("vault-one"), "{}", loaded);
    assert_eq!(turtl.user_id().unwrap(), user_id);
    assert_eq!(lockr!(turtl.profile).spaces.len(), 0);
    assert_eq!(ask(&turtl, json!(["l5", "user:local-accounts"])).await["d"], json!(["vault-one"]));

    // nothing but a passphrase stands between this data and whoever copies it, so the passphrase costs
    // 128 MiB (scrypt, N = 2^17) to try, and the account says so: it is what logging in will use
    let record: Value = jedi::parse(&lockr!(turtl.kv).kv_get("local-account:vault-one").unwrap().unwrap()).unwrap();
    assert_eq!(record["kdf"], json!({"ops": 4194304, "mem": 134217728}));

    // a name can be had once; asking again changes nothing, whoever is logged in stays logged in
    let again = ask(&turtl, json!(["l6", "user:join", "VAULT-ONE", "another passphrase"])).await;
    assert_eq!((&again["e"], &again["d"]["subtype"]), (&json!(1), &json!("Conflict")), "{}", again);
    assert_eq!(turtl.user_id().unwrap(), user_id);

    // a space for a notebook and notes for its pages: saved, searchable, and not queued for anybody
    let space = ask(&turtl, json!(["l7", "profile:sync:model", "add", "space", {"user_id": "0", "title": "Journal", "color": "#408080"}])).await;
    assert_eq!(space["e"], json!(0), "{}", space);
    let space_id = String::from(space["d"]["id"].as_str().unwrap());
    assert_eq!(space["d"]["title"], json!("Journal"));
    let home_text = "====== Home ======\nThe vault door code is 7391.\n";
    for (mid, title, text) in &[("l8", "Home", home_text), ("l9", "Notes:Later", "Nothing to see.\n")] {
        let page = ask(&turtl, json!([mid, "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "text", "title": title, "text": text,
        }])).await;
        assert_eq!(page["e"], json!(0), "{}", page);
    }
    let found = ask(&turtl, json!(["l10", "profile:find-notes", {"space_id": space_id, "text": "vault"}])).await;
    assert_eq!(found["e"], json!(0), "{}", found);
    assert_eq!(found["d"]["total"], json!(1));
    assert_eq!(found["d"]["notes"][0]["title"], json!("Home"));
    assert_eq!(found["d"]["notes"][0]["text"], json!(home_text));
    // a note with a file, which is stored encrypted too, and is not queued for upload either
    let picture: Vec<u8> = vec![137, 80, 78, 71, 0, 255, 13, 10, 26, 10];
    let file_note = ask(&turtl, json!(["l10b", "profile:sync:model", "add", "note", {
        "space_id": space_id, "user_id": "0", "type": "file", "title": "Notes/picture.png",
        "file": {"name": "picture.png", "type": "image/png", "filedata": {"data": crypto::to_base64(&picture).unwrap()}},
    }])).await;
    assert_eq!(file_note["e"], json!(0), "{}", file_note);
    let file_note_id = String::from(file_note["d"]["id"].as_str().unwrap());
    let read = ask(&turtl, json!(["l10c", "profile:note:get-file", file_note_id])).await;
    assert_eq!(read["e"], json!(0), "{}", read);
    assert_eq!(crypto::from_base64(&String::from(read["d"].as_str().unwrap())).unwrap(), picture);
    let waiting = sync_records(&turtl.db);
    assert!(waiting.is_empty(), "nothing is queued for a server, but {} records are", waiting.len());

    // what only a server can do is refused: every command the dispatcher has, but the few a core without a
    // server answers, is turned away before it runs (so none can send anything, or hand out a secret)
    let commands = dispatcher_commands();
    assert!(commands.len() > 40 && commands.contains(&String::from("user:login")) && commands.contains(&String::from("feedback:send")), "{:?}", commands);
    for allowed in dispatch::LOCAL_COMMANDS {
        assert!(commands.iter().any(|c| c == allowed), "{} is allowed but is not a command", allowed);
    }
    for (i, command) in commands.iter().filter(|c| !dispatch::LOCAL_COMMANDS.contains(&c.as_str())).enumerate() {
        let refused = ask(&turtl, json!([format!("r{}", i), command])).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("permission_denied")), "{} was not refused: {}", command, refused);
    }
    // and whatever got past that, the core's way to a server is shut: nothing is built, let alone sent
    match turtl.api.get("/anything").map(|_| ()).unwrap_err().shed() {
        TError::ConnectionRequired => {}
        other => panic!("expected the api to refuse, got {:?}", other),
    }

    // logging in again needs the passphrase that was used, and an account that exists
    turtl.logout().unwrap();
    assert!(!lockr!(turtl.user).logged_in);
    for (mid, name, passphrase) in &[("l15", "vault-one", "not the passphrase"), ("l16", "nobody", "a passphrase to keep")] {
        let res = ask(&turtl, json!([mid, "user:login", name, passphrase])).await;
        assert_eq!((&res["e"], &res["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", res);
        assert!(!lockr!(turtl.user).logged_in);
    }
    let res = ask(&turtl, json!(["l17", "user:login", "VAULT-one", "a passphrase to keep"])).await;
    assert_eq!(res["e"], json!(0), "{}", res);
    assert_eq!(res["d"]["id"], json!(user_id));
    // the private part of the user record came back, so the key the passphrase makes is the right one
    assert!(lockr!(turtl.user).privkey.is_some());

    // not once did it ask a server for anything
    assert_eq!(requests(&server).await, Vec::<String>::new());

    // (natively the file is a file of the test run's, which is not left behind)
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&file_note_id)).unwrap();
    }
}
async_test!(local_only_flow, local_only());

/// Changes made between `profile:batch:begin` and `commit` are all kept, and between `begin` and `rollback`
/// all undone: new spaces and notes, edits, and deletes, in the database and in what the core holds in
/// memory (the profile, the search). Misuse is refused, and a core with a server doesn't batch at all.
async fn local_batches() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let joined = ask(&turtl, json!(["b0", "user:join", "Batch-Vault", "a passphrase for batches"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);

    let mut counter = 0;
    macro_rules! mid { () => {{ counter += 1; format!("b{}", counter) }} }
    macro_rules! ok { ($args:expr) => {{
        let res = ask(&turtl, $args).await;
        assert_eq!(res["e"], json!(0), "{}", res);
        res["d"].clone()
    }} }
    macro_rules! refused { ($args:expr) => {{
        let res = ask(&turtl, $args).await;
        assert_eq!(res["e"], json!(1), "should have been refused: {}", res);
        res["d"].clone()
    }} }
    let page = |space_id: &str, title: &str, text: &str| json!({
        "space_id": space_id, "user_id": "0", "type": "zim-page", "title": title, "text": text,
        "props": {"bom": title.len() % 2 == 0, "eol": "crlf", "modified": 1759000000000i64},
    });
    // the pages of a space as the core lists them: (title, text), by title
    macro_rules! pages_of { ($space_id:expr) => {{
        let found = ok!(json!([mid!(), "profile:find-notes", {"space_id": $space_id, "per_page": 1000}]));
        let mut pages: Vec<(String, String)> = found["notes"].as_array().unwrap().iter()
            .map(|note| (String::from(note["title"].as_str().unwrap()), String::from(note["text"].as_str().unwrap_or("")))).collect();
        pages.sort();
        assert_eq!(found["total"], json!(pages.len()));
        pages
    }} }
    let space_names = |turtl: &Turtl| -> Vec<String> {
        let mut names: Vec<String> = lockr!(turtl.profile).spaces.iter().map(|space| space.title.clone().unwrap()).collect();
        names.sort();
        names
    };

    // a notebook made as usual
    let space = ok!(json!([mid!(), "profile:sync:model", "add", "space", {"user_id": "0", "title": "Alpha", "color": "#408080"}]));
    let alpha = String::from(space["id"].as_str().unwrap());
    let one = ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&alpha, "One", "first\n")]));
    let two = ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&alpha, "Two", "second\n")]));
    let one_id = String::from(one["id"].as_str().unwrap());
    let two_id = String::from(two["id"].as_str().unwrap());
    assert_eq!(one["props"], json!({"bom": false, "eol": "crlf", "modified": 1759000000000i64}), "props come back as they went in");

    // a batch that is kept: a new space with pages, an edit, a delete
    ok!(json!([mid!(), "profile:batch:begin"]));
    let space = ok!(json!([mid!(), "profile:sync:model", "add", "space", {"user_id": "0", "title": "Beta", "color": "#439645"}]));
    let beta = String::from(space["id"].as_str().unwrap());
    for title in &["B1", "B2", "B3"] {
        ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&beta, title, &format!("text of {}\n", title))]));
    }
    ok!(json!([mid!(), "profile:sync:model", "edit", "note", {"id": one_id, "user_id": "0", "space_id": alpha, "type": "zim-page", "title": "One", "text": "first, edited\n"}]));
    ok!(json!([mid!(), "profile:sync:model", "delete", "note", {"id": two_id}]));
    // (inside the batch everything is already to be seen, the search included)
    assert_eq!(pages_of!(beta).len(), 3);
    ok!(json!([mid!(), "profile:batch:commit"]));
    assert_eq!(space_names(&turtl), vec!["Alpha", "Beta"]);
    assert_eq!(pages_of!(alpha), vec![(String::from("One"), String::from("first, edited\n"))]);
    assert_eq!(pages_of!(beta).len(), 3);
    let found = ok!(json!([mid!(), "profile:find-notes", {"space_id": beta, "text": "B2"}]));
    assert_eq!(found["total"], json!(1));

    // a batch that is thrown away: a new space and pages, an edit, a delete (of a page, and of a whole space)
    ok!(json!([mid!(), "profile:batch:begin"]));
    let space = ok!(json!([mid!(), "profile:sync:model", "add", "space", {"user_id": "0", "title": "Gamma", "color": "#800000"}]));
    let gamma = String::from(space["id"].as_str().unwrap());
    ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&gamma, "G1", "gamma\n")]));
    ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&alpha, "Three", "third\n")]));
    ok!(json!([mid!(), "profile:sync:model", "edit", "note", {"id": one_id, "user_id": "0", "space_id": alpha, "type": "zim-page", "title": "One", "text": "first, edited again\n"}]));
    ok!(json!([mid!(), "profile:sync:model", "delete", "note", {"id": one_id}]));
    ok!(json!([mid!(), "profile:sync:model", "delete", "space", {"id": beta}]));
    assert_eq!(space_names(&turtl), vec!["Alpha", "Gamma"], "inside the batch the changes are to be seen");
    ok!(json!([mid!(), "profile:batch:rollback"]));
    assert_eq!(space_names(&turtl), vec!["Alpha", "Beta"], "the new space is gone, the deleted one is back");
    assert_eq!(pages_of!(alpha), vec![(String::from("One"), String::from("first, edited\n"))]);
    assert_eq!(pages_of!(beta).len(), 3, "everything in the space that was deleted is back and can be found");
    let found = ok!(json!([mid!(), "profile:find-notes", {"space_id": beta, "text": "B2"}]));
    assert_eq!(found["total"], json!(1));
    assert_eq!(pages_of!(gamma), Vec::<(String, String)>::new());
    let profile = ok!(json!([mid!(), "profile:load"]));
    assert_eq!(profile["spaces"].as_array().unwrap().len(), 2);

    // a change that fails in the middle of a batch is undone with the rest, by whoever opened it
    ok!(json!([mid!(), "profile:batch:begin"]));
    ok!(json!([mid!(), "profile:sync:model", "add", "note", page(&alpha, "Half", "half\n")]));
    let refusal = refused!(json!([mid!(), "profile:sync:model", "add", "note", {"space_id": alpha, "user_id": "0", "title": "no type"}]));
    assert_eq!(refusal["type"], json!("validation"));
    ok!(json!([mid!(), "profile:batch:rollback"]));
    assert_eq!(pages_of!(alpha).len(), 1);

    // a file in a batch that is thrown away is not there afterwards (natively the file itself stays on
    // disk, without a note: the note is what makes it reachable)
    ok!(json!([mid!(), "profile:batch:begin"]));
    let file_note = ok!(json!([mid!(), "profile:sync:model", "add", "note", {
        "space_id": alpha, "user_id": "0", "type": "zim-file", "title": "One/pic.png",
        "file": {"name": "One/pic.png", "type": "image/png", "filedata": {"data": crypto::to_base64(&vec![1u8, 2, 3]).unwrap()}},
    }]));
    let file_note_id = String::from(file_note["id"].as_str().unwrap());
    ok!(json!([mid!(), "profile:note:get-file", file_note_id]));
    ok!(json!([mid!(), "profile:batch:rollback"]));
    let gone = refused!(json!([mid!(), "profile:note:get-file", file_note_id]));
    assert_eq!(gone["type"], json!("not_found"));

    // misuse: no batch open, or one already
    refused!(json!([mid!(), "profile:batch:commit"]));
    refused!(json!([mid!(), "profile:batch:rollback"]));
    assert_eq!(space_names(&turtl), vec!["Alpha", "Beta"], "a refused rollback changes nothing");
    ok!(json!([mid!(), "profile:batch:begin"]));
    refused!(json!([mid!(), "profile:batch:begin"]));
    ok!(json!([mid!(), "profile:batch:commit"]));

    // nothing was ever queued for a server, and none was asked for anything
    assert!(sync_records(&turtl.db).is_empty());
    assert_eq!(requests(&server).await, Vec::<String>::new());

    // a core with a server doesn't batch: a sync loop could send what a rollback then takes back
    let other = test_turtl(&server);
    other.join(String::from("Batch@Test.com"), String::from("batchpassphrase")).await.unwrap();
    let refusal = ask(&other, json!(["b-server", "profile:batch:begin"])).await;
    assert_eq!(refusal["e"], json!(1), "{}", refusal);
}
async_test!(local_batches_flow, local_batches());

/// Every command the dispatcher has an arm for, once each, read from its own source so that a command added
/// later can't be left out of what is checked.
fn dispatcher_commands() -> Vec<String> {
    let source = include_str!("dispatch.rs");
    let commands = source.split("async fn dispatch_event").next().unwrap();
    let mut found: Vec<String> = Vec::new();
    for line in commands.lines() {
        // an arm is `"command" =>`, or `"command" | "another" =>` for a few that are one
        if let Some(arrow) = line.find("=>") {
            let head = line[..arrow].trim();
            let alternatives: Vec<&str> = head.split('|').map(|alternative| alternative.trim()).collect();
            if head.starts_with('"') && alternatives.iter().all(|a| a.len() >= 2 && a.starts_with('"') && a.ends_with('"') && !a[1..a.len() - 1].contains('"')) {
                found.extend(alternatives.iter().map(|a| String::from(&a[1..a.len() - 1])));
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// A message that can't be read is still answered when it says who sent it, and one that is not even
/// shaped like a request is not a panic.
async fn unreadable_messages() {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    // a lone surrogate in a JSON string is not something the parser takes (JavaScript's JSON.stringify can write one)
    dispatch::process(&turtl, &String::from("[\"u1\",\"ping\",\"\\ud800\"]")).await.unwrap();
    let mut answer = None;
    while let Some(msg) = crate::recv_nb(None).unwrap() {
        let res: Value = jedi::parse(&msg).unwrap();
        if res["id"] == json!("u1") {
            answer = Some(res);
        }
    }
    let answer = answer.expect("the message that couldn't be read got no answer");
    assert_eq!((&answer["e"], &answer["d"]["type"]), (&json!(1), &json!("json_error")), "{}", answer);
    // not shaped like a request, or too short to be anything, or starting in the middle of a character
    for junk in &["", "x", "[", "\u{e9}\u{e9}\u{e9}", "[1,2", "::ev", "\u{1F600}\u{1F600}"] {
        let _ = dispatch::process(&turtl, &String::from(*junk)).await;
    }
}
async_test!(unreadable_messages_flow, unreadable_messages());

/// The files of notes that are deleted are deleted with them, one note's or a notebook's, and in a batch only
/// when the batch is kept.
async fn local_files_follow_their_notes() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let joined = ask(&turtl, json!(["f0", "user:join", "Files-Vault", "a passphrase for files"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    let space = ask(&turtl, json!(["f1", "profile:sync:model", "add", "space", {"user_id": "0", "title": "Files", "color": "#408080"}])).await;
    let space_id = String::from(space["d"]["id"].as_str().unwrap());
    let mut counter = 0;
    macro_rules! file_note { ($name:expr) => {{
        counter += 1;
        let made = ask(&turtl, json!([format!("f-add-{}", counter), "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "zim-file", "title": $name,
            "file": {"name": $name, "type": "application/octet-stream", "filedata": {"data": crypto::to_base64(&vec![1u8, 2, 3, counter as u8]).unwrap()}},
        }])).await;
        assert_eq!(made["e"], json!(0), "{}", made);
        String::from(made["d"]["id"].as_str().unwrap())
    }} }
    let has_file = |turtl: &Turtl, note_id: &String| {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_get(db_guard.as_mut().unwrap(), None, note_id).is_ok()
    };

    // a note deleted: its file is gone with it (the file had not been, since a deleted note doesn't know whose it was)
    let one = file_note!("one.bin");
    assert!(has_file(&turtl, &one));
    let deleted = ask(&turtl, json!(["f2", "profile:sync:model", "delete", "note", {"id": one}])).await;
    assert_eq!(deleted["e"], json!(0), "{}", deleted);
    assert!(!has_file(&turtl, &one), "the file of a deleted note is still there");

    // a notebook deleted: all of its notes' files
    let (two, three) = (file_note!("two.bin"), file_note!("three.bin"));
    let gone = ask(&turtl, json!(["f3", "profile:sync:model", "delete", "space", {"id": space_id}])).await;
    assert_eq!(gone["e"], json!(0), "{}", gone);
    assert!(!has_file(&turtl, &two) && !has_file(&turtl, &three), "the files of a deleted notebook are still there");
}
async_test!(local_files_follow_their_notes_flow, local_files_follow_their_notes());

/// A file is a file on disk natively, which a rolled-back batch can't bring back: it goes when the batch that
/// deleted its note is kept, and stays when it isn't.
#[cfg(not(target_arch = "wasm32"))]
async fn local_files_in_batches() {
    let _folder = DiskFolder::new("local-files-in-batches");
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let joined = ask(&turtl, json!(["b0", "user:join", "Batch-Files", "a passphrase for batches"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    let space = ask(&turtl, json!(["b1", "profile:sync:model", "add", "space", {"user_id": "0", "title": "Files", "color": "#408080"}])).await;
    let space_id = String::from(space["d"]["id"].as_str().unwrap());
    let make = |mid: &str| json!([mid, "profile:sync:model", "add", "note", {
        "space_id": space_id, "user_id": "0", "type": "zim-file", "title": "a.bin",
        "file": {"name": "a.bin", "type": "application/octet-stream", "filedata": {"data": crypto::to_base64(&vec![9u8, 8, 7]).unwrap()}},
    }]);
    let note = String::from(ask(&turtl, make("b2")).await["d"]["id"].as_str().unwrap());
    let on_disk = || !crate::models::file::FileData::file_finder_all(None, Some(&note)).unwrap().is_empty();
    assert!(on_disk());

    // deleted in a batch that is undone: the note is back, and so is its file
    assert_eq!(ask(&turtl, json!(["b3", "profile:batch:begin"])).await["e"], json!(0));
    assert_eq!(ask(&turtl, json!(["b4", "profile:sync:model", "delete", "note", {"id": note}])).await["e"], json!(0));
    assert!(on_disk(), "the file went before the batch was kept");
    assert_eq!(ask(&turtl, json!(["b5", "profile:batch:rollback"])).await["e"], json!(0));
    assert!(on_disk(), "a rolled-back delete took the file");
    let read = ask(&turtl, json!(["b6", "profile:note:get-file", note])).await;
    assert_eq!(crypto::from_base64(&String::from(read["d"].as_str().unwrap())).unwrap(), vec![9u8, 8, 7]);

    // and in one that is kept: gone
    assert_eq!(ask(&turtl, json!(["b7", "profile:batch:begin"])).await["e"], json!(0));
    assert_eq!(ask(&turtl, json!(["b8", "profile:sync:model", "delete", "note", {"id": note}])).await["e"], json!(0));
    assert!(on_disk());
    assert_eq!(ask(&turtl, json!(["b9", "profile:batch:commit"])).await["e"], json!(0));
    assert!(!on_disk(), "a kept delete left the file");
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(local_files_in_batches_flow, local_files_in_batches());

/// A stored account that asks for more than a device can do to log in is refused without trying, and an
/// account whose user record the key does not open is not left logged in.
async fn local_account_tampered() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let joined = ask(&turtl, json!(["t0", "user:join", "Tamper-Vault", "a passphrase to tamper with"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    turtl.logout().unwrap();
    let key = "local-account:tamper-vault";
    let stored = lockr!(turtl.kv).kv_get(key).unwrap().unwrap();
    let record: Value = jedi::parse(&stored).unwrap();
    let with_cost = |ops: i64, mem: i64| {
        let mut changed = record.clone();
        changed["kdf"] = json!({"ops": ops, "mem": mem});
        changed
    };
    // (the mem and the ops of what a vault is made at, and more than the most a record may ask)
    for (n, (ops, mem)) in [(1i64 << 40, 134217728i64), (4194304, 1i64 << 31), (1 << 26, 134217728), (4194304, (1i64 << 30) + 1)].iter().enumerate() {
        lockr!(turtl.kv).kv_set(key, &jedi::stringify(&with_cost(*ops, *mem)).unwrap()).unwrap();
        let started = crate::util::get_time();
        let refused = ask(&turtl, json!([format!("t{}", n + 1), "user:login", "tamper-vault", "a passphrase to tamper with"])).await;
        // (a cost that doesn't fit the machine's `usize`, 32 bits on wasm32, is refused already when the record is read)
        let fits = (*ops as u64) <= usize::MAX as u64 && (*mem as u64) <= usize::MAX as u64;
        let kind = if fits { "bad_value" } else { "json_error" };
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!(kind)), "ops {} mem {}: {}", ops, mem, refused);
        let took = (crate::util::get_time() - started).num_milliseconds();
        assert!(took < 2000, "it should be refused without trying, not after {} ms", took);
        assert!(!lockr!(turtl.user).logged_in);
    }
    // another account's user record under this account's key: the passphrase is right, the record is not what the key opens
    lockr!(turtl.kv).kv_set(key, &jedi::stringify(&{
        let mut changed = record.clone();
        changed["data"]["body"] = json!("AAYBAAzWT6T3jTOu+I0DN7GKxgMocHTwkFPADW6pogRjUDo=");
        changed
    }).unwrap()).unwrap();
    let broken = ask(&turtl, json!(["t9", "user:login", "tamper-vault", "a passphrase to tamper with"])).await;
    assert_eq!(broken["e"], json!(1), "{}", broken);
    assert!(!lockr!(turtl.user).logged_in, "a record that the key doesn't open was left logged in");
    assert!(crate::models::protected::Protected::key(&*lockr!(turtl.user)).is_none(), "and the key was left in memory");
    // put back, it logs in
    lockr!(turtl.kv).kv_set(key, &stored).unwrap();
    let back = ask(&turtl, json!(["t10", "user:login", "tamper-vault", "a passphrase to tamper with"])).await;
    assert_eq!(back["e"], json!(0), "{}", back);
}
async_test!(local_account_tampered_flow, local_account_tampered());

// ---------------------------------------------------------------------------------------------
// the passphrase of an account on this device
// ---------------------------------------------------------------------------------------------

const PICTURE: [u8; 10] = [137, 80, 78, 71, 0, 255, 13, 10, 26, 10];

/// The ids of what `vault_of_two` made: the two notebooks, and the note that holds the file.
struct TwoNotebooks {
    journal: String,
    work: String,
    file_note: String,
}

/// A vault of two notebooks, "Journal" (a page and a file) and "Work" (a page), made as the account `name` of
/// `turtl` with the passphrase `passphrase`.
async fn vault_of_two(turtl: &Turtl, name: &str, passphrase: &str) -> TwoNotebooks {
    let joined = ask(turtl, json!(["m-join", "user:join", name, passphrase])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    let mut spaces = Vec::new();
    for title in &["Journal", "Work"] {
        let space = ask(turtl, json!(["m-space", "profile:sync:model", "add", "space", {"user_id": "0", "title": title, "color": "#408080"}])).await;
        assert_eq!(space["e"], json!(0), "{}", space);
        let id = String::from(space["d"]["id"].as_str().unwrap());
        let page = ask(turtl, json!(["m-page", "profile:sync:model", "add", "note", {
            "space_id": id, "user_id": "0", "type": "zim-page", "title": format!("{} page", title),
            "text": format!("The {} door code is 7391.\n", title),
        }])).await;
        assert_eq!(page["e"], json!(0), "{}", page);
        spaces.push(id);
    }
    let file_note = ask(turtl, json!(["m-file", "profile:sync:model", "add", "note", {
        "space_id": spaces[0], "user_id": "0", "type": "zim-file", "title": "Journal page/picture.png",
        "file": {"name": "picture.png", "type": "image/png", "filedata": {"data": crypto::to_base64(&PICTURE.to_vec()).unwrap()}},
    }])).await;
    assert_eq!(file_note["e"], json!(0), "{}", file_note);
    TwoNotebooks {
        journal: spaces[0].clone(),
        work: spaces[1].clone(),
        file_note: String::from(file_note["d"]["id"].as_str().unwrap()),
    }
}

/// What `vault_of_two` made, read back through the core: every notebook there should be (the two, and the
/// `others`), the pages and the search of the two, the file, and the private part of the user's record.
async fn assert_vault_reads(turtl: &Turtl, vault: &TwoNotebooks, others: &[&str]) {
    let profile = ask(turtl, json!(["r-profile", "profile:load"])).await;
    assert_eq!(profile["e"], json!(0), "{}", profile);
    let mut titles: Vec<String> = profile["d"]["spaces"].as_array().unwrap().iter().map(|space| String::from(space["title"].as_str().unwrap())).collect();
    titles.sort();
    let mut wanted: Vec<String> = vec!["Journal", "Work"].into_iter().chain(others.iter().cloned()).map(String::from).collect();
    wanted.sort();
    assert_eq!(titles, wanted);
    for (space, title) in &[(&vault.journal, "Journal"), (&vault.work, "Work")] {
        let found = ask(turtl, json!(["r-find", "profile:find-notes", {"space_id": space, "text": "door", "per_page": 100}])).await;
        assert_eq!(found["e"], json!(0), "{}", found);
        assert_eq!(found["d"]["total"], json!(1), "{}", found);
        assert_eq!(found["d"]["notes"][0]["title"], json!(format!("{} page", title)));
        assert_eq!(found["d"]["notes"][0]["text"], json!(format!("The {} door code is 7391.\n", title)));
    }
    let file = ask(turtl, json!(["r-file", "profile:note:get-file", vault.file_note])).await;
    assert_eq!(file["e"], json!(0), "{}", file);
    assert_eq!(crypto::from_base64(&String::from(file["d"].as_str().unwrap())).unwrap(), PICTURE.to_vec());
    assert!(lockr!(turtl.user).privkey.is_some(), "the private part of the user's record did not come back");
}

/// The key the user in memory has.
fn user_key(turtl: &Turtl) -> crypto::Key {
    crate::models::protected::Protected::key_or_else(&*lockr!(turtl.user)).unwrap()
}

/// How many of the rows of a table of the user's database `key` opens, and how many there are.
fn rows_opened_by<T>(turtl: &Turtl, key: &crypto::Key) -> (usize, usize)
    where T: crate::models::protected::Protected + crate::models::storable::Storable
{
    use crate::models::protected::Protected;
    let db_guard = lock!(turtl.db);
    let rows: Vec<T> = db_guard.as_ref().unwrap().all(T::tablename()).unwrap();
    let total = rows.len();
    let opened = rows.iter().filter(|row| {
        let mut copy = Protected::clone(*row).unwrap();
        copy.set_key(Some(key.clone()));
        Protected::deserialize(&mut copy).is_ok()
    }).count();
    (opened, total)
}

fn keys_opened_by(turtl: &Turtl, key: &crypto::Key) -> (usize, usize) {
    rows_opened_by::<crate::models::keychain::KeychainEntry>(turtl, key)
}

/// What is kept of an account on the device, as the two files it is in have it: the record of the account (in
/// the key-value store) and the keys of the notebooks (in the user's database). To put a vault back in a state
/// it was in, as a crash would have left it.
struct Kept {
    record: String,
    keys: Vec<crate::models::keychain::KeychainEntry>,
}

impl Kept {
    /// Just the record, for when there is no database open to read the keys from.
    fn of_the_record(turtl: &Turtl, name: &str) -> String {
        lockr!(turtl.kv).kv_get(&format!("local-account:{}", name)).unwrap().unwrap()
    }

    fn of(turtl: &Turtl, name: &str) -> Kept {
        let record = lockr!(turtl.kv).kv_get(&format!("local-account:{}", name)).unwrap().unwrap();
        let db_guard = lock!(turtl.db);
        Kept { record: record, keys: db_guard.as_ref().unwrap().all("keychain").unwrap() }
    }

    fn put_back(&self, turtl: &Turtl, name: &str) {
        lockr!(turtl.kv).kv_set(&format!("local-account:{}", name), &self.record).unwrap();
        let db_guard = lock!(turtl.db);
        let db = db_guard.as_ref().unwrap();
        let now: Vec<crate::models::keychain::KeychainEntry> = db.all("keychain").unwrap();
        db.begin().unwrap();
        for row in &now { db.delete(row).unwrap(); }
        for row in &self.keys { db.save(row).unwrap(); }
        db.commit().unwrap();
    }

    /// The rows as they are stored, by id.
    fn rows(&self) -> Vec<Value> {
        let mut rows: Vec<Value> = self.keys.iter().map(|row| crate::models::protected::Protected::data_for_storage(row).unwrap()).collect();
        rows.sort_by_key(|row| row["id"].as_str().unwrap().to_owned());
        rows
    }

    fn record(&self) -> Value {
        jedi::parse(&self.record).unwrap()
    }
}

/// Log in as `Turtl::login` does after it has opened the user's database, but on the database that is open: an
/// in-memory one is gone as soon as it is closed (what survives a restart is for the tests that have files). Says
/// whether a change of passphrase that was stopped half way was settled by it, and which way.
async fn relogin(turtl: &Turtl, name: &str, passphrase: &str) -> crate::error::TResult<Option<bool>> {
    User::logout(turtl)?;
    *lockw!(turtl.profile) = crate::profile::Profile::new();
    User::login(turtl, String::from(name), String::from(passphrase), crate::models::user::CURRENT_AUTH_VERSION).await?;
    match turtl.local_start() {
        Ok(settled) => Ok(settled),
        Err(e) => {
            User::logout(turtl)?;
            Err(e)
        }
    }
}

fn assert_unauthorized<T: ::std::fmt::Debug>(result: crate::error::TResult<T>) {
    match result.unwrap_err().shed() {
        TError::Api(status, _) => assert_eq!(status, StatusCode::UNAUTHORIZED),
        other => panic!("expected the login to be refused, got {:?}", other),
    }
}

/// Changing the passphrase of an account on this device: what is wrong is refused and changes nothing, what is
/// right seals the keys of the notebooks (and the private part of the user's record) with the key the new
/// passphrase makes, the vault goes on working, and from then on only the new passphrase opens it.
async fn local_passphrase_change() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "change-vault";
    let vault = vault_of_two(&turtl, name, first).await;
    let mut counter = 0;
    macro_rules! mid { () => {{ counter += 1; format!("c{}", counter) }} }
    macro_rules! ok { ($args:expr) => {{
        let res = ask(&turtl, $args).await;
        assert_eq!(res["e"], json!(0), "{}", res);
        res["d"].clone()
    }} }
    // the user's own row too (what a host that saves the user's settings has): it is sealed with the user's key
    ok!(json!([mid!(), "profile:sync:model", "edit", "user", {"settings": {"theme": "dark"}}]));

    let old_key = user_key(&turtl);
    let before = Kept::of(&turtl, name);
    assert!(before.record().get("pending").is_none(), "{}", before.record);
    assert_eq!(keys_opened_by(&turtl, &old_key), (2, 2));
    assert_eq!(rows_opened_by::<User>(&turtl, &old_key), (1, 1));

    // what is refused changes nothing: not the record, not the keys, and the vault goes on as it was
    let still_as_it_was = |turtl: &Turtl, what: &str| {
        let now = Kept::of(turtl, name);
        assert_eq!(now.record, before.record, "{}: the record was changed", what);
        assert_eq!(now.rows(), before.rows(), "{}: the keys were changed", what);
        assert_eq!(user_key(turtl).data(), old_key.data(), "{}: the key in memory was changed", what);
    };
    let refused = ask(&turtl, json!([mid!(), "user:change-passphrase", "not the passphrase", second])).await;
    assert_eq!((&refused["e"], &refused["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", refused);
    still_as_it_was(&turtl, "a wrong current passphrase");
    for (new, kind) in &[("abc", "validation"), ("password", "validation"), (first, "bad_value")] {
        let refused = ask(&turtl, json!([mid!(), "user:change-passphrase", first, new])).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!(kind)), "{}: {}", new, refused);
        still_as_it_was(&turtl, new);
    }
    ok!(json!([mid!(), "profile:batch:begin"]));
    let refused = ask(&turtl, json!([mid!(), "user:change-passphrase", first, second])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert!(refused["d"]["message"].as_str().unwrap().contains("has to be kept or undone first"), "refused for another reason: {}", refused);
    ok!(json!([mid!(), "profile:batch:rollback"]));
    still_as_it_was(&turtl, "a batch that is open");
    // a core that is not logged in has nothing to change, and a core with a server has its own way
    let nobody = {
        let mut other = test_turtl(&server);
        other.make_local_only();
        other
    };
    let refused = ask(&nobody, json!(["n1", "user:change-passphrase", first, second])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    let with_a_server = test_turtl(&server);
    let refused = ask(&with_a_server, json!(["n2", "user:change-passphrase", first, second])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("permission_denied")), "{}", refused);
    assert!(requests(&server).await.is_empty());

    // the change
    let changed = ok!(json!([mid!(), "user:change-passphrase", first, second]));
    // (the two notebooks' keys, and the user's own row)
    assert_eq!(changed, json!({"sealed": 3, "unreadable": 0}));
    let new_key = user_key(&turtl);
    assert_ne!(new_key.data(), old_key.data());
    let after = Kept::of(&turtl, name);
    assert!(after.record().get("pending").is_none(), "{}", after.record);
    for field in &["id", "kdf"] {
        assert_eq!(after.record()[field], before.record()[field], "{}", field);
    }
    assert_ne!(after.record()["auth"], before.record()["auth"]);
    assert_ne!(after.record()["data"]["body"], before.record()["data"]["body"]);
    assert_eq!(after.record()["data"]["username"], before.record()["data"]["username"]);
    assert_eq!(after.record()["data"]["pubkey"], before.record()["data"]["pubkey"]);
    let fields = |record: &Value| -> Vec<String> { record["data"].as_object().unwrap().keys().cloned().collect() };
    assert_eq!(fields(&after.record()), fields(&before.record()), "the user data has what it had");
    // everything the user's key seals is sealed with the new one, and nothing with the old
    assert_eq!(keys_opened_by(&turtl, &new_key), (2, 2));
    assert_eq!(keys_opened_by(&turtl, &old_key), (0, 2));
    assert_eq!(rows_opened_by::<User>(&turtl, &new_key), (1, 1));
    assert_eq!(rows_opened_by::<User>(&turtl, &old_key), (0, 1));

    // the vault goes on: what was there reads, and a notebook made now has its key sealed with the new key
    assert_vault_reads(&turtl, &vault, &[]).await;
    let later = ok!(json!([mid!(), "profile:sync:model", "add", "space", {"user_id": "0", "title": "Later", "color": "#800000"}]));
    let later_id = String::from(later["id"].as_str().unwrap());
    ok!(json!([mid!(), "profile:sync:model", "add", "note", {"space_id": later_id, "user_id": "0", "type": "zim-page", "title": "Later page", "text": "written after the change\n"}]));
    assert_eq!(keys_opened_by(&turtl, &new_key), (3, 3));
    assert_eq!(keys_opened_by(&turtl, &old_key), (0, 3));

    // the old passphrase opens nothing now, and the new one opens everything, as the passphrase of the account
    assert_unauthorized(relogin(&turtl, name, first).await);
    assert!(!lockr!(turtl.user).logged_in);
    relogin(&turtl, name, second).await.unwrap();
    assert_eq!(user_key(&turtl).data(), new_key.data());
    assert_vault_reads(&turtl, &vault, &["Later"]).await;
    let found = ok!(json!([mid!(), "profile:find-notes", {"space_id": later_id, "text": "change"}]));
    assert_eq!(found["total"], json!(1), "{}", found);
    // (and a vault can be changed again: what a change leaves is what a new account has)
    let third = "the third passphrase of this vault";
    let changed = ok!(json!([mid!(), "user:change-passphrase", second, third]));
    assert_eq!(changed, json!({"sealed": 4, "unreadable": 0}));
    assert_unauthorized(relogin(&turtl, name, second).await);
    relogin(&turtl, name, third).await.unwrap();
    assert_vault_reads(&turtl, &vault, &["Later"]).await;

    // nothing was queued for a server, and none was asked for anything
    assert!(sync_records(&turtl.db).is_empty());
    assert_eq!(requests(&server).await, Vec::<String>::new());
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
}
async_test!(local_passphrase_change_flow, local_passphrase_change());

/// A change that stops half way (the page is closed, the device loses power, the disk is full) leaves a vault
/// that the passphrase typed next puts right: the new one finishes the change and the old one undoes it, from
/// whichever state it was left in, and either way the keys are the ones that passphrase makes. And a vault that
/// was left damaged on top of that is not lost.
async fn local_passphrase_change_interrupted() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "stopped-vault";
    let vault = vault_of_two(&turtl, name, first).await;
    let before = Kept::of(&turtl, name);

    // a change as far as each of its writes goes: the record has the two passphrases (and the keys are the old),
    // then the keys are sealed with the new one too (and the record still has both)
    let change = User::prepare_local_change(&turtl, &String::from(first), &String::from(second)).unwrap();
    let (old_key, new_key) = (change.old_key.clone(), change.new_key.clone());
    assert_eq!(Kept::of(&turtl, name).record, before.record, "working a change out writes nothing");
    User::begin_local_change(&turtl, &change).unwrap();
    let written = Kept::of(&turtl, name);
    assert!(written.record().get("pending").is_some(), "{}", written.record);
    assert_eq!(written.rows(), before.rows());
    User::rekey_local_keys(&turtl, &change).unwrap();
    let sealed = Kept::of(&turtl, name);
    assert!(sealed.record().get("pending").is_some());
    assert_ne!(sealed.rows(), before.rows());
    assert_eq!(keys_opened_by(&turtl, &new_key), (2, 2));
    drop(change);

    // each state, with each passphrase
    for (state, kept, sealed_with) in &[("written", &written, &old_key), ("sealed", &sealed, &new_key)] {
        for (typed, other, typed_key, other_key) in &[(first, second, &old_key, &new_key), (second, first, &new_key, &old_key)] {
            let what = format!("{}, then {:?}", state, typed);
            kept.put_back(&turtl, name);
            assert_eq!(keys_opened_by(&turtl, sealed_with), (2, 2), "{}: not the state it was meant to be", what);
            let settled = relogin(&turtl, name, typed).await.unwrap_or_else(|e| panic!("{}: {}", what, e));
            // (which way it went is told: the passphrase typed is the one the vault has, and the person may not have expected that)
            assert_eq!(settled, Some(*typed == second), "{}", what);
            assert_eq!(user_key(&turtl).data(), typed_key.data(), "{}", what);
            let settled = Kept::of(&turtl, name);
            assert!(settled.record().get("pending").is_none(), "{}: {}", what, settled.record);
            assert_eq!(keys_opened_by(&turtl, typed_key), (2, 2), "{}", what);
            assert_eq!(keys_opened_by(&turtl, other_key), (0, 2), "{}", what);
            if *typed == first {
                // undone: the account is what it was, to the byte
                assert_eq!(settled.record, before.record, "{}", what);
            } else {
                assert_eq!(settled.record()["auth"], written.record()["pending"]["auth"], "{}", what);
                assert_eq!(settled.record()["data"], written.record()["pending"]["data"], "{}", what);
            }
            assert_vault_reads(&turtl, &vault, &[]).await;
            // the other passphrase is not the account's any more, and the one typed goes on being: logging in is
            // what it always is, and settles nothing a second time
            assert_unauthorized(relogin(&turtl, name, other).await);
            assert_eq!(relogin(&turtl, name, typed).await.unwrap(), None, "{}: there was nothing to settle the second time", what);
            assert_eq!(Kept::of(&turtl, name).record, settled.record, "{}", what);
            assert_eq!(Kept::of(&turtl, name).rows().len(), 2);
        }
    }

    // a change can't be begun on top of one that is not finished
    written.put_back(&turtl, name);
    let refused = ask(&turtl, json!(["s1", "user:change-passphrase", first, "the third passphrase of this vault"])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert!(refused["d"]["message"].as_str().unwrap().contains("not finished"), "refused for another reason: {}", refused);
    assert_eq!(Kept::of(&turtl, name).record, written.record);

    // damage: a sealed key that can't be opened. What can be done is done, and what can't is refused, whole,
    // so that the other passphrase still can.
    let spoil = |kept: &Kept, field: &str, with: &str| -> Kept {
        let mut record = kept.record();
        let other = record["pending"][with].clone();
        record["pending"][field] = other;
        Kept { record: jedi::stringify(&record).unwrap(), keys: kept.keys.iter().map(|row| crate::models::protected::Protected::clone(row).unwrap()).collect() }
    };
    // (the keys are under the old key: the old passphrase doesn't need the other key to put them right)
    let damaged = spoil(&written, "new_under_old", "old_under_new");
    damaged.put_back(&turtl, name);
    relogin(&turtl, name, first).await.unwrap();
    assert_eq!(Kept::of(&turtl, name).record, before.record);
    assert_vault_reads(&turtl, &vault, &[]).await;
    // (the new passphrase would need it, to open the keys that are under the old key: nothing is written, and the old one still opens it)
    let damaged = spoil(&written, "old_under_new", "new_under_old");
    damaged.put_back(&turtl, name);
    let refused = relogin(&turtl, name, second).await.unwrap_err();
    assert!(refused.to_string().contains("left in the middle of a change of passphrase"), "{}", refused);
    assert!(!lockr!(turtl.user).logged_in, "a vault that could not be put right was left logged in");
    assert_eq!(Kept::of(&turtl, name).record, damaged.record, "nothing is written when it can't be put right");
    assert_eq!(Kept::of(&turtl, name).rows(), damaged.rows());
    relogin(&turtl, name, first).await.unwrap();
    assert_eq!(Kept::of(&turtl, name).record, before.record);
    assert_vault_reads(&turtl, &vault, &[]).await;
    // (and the other way round, with the keys under the new key)
    let damaged = spoil(&sealed, "new_under_old", "old_under_new");
    damaged.put_back(&turtl, name);
    let refused = relogin(&turtl, name, first).await.unwrap_err();
    assert!(refused.to_string().contains("left in the middle of a change of passphrase"), "{}", refused);
    assert_eq!(Kept::of(&turtl, name).record, damaged.record);
    assert_eq!(Kept::of(&turtl, name).rows(), damaged.rows());
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    let damaged = spoil(&sealed, "old_under_new", "new_under_old");
    damaged.put_back(&turtl, name);
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert!(Kept::of(&turtl, name).record().get("pending").is_none());

    assert_eq!(requests(&server).await, Vec::<String>::new());
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
}
async_test!(local_passphrase_change_interrupted_flow, local_passphrase_change_interrupted());

/// An account made before its cost was kept with it (at what a Turtl server's accounts cost, 16 MiB) is moved to the
/// cost a vault is made at when its passphrase is changed; and while a change of such an account is not finished
/// the two passphrases, which make their keys at different costs, both open it.
async fn local_passphrase_change_of_an_old_account() {
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "old-vault";
    let vault = {
        let _at_the_old_cost = crate::models::user::ServerCostAccounts::new();
        vault_of_two(&turtl, name, first).await
    };
    // (what was kept then has no cost in its record)
    {
        let mut record = Kept::of(&turtl, name).record();
        assert_eq!(record["kdf"], json!({"ops": 524288, "mem": 16777216}));
        record.as_object_mut().unwrap().remove("kdf");
        lockr!(turtl.kv).kv_set(&format!("local-account:{}", name), &jedi::stringify(&record).unwrap()).unwrap();
    }
    relogin(&turtl, name, first).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    let before = Kept::of(&turtl, name);

    // stopped after the record was written: the new passphrase is made at the cost of a vault, the old at the old
    let change = User::prepare_local_change(&turtl, &String::from(first), &String::from(second)).unwrap();
    User::begin_local_change(&turtl, &change).unwrap();
    let written = Kept::of(&turtl, name);
    assert_eq!(written.record()["pending"]["kdf"], json!({"ops": 4194304, "mem": 134217728}));
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert_eq!(Kept::of(&turtl, name).record()["kdf"], json!({"ops": 4194304, "mem": 134217728}), "finishing it moves the account to the new cost");
    assert_unauthorized(relogin(&turtl, name, first).await);
    written.put_back(&turtl, name);
    relogin(&turtl, name, first).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert_eq!(Kept::of(&turtl, name).record()["kdf"], json!({"ops": 524288, "mem": 16777216}), "undoing it leaves the account at the cost it had");
    assert!(Kept::of(&turtl, name).record().get("pending").is_none());

    // and changed in one go
    before.put_back(&turtl, name);
    relogin(&turtl, name, first).await.unwrap();
    let changed = ask(&turtl, json!(["o1", "user:change-passphrase", first, second])).await;
    assert_eq!(changed["e"], json!(0), "{}", changed);
    assert_eq!(Kept::of(&turtl, name).record()["kdf"], json!({"ops": 4194304, "mem": 134217728}));
    assert_unauthorized(relogin(&turtl, name, first).await);
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
}
async_test!(local_passphrase_change_of_an_old_account_flow, local_passphrase_change_of_an_old_account());

/// A key that nothing opens (damage, or the key of a notebook that was lost) does not stop the passphrase from being
/// changed: it is counted, and left as it was; every key that opens is sealed with the new key.
async fn local_passphrase_change_with_a_dead_key() {
    use crate::models::protected::Protected;
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "dead-key-vault";
    let vault = vault_of_two(&turtl, name, first).await;
    let dead_id = String::from("0000000000000000000000000000000000000000000000000000000000000000");
    {
        let db_guard = lock!(turtl.db);
        let db = db_guard.as_ref().unwrap();
        let rows: Vec<crate::models::keychain::KeychainEntry> = db.all("keychain").unwrap();
        let mut dead = Protected::clone(&rows[0]).unwrap();
        dead.set_id(dead_id.clone());
        dead.set_body(crypto::to_base64(&vec![7u8; 60]).unwrap());
        db.save(&dead).unwrap();
    }
    let with_dead = Kept::of(&turtl, name);
    assert_eq!(with_dead.keys.len(), 3);
    let old_key = user_key(&turtl);
    assert_eq!(keys_opened_by(&turtl, &old_key), (2, 3));

    let changed = ask(&turtl, json!(["k1", "user:change-passphrase", first, second])).await;
    assert_eq!(changed["e"], json!(0), "{}", changed);
    assert_eq!(changed["d"], json!({"sealed": 2, "unreadable": 1}));
    let new_key = user_key(&turtl);
    assert_eq!(keys_opened_by(&turtl, &new_key), (2, 3));
    assert_eq!(keys_opened_by(&turtl, &old_key), (0, 3));
    let now = Kept::of(&turtl, name);
    let dead_row = |kept: &Kept| kept.rows().into_iter().find(|row| row["id"] == json!(dead_id)).unwrap();
    assert_eq!(dead_row(&now), dead_row(&with_dead), "the key that nothing opens is as it was");
    assert_unauthorized(relogin(&turtl, name, first).await);
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
}
async_test!(local_passphrase_change_with_a_dead_key_flow, local_passphrase_change_with_a_dead_key());

// ---------------------------------------------------------------------------------------------
// a backup of the vault
// ---------------------------------------------------------------------------------------------

/// The pieces of a backup, as the host reads them (`vault:backup:read`), put together.
async fn read_backup_in_pieces(turtl: &Turtl, piece: usize) -> Vec<u8> {
    let made = ask(turtl, json!(["bk-make", "vault:backup:make"])).await;
    assert_eq!(made["e"], json!(0), "{}", made);
    let size = made["d"]["size"].as_u64().unwrap() as usize;
    let mut bytes = Vec::new();
    while bytes.len() < size {
        let read = ask(turtl, json!(["bk-read", "vault:backup:read", bytes.len(), piece])).await;
        assert_eq!(read["e"], json!(0), "{}", read);
        let got = crypto::from_base64(&String::from(read["d"].as_str().unwrap())).unwrap();
        assert!(!got.is_empty() && got.len() <= piece);
        bytes.extend_from_slice(&got);
    }
    assert_eq!(bytes.len(), size);
    bytes
}

/// A backup, as the host sends it (`vault:restore:write`, piece after piece), and then asks for it to be restored.
async fn send_backup_in_pieces(turtl: &Turtl, bytes: &[u8], piece: usize) -> Value {
    let mut sent = 0;
    for part in bytes.chunks(piece) {
        let wrote = ask(turtl, json!(["bk-write", "vault:restore:write", sent, crypto::to_base64(part).unwrap()])).await;
        assert_eq!(wrote["e"], json!(0), "{}", wrote);
        sent += part.len();
        assert_eq!(wrote["d"]["size"], json!(sent));
    }
    ask(turtl, json!(["bk-commit", "vault:restore:commit"])).await
}

/// A backup is the vault as it is kept, in one file, that the host takes in pieces: nothing in it can be read, it
/// restores in a core that has no vault with the same passphrase, and what is wrong with a file or a request is refused,
/// whole.
async fn vault_backup_in_pieces() {
    let server = start_server().await;
    let local = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };
    let name = "backed-up-vault";
    let passphrase = "the passphrase of the backed up vault";
    let a = local();

    // there is nothing to back up before the vault is unlocked, and a core with a server has no vault
    let refused = ask(&a, json!(["bk1", "vault:backup:make"])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    let with_a_server = test_turtl(&server);
    for command in &["vault:backup:make", "vault:restore:commit", "vault:backup:drop"] {
        let refused = ask(&with_a_server, json!(["bk2", command])).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("permission_denied")), "{}: {}", command, refused);
    }

    let vault = vault_of_two(&a, name, passphrase).await;
    // (a batch that is open is not part of a backup, and is not to be cut in two by one)
    assert_eq!(ask(&a, json!(["bk3", "profile:batch:begin"])).await["e"], json!(0));
    let refused = ask(&a, json!(["bk4", "vault:backup:make"])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert_eq!(ask(&a, json!(["bk5", "profile:batch:rollback"])).await["e"], json!(0));

    // taken in pieces of 1,000 bytes and of 100,000: the same file
    let bytes = read_backup_in_pieces(&a, 1000).await;
    assert_eq!(read_backup_in_pieces(&a, 100_000).await, bytes);
    // (and a piece can't be asked for from nowhere, or too big, and a backup is let go of)
    let beyond = ask(&a, json!(["bk6", "vault:backup:read", bytes.len() + 1, 10])).await;
    assert_eq!((&beyond["e"], &beyond["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", beyond);
    let at_the_end = ask(&a, json!(["bk7", "vault:backup:read", bytes.len(), 10])).await;
    assert_eq!(at_the_end["d"], json!(""), "{}", at_the_end);
    let too_big = ask(&a, json!(["bk8", "vault:backup:read", 0, 9 << 20])).await;
    assert_eq!((&too_big["e"], &too_big["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", too_big);
    assert_eq!(ask(&a, json!(["bk9", "vault:backup:drop"])).await["e"], json!(0));
    let gone = ask(&a, json!(["bk10", "vault:backup:read", 0, 10])).await;
    assert_eq!((&gone["e"], &gone["d"]["type"]), (&json!(1), &json!("not_found")), "{}", gone);

    // what it holds: the notebooks, their pages, and the file; and nothing that can be read
    let read = crate::vault_backup::Backup::read(&bytes).unwrap();
    assert_eq!(read.name, name);
    assert_eq!(read.counts(), json!({"spaces": 2, "notes": 3, "files": 1}));
    for secret in &["door code", "Journal", "Work page", "picture.png", "image/png", passphrase] {
        assert!(!bytes_contain(&bytes, secret.as_bytes()), "{:?} can be read in a backup", secret);
    }
    assert!(bytes_contain(&bytes, vault.journal.as_bytes()), "(the ids are there: it is the right place to look)");

    // restored in a core that has no vault
    let b = local();
    let restored = send_backup_in_pieces(&b, &bytes, 700).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
    assert_eq!(restored["d"], json!({"spaces": 2, "notes": 3, "files": 1}));
    assert_eq!(ask(&b, json!(["bk11", "user:local-accounts"])).await["d"], json!([name]));
    assert_eq!(lockr!(b.kv).kv_get(&format!("local-account:{}", name)).unwrap(), lockr!(a.kv).kv_get(&format!("local-account:{}", name)).unwrap(), "the account is as it was");
    // the passphrase is the vault's, and only that
    let wrong = ask(&b, json!(["bk12", "user:login", name, "another passphrase"])).await;
    assert_eq!((&wrong["e"], &wrong["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", wrong);
    let login = ask(&b, json!(["bk13", "user:login", name, passphrase])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert!(lockr!(b.user).privkey.is_some());
    // (a vault that is unlocked is not restored over; and where there is a vault, a backup is not restored)
    let again = send_backup_in_pieces(&b, &bytes, 100_000).await;
    assert_eq!((&again["e"], &again["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", again);
    assert!(again["d"]["message"].as_str().unwrap().contains("unlocked"), "{}", again);
    assert_eq!(ask(&b, json!(["bk14", "user:logout"])).await["e"], json!(0));
    let again = send_backup_in_pieces(&b, &bytes, 100_000).await;
    assert_eq!((&again["e"], &again["d"]["subtype"]), (&json!(1), &json!("Conflict")), "{}", again);

    // what is wrong is refused, and leaves no vault behind: the pieces out of order, nothing sent, what is not a backup, one that is cut short
    let c = local();
    let refused = ask(&c, json!(["bk15", "vault:restore:commit"])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    let refused = ask(&c, json!(["bk16", "vault:restore:write", 5, crypto::to_base64(b"x").unwrap()])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert_eq!(ask(&c, json!(["bk17", "vault:restore:write", 0, crypto::to_base64(&bytes[..100]).unwrap()])).await["e"], json!(0));
    let refused = ask(&c, json!(["bk18", "vault:restore:write", 200, crypto::to_base64(&bytes[200..300]).unwrap()])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert!(refused["d"]["message"].as_str().unwrap().contains("in order"), "{}", refused);
    let refused = ask(&c, json!(["bk19", "vault:restore:write", 0, "not base64 !"])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    assert_eq!(ask(&c, json!(["bk20", "vault:restore:cancel"])).await["e"], json!(0));
    for (what, damaged) in &[
        ("a file that is not a backup", b"%PDF-1.4 a different kind of file".to_vec()),
        ("a backup cut short", bytes[..bytes.len() - 1].to_vec()),
        ("a backup with a byte changed", { let mut changed = bytes.clone(); let middle = changed.len() / 2; changed[middle] ^= 1; changed }),
    ] {
        let refused = send_backup_in_pieces(&c, damaged, 100_000).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}: {}", what, refused);
        assert!(refused["d"]["message"].as_str().unwrap().contains("the backup can't be restored"), "{}: {}", what, refused);
        assert_eq!(ask(&c, json!(["bk21", "user:local-accounts"])).await["d"], json!([]), "{}: a vault was left", what);
    }
    // (what was sent is not kept once it is restored, or refused: another commit has nothing to restore)
    let refused = ask(&c, json!(["bk22", "vault:restore:commit"])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    {
        let mut db_guard = lock!(a.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
}
async_test!(vault_backup_in_pieces_flow, vault_backup_in_pieces());

/// A folder for the databases of the test on this thread, kept as files for as long as this lives (and
/// deleted when it goes). Without it the databases of a test are in memory.
#[cfg(not(target_arch = "wasm32"))]
struct DiskFolder {
    path: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl DiskFolder {
    fn new(name: &str) -> DiskFolder {
        let nanos = ::std::time::SystemTime::now().duration_since(::std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = ::std::env::temp_dir().join(format!("turtl-test-{}-{}-{}", name, ::std::process::id(), nanos));
        ::std::fs::create_dir_all(&path).unwrap();
        let path = String::from(path.to_str().unwrap());
        crate::storage::TEST_DATA_FOLDER.with(|folder| *folder.borrow_mut() = Some(path.clone()));
        DiskFolder { path }
    }

    /// Every byte of every file in the folder, with the file's name (there are no folders in it).
    fn files(&self) -> Vec<(String, Vec<u8>)> {
        let mut files = Vec::new();
        for entry in ::std::fs::read_dir(&self.path).unwrap() {
            let entry = entry.unwrap();
            assert!(entry.file_type().unwrap().is_file(), "{:?} is not a file", entry.path());
            files.push((entry.file_name().to_string_lossy().to_string(), ::std::fs::read(entry.path()).unwrap()));
        }
        files
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for DiskFolder {
    fn drop(&mut self) {
        crate::storage::TEST_DATA_FOLDER.with(|folder| *folder.borrow_mut() = None);
        let _ = ::std::fs::remove_dir_all(&self.path);
    }
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// Without a server, with the databases on disk: a notebook's pages and files are still there after the
/// core is started again and the account logged into, and nothing that was written (names, texts, file
/// names, file bytes, the passphrase) can be found in any of the files, which do hold the ids.
#[cfg(not(target_arch = "wasm32"))]
async fn local_only_on_disk() {
    let folder = DiskFolder::new("local-only");
    let server = start_server().await;
    let passphrase = "correct horse battery staple 8213";
    let secrets = [
        "Zebra Journal", "Secret Plans Page", "the vault door code is 7391", "diagram-4417.png",
        "ATTACHMENT-BYTES-5529", "image/x-secret", passphrase, "props-secret-3318", "Unfinished page 6642",
    ];

    let (user_id, space_id, page_id, file_note_id) = {
        let mut turtl = test_turtl(&server);
        turtl.make_local_only();
        let joined = ask(&turtl, json!(["d1", "user:join", "Disk-Vault", passphrase])).await;
        assert_eq!(joined["e"], json!(0), "{}", joined);
        let user_id = String::from(joined["d"]["id"].as_str().unwrap());
        let space = ask(&turtl, json!(["d2", "profile:sync:model", "add", "space", {"user_id": "0", "title": secrets[0], "color": "#439645"}])).await;
        assert_eq!(space["e"], json!(0), "{}", space);
        let space_id = String::from(space["d"]["id"].as_str().unwrap());
        let page = ask(&turtl, json!(["d3", "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "text", "title": secrets[1], "text": format!("{}.\n", secrets[2]),
            "props": {"origin": secrets[7]},
        }])).await;
        assert_eq!(page["e"], json!(0), "{}", page);
        let page_id = String::from(page["d"]["id"].as_str().unwrap());
        let bytes = crypto::to_base64(&Vec::from(format!("\u{0}\u{1}{}\u{ff}", secrets[4]).as_bytes())).unwrap();
        let file_note = ask(&turtl, json!(["d4", "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "file", "title": "an attachment",
            "file": {"name": secrets[3], "type": secrets[5], "filedata": {"data": bytes}},
        }])).await;
        assert_eq!(file_note["e"], json!(0), "{}", file_note);
        let file_note_id = String::from(file_note["d"]["id"].as_str().unwrap());

        // a batch that is still open when the account is logged out (or the page closed) is undone
        let begun = ask(&turtl, json!(["d4b", "profile:batch:begin"])).await;
        assert_eq!(begun["e"], json!(0), "{}", begun);
        let unfinished = ask(&turtl, json!(["d4c", "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "text", "title": secrets[8], "text": "never committed\n",
        }])).await;
        assert_eq!(unfinished["e"], json!(0), "{}", unfinished);
        turtl.logout().unwrap();
        (user_id, space_id, page_id, file_note_id)
    };

    // the core is started again: a new Turtl over the same files, which knows nothing but them
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    assert_eq!(ask(&turtl, json!(["d5", "user:local-accounts"])).await["d"], json!(["disk-vault"]));
    let wrong = ask(&turtl, json!(["d6", "user:login", "disk-vault", "correct horse battery staple 8214"])).await;
    assert_eq!((&wrong["e"], &wrong["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", wrong);
    assert!(lockr!(turtl.profile).spaces.is_empty(), "a refused login shows nothing");
    let login = ask(&turtl, json!(["d7", "user:login", "disk-vault", passphrase])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_eq!(login["d"]["id"], json!(user_id));

    let profile = ask(&turtl, json!(["d8", "profile:load"])).await;
    assert_eq!(profile["d"]["spaces"].as_array().unwrap().len(), 1, "{}", profile);
    assert_eq!(profile["d"]["spaces"][0]["id"], json!(space_id));
    assert_eq!(profile["d"]["spaces"][0]["title"], json!(secrets[0]));
    let notes = ask(&turtl, json!(["d9", "profile:find-notes", {"space_id": space_id, "per_page": 100}])).await;
    assert_eq!(notes["d"]["total"], json!(2), "{}", notes);
    let page = notes["d"]["notes"].as_array().unwrap().iter().find(|note| note["id"] == json!(page_id)).unwrap().clone();
    assert_eq!(page["title"], json!(secrets[1]));
    assert_eq!(page["text"], json!(format!("{}.\n", secrets[2])));
    assert_eq!(page["props"], json!({"origin": secrets[7]}));
    let file = ask(&turtl, json!(["d10", "profile:note:get-file", file_note_id])).await;
    assert_eq!(file["e"], json!(0), "{}", file);
    assert_eq!(
        crypto::from_base64(&String::from(file["d"].as_str().unwrap())).unwrap(),
        Vec::from(format!("\u{0}\u{1}{}\u{ff}", secrets[4]).as_bytes()),
    );
    // and the search the core builds when the account is logged into finds the page
    let found = ask(&turtl, json!(["d11", "profile:find-notes", {"space_id": space_id, "text": "vault"}])).await;
    assert_eq!(found["d"]["total"], json!(1), "{}", found);
    turtl.logout().unwrap();
    drop(turtl);

    // what is on disk: the ids are there (so the files are the right ones to look in), the secrets aren't
    let files = folder.files();
    let names: Vec<&String> = files.iter().map(|file| &file.0).collect();
    assert!(names.iter().any(|name| name.contains("turtl-kv")), "the kv store is there: {:?}", names);
    assert!(names.iter().any(|name| name.contains("turtl-user-")), "the user's database is there: {:?}", names);
    assert!(names.iter().any(|name| name.ends_with(".enc")), "the encrypted file is there: {:?}", names);
    for (id, what) in &[(&space_id, "the space's id"), (&page_id, "a page's id")] {
        assert!(files.iter().any(|(_, bytes)| bytes_contain(bytes, id.as_bytes())), "{} should be in the files", what);
    }
    for secret in &secrets {
        for (name, bytes) in &files {
            assert!(!bytes_contain(bytes, secret.as_bytes()), "{:?} is in {}", secret, name);
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(local_only_on_disk_flow, local_only_on_disk());

/// The passphrase of an account on this device, changed with the databases on disk and the core started again
/// between (the way a host logs in: `user:login`): only the new passphrase opens the vault and everything is in
/// it; a change that was stopped (the process is gone) is settled by the passphrase typed after the restart;
/// and once it is done nothing of the old key's is left in the files: neither passphrase, neither sealed key, nor
/// the old record.
#[cfg(not(target_arch = "wasm32"))]
async fn local_passphrase_change_on_disk() {
    use crate::models::protected::Protected;
    let folder = DiskFolder::new("local-passphrase");
    let server = start_server().await;
    let (first, second, third) = ("first passphrase 4417 of the vault", "second passphrase 5529 of the vault", "third passphrase 6642 of the vault");
    let name = "disk-change-vault";
    let started = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };

    let (vault, old_secrets) = {
        let turtl = started();
        let vault = vault_of_two(&turtl, name, first).await;
        let before = Kept::of(&turtl, name);
        // what the old key sealed, as the files have it: the keys of the notebooks, the user's record, the auth
        let mut old_secrets: Vec<(String, String)> = before.keys.iter().map(|row| (String::from("a notebook's sealed key"), Protected::get_body(row).unwrap().clone())).collect();
        old_secrets.push((String::from("the sealed user record"), String::from(before.record()["data"]["body"].as_str().unwrap())));
        old_secrets.push((String::from("the old auth"), String::from(before.record()["auth"].as_str().unwrap())));
        let changed = ask(&turtl, json!(["p1", "user:change-passphrase", first, second])).await;
        assert_eq!(changed["e"], json!(0), "{}", changed);
        assert_eq!(changed["d"]["unreadable"], json!(0));
        turtl.logout().unwrap();
        (vault, old_secrets)
    };

    // started again: the old passphrase opens nothing, the new one everything
    let turtl = started();
    let refused = ask(&turtl, json!(["p2", "user:login", name, first])).await;
    assert_eq!((&refused["e"], &refused["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", refused);
    assert!(lockr!(turtl.profile).spaces.is_empty(), "a refused login shows nothing");
    let login = ask(&turtl, json!(["p3", "user:login", name, second])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_vault_reads(&turtl, &vault, &[]).await;

    // a change that is stopped after the account's record was written: the process is gone, and the passphrase
    // typed after the restart is the old one, which undoes it
    {
        let change = User::prepare_local_change(&turtl, &String::from(second), &String::from(third)).unwrap();
        User::begin_local_change(&turtl, &change).unwrap();
    }
    drop(turtl);
    let turtl = started();
    let (login, events) = ask_and_events(&turtl, json!(["p4", "user:login", name, second])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_eq!(settled_in(&events, name), vec![false], "the host is told that the change was undone");
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert!(Kept::of(&turtl, name).record().get("pending").is_none());
    // and one that is stopped after the keys were sealed: the new one finishes it
    {
        let change = User::prepare_local_change(&turtl, &String::from(second), &String::from(third)).unwrap();
        User::begin_local_change(&turtl, &change).unwrap();
        User::rekey_local_keys(&turtl, &change).unwrap();
    }
    drop(turtl);
    let turtl = started();
    let (login, events) = ask_and_events(&turtl, json!(["p5", "user:login", name, third])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_eq!(settled_in(&events, name), vec![true], "and that it was finished");
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert!(Kept::of(&turtl, name).record().get("pending").is_none());
    turtl.logout().unwrap();
    drop(turtl);

    // a change that was stopped and then damaged (the sealed key that the new passphrase needs is spoiled): it is
    // refused, whole, and nobody is left logged in, with the keys in memory, to a vault that could not be read; the
    // old passphrase undoes the change
    let turtl = started();
    let login = ask(&turtl, json!(["p5a", "user:login", name, third])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    {
        let change = User::prepare_local_change(&turtl, &String::from(third), &String::from(second)).unwrap();
        User::begin_local_change(&turtl, &change).unwrap();
    }
    {
        let mut record = Kept::of(&turtl, name).record();
        let spoiled = record["pending"]["new_under_old"].clone();
        record["pending"]["old_under_new"] = spoiled;
        lockr!(turtl.kv).kv_set(&format!("local-account:{}", name), &jedi::stringify(&record).unwrap()).unwrap();
    }
    let spoiled = Kept::of(&turtl, name).record;
    drop(turtl);
    let turtl = started();
    let refused = ask(&turtl, json!(["p5b", "user:login", name, second])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert!(!lockr!(turtl.user).logged_in, "a vault that could not be put right was left logged in");
    assert!(lock!(turtl.db).is_none(), "and its database was left open");
    assert!(lockr!(turtl.profile).spaces.is_empty());
    assert_eq!(Kept::of_the_record(&turtl, name), spoiled, "nothing is written when it can't be put right");
    let login = ask(&turtl, json!(["p5c", "user:login", name, third])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert!(Kept::of(&turtl, name).record().get("pending").is_none());
    turtl.logout().unwrap();
    drop(turtl);

    // and once more, the way it is lived: only the passphrase at the end opens it
    let turtl = started();
    for (n, passphrase) in [first, second].iter().enumerate() {
        let refused = ask(&turtl, json!([format!("p6{}", n), "user:login", name, passphrase])).await;
        assert_eq!((&refused["e"], &refused["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", refused);
    }
    let login = ask(&turtl, json!(["p7", "user:login", name, third])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_vault_reads(&turtl, &vault, &[]).await;
    {
        let mut db_guard = lock!(turtl.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
    turtl.logout().unwrap();
    drop(turtl);

    // what is in the files: no passphrase, and nothing that the old key sealed (the databases are written over in
    // place, so a copy of an old row could be left in a page that was freed: it must not be)
    let files = folder.files();
    for passphrase in &[first, second, third] {
        for (file, bytes) in &files {
            assert!(!bytes_contain(bytes, passphrase.as_bytes()), "a passphrase is in {}", file);
        }
    }
    for (what, sealed) in &old_secrets {
        for (file, bytes) in &files {
            assert!(!bytes_contain(bytes, sealed.as_bytes()), "{} is still in {}", what, file);
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(local_passphrase_change_on_disk_flow, local_passphrase_change_on_disk());

/// The vault moved to another computer: backed up on one (after its passphrase was changed), restored on another, whose
/// files are its own, with the keys, the pages and the file all there, and nothing of the backup or of what it was
/// restored into that can be read.
#[cfg(not(target_arch = "wasm32"))]
async fn vault_backup_moves_a_vault_to_another_computer() {
    let server = start_server().await;
    let (name, first, second) = ("moved-vault", "the first passphrase of the moved vault", "the second passphrase of the moved vault");
    let started = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };

    let first_computer = DiskFolder::new("backup-first");
    let (vault, bytes) = {
        let a = started();
        let vault = vault_of_two(&a, name, first).await;
        // (the user's own row, as a host that keeps the user's settings has one)
        let saved = ask(&a, json!(["mv0", "profile:sync:model", "edit", "user", {"settings": {"theme": "dark"}}])).await;
        assert_eq!(saved["e"], json!(0), "{}", saved);
        let changed = ask(&a, json!(["mv1", "user:change-passphrase", first, second])).await;
        assert_eq!(changed["e"], json!(0), "{}", changed);
        let bytes = read_backup_in_pieces(&a, 50_000).await;
        // (the files of a vault are files, natively, in a folder that is not the databases': the other computer has none of them)
        {
            let mut db_guard = lock!(a.db);
            crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
        }
        a.logout().unwrap();
        (vault, bytes)
    };
    let first_files = first_computer.files();
    drop(first_computer);

    let second_computer = DiskFolder::new("backup-second");
    let b = started();
    assert_eq!(ask(&b, json!(["mv2", "user:local-accounts"])).await["d"], json!([]), "this computer has no vault");
    let restored = send_backup_in_pieces(&b, &bytes, 30_000).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
    assert_eq!(restored["d"], json!({"spaces": 2, "notes": 3, "files": 1}));
    assert!(crate::models::file::FileData::file_finder(None, Some(&vault.file_note)).is_ok(), "the file of the page is a file here again");
    drop(b);

    // the core is started again over these files: the passphrase the vault had when it was backed up opens it, with everything in it
    let b = started();
    let refused = ask(&b, json!(["mv3", "user:login", name, first])).await;
    assert_eq!((&refused["e"], &refused["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "the passphrase from before the change is not the vault's: {}", refused);
    let login = ask(&b, json!(["mv4", "user:login", name, second])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_vault_reads(&b, &vault, &[]).await;
    // everything that the user's key seals came with it, and opens with the key the passphrase makes
    assert_eq!(keys_opened_by(&b, &user_key(&b)), (2, 2));
    assert_eq!(rows_opened_by::<User>(&b, &user_key(&b)), (1, 1));
    {
        let mut db_guard = lock!(b.db);
        crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
    }
    b.logout().unwrap();
    drop(b);

    // what this computer's files hold: the database of the vault, its account, and nothing that can be read
    let files = second_computer.files();
    assert!(files.iter().any(|(file, _)| file.starts_with("turtl-user-")), "the vault's database is there: {:?}", files.iter().map(|f| &f.0).collect::<Vec<_>>());
    for secret in &["door code", "Journal", "Work page", "picture.png", first, second] {
        for (file, contents) in files.iter().chain(first_files.iter()) {
            assert!(!bytes_contain(contents, secret.as_bytes()), "{:?} is in {}", secret, file);
        }
    }
    for secret in &["door code", "Journal", first, second] {
        assert!(!bytes_contain(&bytes, secret.as_bytes()), "{:?} is in the backup", secret);
    }
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(vault_backup_moves_a_vault_to_another_computer_flow, vault_backup_moves_a_vault_to_another_computer());

// ---------------------------------------------------------------------------------------------
// what a review of the passphrase change and the backup found: checks that nothing tested, and two things that were wrong
// ---------------------------------------------------------------------------------------------

/// Let go of the file that `vault_of_two` made (natively it is a file of its own, which outlives the test).
fn forget_the_file(turtl: &Turtl, vault: &TwoNotebooks) {
    let mut db_guard = lock!(turtl.db);
    crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&vault.file_note)).unwrap();
}

/// The cost that an unfinished change of passphrase asks for is held to what a device can do, as the account's own is,
/// before anything is tried: a record that asks for more is refused whichever passphrase is typed, the one that opens
/// the account as it is included (that one has the cost it was made at, and the other is the one that would be tried).
async fn local_pending_cost_is_held() {
    use crate::models::protected::Protected;
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "pending-cost-vault";
    let vault = vault_of_two(&turtl, name, first).await;
    let change = User::prepare_local_change(&turtl, &String::from(first), &String::from(second)).unwrap();
    User::begin_local_change(&turtl, &change).unwrap();
    drop(change);
    let written = Kept::of(&turtl, name);
    assert!(written.record().get("pending").is_some());
    let with_cost = |ops: i64, mem: i64| {
        let mut record = written.record();
        record["pending"]["kdf"] = json!({"ops": ops, "mem": mem});
        Kept { record: jedi::stringify(&record).unwrap(), keys: written.keys.iter().map(|row| Protected::clone(row).unwrap()).collect() }
    };
    // (more than the most a record may ask, in ops and in memory; both fit in the 32 bits of wasm32)
    for (ops, mem) in &[(1i64 << 26, 134217728i64), (4194304, (1i64 << 30) + 1)] {
        for typed in &[first, second] {
            with_cost(*ops, *mem).put_back(&turtl, name);
            let started = crate::util::get_time();
            let refused = relogin(&turtl, name, typed).await.unwrap_err();
            match refused.shed() {
                TError::BadValue(message) => assert!(message.contains("more to log in than this device allows"), "ops {} mem {}: {}", ops, mem, message),
                other => panic!("ops {} mem {}, {:?} typed: expected the cost to be refused, got {:?}", ops, mem, typed, other),
            }
            let took = (crate::util::get_time() - started).num_milliseconds();
            assert!(took < 2000, "it should be refused without trying, not after {} ms", took);
            assert!(!lockr!(turtl.user).logged_in);
        }
    }
    // the record as it was written is no such thing: it logs in, and the change is settled
    written.put_back(&turtl, name);
    assert_eq!(relogin(&turtl, name, second).await.unwrap(), Some(true));
    assert_vault_reads(&turtl, &vault, &[]).await;
    forget_the_file(&turtl, &vault);
}
async_test!(local_pending_cost_is_held_flow, local_pending_cost_is_held());

/// A change of passphrase that fails after the record was written (here, a row of the user's own that the key can't
/// seal) is dropped whole: the record is what it was to the byte, the new passphrase opens nothing, the old one opens
/// everything as before, and another change can be begun at once.
async fn local_passphrase_change_that_fails() {
    use crate::models::protected::Protected;
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let (first, second) = ("the first passphrase of this vault", "the second passphrase of this vault");
    let name = "failing-vault";
    let vault = vault_of_two(&turtl, name, first).await;
    let before = Kept::of(&turtl, name);
    let old_key = user_key(&turtl);
    // a row in the table of the user's own records that is not a record at all
    {
        let db_guard = lock!(turtl.db);
        db_guard.as_ref().unwrap().store_value("users", &json!({"id": "not-a-user-row", "nonsense": true})).unwrap();
    }
    let failed = ask(&turtl, json!(["ff1", "user:change-passphrase", first, second])).await;
    assert_eq!(failed["e"], json!(1), "the change was meant to fail: {}", failed);
    let after = Kept::of(&turtl, name);
    assert!(after.record().get("pending").is_none(), "what was begun was left: {}", after.record);
    assert_eq!(after.record, before.record, "the account is as it was, to the byte");
    assert_eq!(after.rows(), before.rows(), "and so are the keys");
    assert_eq!(user_key(&turtl).data(), old_key.data(), "and the key this session has");
    assert_eq!(keys_opened_by(&turtl, &old_key), (2, 2));
    // the damage is mended, and the vault is as before: only the old passphrase opens it
    {
        let db_guard = lock!(turtl.db);
        let mut gone = User::default();
        gone.set_id(String::from("not-a-user-row"));
        db_guard.as_ref().unwrap().delete(&gone).unwrap();
    }
    assert_unauthorized(relogin(&turtl, name, second).await);
    assert_eq!(relogin(&turtl, name, first).await.unwrap(), None, "there was nothing to settle");
    assert_vault_reads(&turtl, &vault, &[]).await;
    // and a change can be made now
    let changed = ask(&turtl, json!(["ff2", "user:change-passphrase", first, second])).await;
    assert_eq!(changed["e"], json!(0), "{}", changed);
    assert_unauthorized(relogin(&turtl, name, first).await);
    relogin(&turtl, name, second).await.unwrap();
    assert_vault_reads(&turtl, &vault, &[]).await;
    assert!(Protected::key(&*lockr!(turtl.user)).is_some());
    forget_the_file(&turtl, &vault);
}
async_test!(local_passphrase_change_that_fails_flow, local_passphrase_change_that_fails());

/// A backup that holds an account that a core without a server can't make is refused whole, however well it is made as a
/// file, and nothing of it is kept: a name that is a path, or has capitals (logging in makes a name lower case, so it would
/// be there and never open), an id that is not a number, a cost that no device can bear, a record that is not a user's.
async fn vault_restore_refuses_accounts_that_cannot_be_made() {
    use crate::vault_backup::Backup;
    let server = start_server().await;
    let local = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };
    let a = local();
    let vault = vault_of_two(&a, "hostile-vault", "the passphrase of the hostile vault").await;
    let bytes = read_backup_in_pieces(&a, 100_000).await;
    forget_the_file(&a, &vault);
    let hostile: Vec<(&str, Box<dyn Fn(&mut Backup)>)> = vec![
        ("a name with capitals", Box::new(|b| b.name = String::from("Hostile-Vault"))),
        ("a name that is a path", Box::new(|b| b.name = String::from("../hostile"))),
        ("an id that is not a number", Box::new(|b| b.record["id"] = json!("abc"))),
        ("an id that is a path", Box::new(|b| b.record["id"] = json!("../1"))),
        ("a cost that no device can bear", Box::new(|b| b.record["kdf"] = json!({"ops": 4194304, "mem": (1u64 << 30) + 1}))),
        ("an unfinished change that costs more than that", Box::new(|b| b.record["pending"] = json!({"auth": "x", "kdf": {"ops": 1u64 << 26, "mem": 134217728}, "data": {}, "new_under_old": "a", "old_under_new": "b"}))),
        ("no user record", Box::new(|b| b.record["data"] = json!("text"))),
    ];
    for (what, edit) in &hostile {
        let mut backup = Backup::read(&bytes).unwrap();
        edit(&mut backup);
        let damaged = backup.write().unwrap();
        let b = local();
        let refused = send_backup_in_pieces(&b, &damaged, 100_000).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}: {}", what, refused);
        assert!(refused["d"]["message"].as_str().unwrap().contains("the backup can't be restored"), "{}: {}", what, refused);
        assert_eq!(ask(&b, json!(["hv1", "user:local-accounts"])).await["d"], json!([]), "{}: a vault was left", what);
    }
    // (the same file, as it was made, restores)
    let b = local();
    let restored = send_backup_in_pieces(&b, &bytes, 100_000).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
}
async_test!(vault_restore_refuses_accounts_that_cannot_be_made_flow, vault_restore_refuses_accounts_that_cannot_be_made());

/// A restore that fails (here, the database of the vault can't be made: a folder is where its file goes) leaves no vault
/// behind: the account is written last, since it is what makes a vault exist; and the restore goes through when the way is free.
#[cfg(not(target_arch = "wasm32"))]
async fn vault_restore_that_fails_leaves_no_vault() {
    use crate::vault_backup::Backup;
    let server = start_server().await;
    let started = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };
    let name = "failing-restore-vault";
    let first_computer = DiskFolder::new("failing-restore-first");
    let (vault, bytes) = {
        let a = started();
        let vault = vault_of_two(&a, name, "the passphrase of the failing restore").await;
        let bytes = read_backup_in_pieces(&a, 100_000).await;
        forget_the_file(&a, &vault);
        a.logout().unwrap();
        (vault, bytes)
    };
    drop(first_computer);

    let _second_computer = DiskFolder::new("failing-restore-second");
    let b = started();
    let record = Backup::read(&bytes).unwrap().record;
    let location = b.get_user_db_location(&String::from(record["id"].as_str().unwrap())).unwrap();
    ::std::fs::create_dir_all(&location).unwrap();
    let refused = send_backup_in_pieces(&b, &bytes, 100_000).await;
    assert_eq!(refused["e"], json!(1), "the restore was meant to fail: {}", refused);
    assert_eq!(ask(&b, json!(["fr1", "user:local-accounts"])).await["d"], json!([]), "a restore that failed left a vault (an account with no database)");
    ::std::fs::remove_dir(&location).unwrap();
    let restored = send_backup_in_pieces(&b, &bytes, 100_000).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
    assert_eq!(ask(&b, json!(["fr2", "user:local-accounts"])).await["d"], json!([name]));
    drop(b);
    let b = started();
    let login = ask(&b, json!(["fr3", "user:login", name, "the passphrase of the failing restore"])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    assert_vault_reads(&b, &vault, &[]).await;
    forget_the_file(&b, &vault);
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(vault_restore_that_fails_leaves_no_vault_flow, vault_restore_that_fails_leaves_no_vault());

/// A restore that was stopped after the database was written and before the account was (the page closed, the power
/// gone) leaves a database that belongs to no vault; the next restore, of any backup, is the vault the backup says: nothing
/// of what the stopped one wrote (notebooks, pages, files) comes with it.
#[cfg(not(target_arch = "wasm32"))]
async fn vault_restore_replaces_what_a_stopped_restore_left() {
    let server = start_server().await;
    let started = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };
    let (name, passphrase) = ("stopped-restore-vault", "the passphrase of the stopped restore");
    let first_computer = DiskFolder::new("stopped-restore-first");
    let (vault, older, newer, later_file) = {
        let a = started();
        let vault = vault_of_two(&a, name, passphrase).await;
        let older = read_backup_in_pieces(&a, 100_000).await;
        // a notebook made later, with a page and a file of its own
        let space = ask(&a, json!(["sr1", "profile:sync:model", "add", "space", {"user_id": "0", "title": "Later notebook", "color": "#800000"}])).await;
        assert_eq!(space["e"], json!(0), "{}", space);
        let later_file = ask(&a, json!(["sr2", "profile:sync:model", "add", "note", {
            "space_id": space["d"]["id"], "user_id": "0", "type": "zim-file", "title": "Later notebook/later.png",
            "file": {"name": "later.png", "type": "image/png", "filedata": {"data": crypto::to_base64(&vec![1u8, 2, 3, 4, 5]).unwrap()}},
        }])).await;
        assert_eq!(later_file["e"], json!(0), "{}", later_file);
        let newer = read_backup_in_pieces(&a, 100_000).await;
        assert!(newer.len() > older.len());
        let later_file = String::from(later_file["d"]["id"].as_str().unwrap());
        forget_the_file(&a, &vault);
        {
            let mut db_guard = lock!(a.db);
            crate::models::file::FileData::store_delete(db_guard.as_mut().unwrap(), None, Some(&later_file)).unwrap();
        }
        a.logout().unwrap();
        (vault, older, newer, later_file)
    };
    drop(first_computer);

    let _second_computer = DiskFolder::new("stopped-restore-second");
    {
        let b = started();
        let restored = send_backup_in_pieces(&b, &newer, 100_000).await;
        assert_eq!(restored["e"], json!(0), "{}", restored);
        assert!(crate::models::file::FileData::file_finder(None, Some(&later_file)).is_ok());
        // stopped before the account was written: the database and the files are there, and no vault
        lockr!(b.kv).kv_delete(&format!("local-account:{}", name)).unwrap();
        assert_eq!(ask(&b, json!(["sr3", "user:local-accounts"])).await["d"], json!([]));
    }
    let b = started();
    let restored = send_backup_in_pieces(&b, &older, 100_000).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
    assert_eq!(restored["d"], json!({"spaces": 2, "notes": 3, "files": 1}));
    assert!(crate::models::file::FileData::file_finder(None, Some(&later_file)).is_err(), "a file of the stopped restore was left");
    drop(b);
    let b = started();
    let login = ask(&b, json!(["sr4", "user:login", name, passphrase])).await;
    assert_eq!(login["e"], json!(0), "{}", login);
    // exactly the notebooks of the older backup: the later one did not come with it
    assert_vault_reads(&b, &vault, &[]).await;
    forget_the_file(&b, &vault);
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(vault_restore_replaces_what_a_stopped_restore_left_flow, vault_restore_replaces_what_a_stopped_restore_left());

/// What a JS host sees of the core on wasm32 (wasm_host.rs): everything the core sends goes to the
/// message handler, the same JSON as on native; without a handler it queues up for the poll
/// functions; and the core can be stopped. Driven here the way a host would drive it.
#[cfg(target_arch = "wasm32")]
mod host {
    use super::*;
    use ::std::cell::RefCell;
    use ::std::rc::Rc;
    use ::wasm_bindgen::closure::Closure;
    use ::wasm_bindgen::JsCast;
    use crate::wasm_host;

    /// What the handler has been given so far: (channel, message).
    type Inbox = Rc<RefCell<Vec<(String, String)>>>;

    /// Register a handler that collects what the core sends. Keep the closure alive while it's registered.
    fn collect() -> (Inbox, Closure<dyn FnMut(String, String)>) {
        let inbox: Inbox = Rc::new(RefCell::new(Vec::new()));
        let inbox_in_handler = inbox.clone();
        let closure = Closure::wrap(Box::new(move |channel: String, message: String| {
            inbox_in_handler.borrow_mut().push((channel, message));
        }) as Box<dyn FnMut(String, String)>);
        wasm_host::set_message_handler(Some(closure.as_ref().unchecked_ref::<::js_sys::Function>().clone()));
        (inbox, closure)
    }

    /// The first message in `inbox` that `wanted` likes (waiting for it to arrive, if need be).
    async fn wait_for<F: Fn(&(String, String)) -> bool>(inbox: &Inbox, wanted: F) -> (String, String) {
        for _ in 0..500 {
            let found = inbox.borrow().iter().find(|m| wanted(m)).cloned();
            if let Some(found) = found {
                return found;
            }
            exec::sleep(20).await;
        }
        panic!("the core never sent what was expected; it sent: {:?}", inbox.borrow());
    }

    async fn host_api() {
        let server = start_server().await;

        // before the core is started there is nobody to take a message
        assert!(wasm_host::send_message(r#"["h0","ping"]"#).is_err());

        let config = json!({"api": {"endpoint": server.url}, "logging": {"level": "error"}});
        wasm_host::init_core(&config.to_string()).unwrap();
        let (inbox, _handler) = collect();
        wasm_host::start_core().unwrap();
        assert!(wasm_host::start_core().is_err(), "the core can only be started once");
        wait_for(&inbox, |m| m.0 == "inproc://turtl-events" && m.1 == r#"{"e":"messaging:ready","d":true}"#).await;

        // a message in, its response out, on the channel and in the JSON native uses
        wasm_host::send_message(r#"["h1","ping"]"#).unwrap();
        let (channel, message) = wait_for(&inbox, |m| m.1.contains(r#""id":"h1""#)).await;
        assert_eq!(channel, "inproc://turtl-req-core-out");
        assert_eq!(message, r#"{"id":"h1","e":0,"d":"pong"}"#);

        // an event is how the core tells itself things (some wipe data): a host sends commands, and is told so
        let refused = wasm_host::send_message(r#"::ev{"e":"user:wipe-data","d":null}"#).unwrap_err();
        assert!(refused.as_string().unwrap_or_default().contains("commands, not"), "{:?}", refused);

        // a command that goes through the whole stack (crypto, the API, storage), configured through
        // the config we gave initCore
        wasm_host::send_message(&json!(["h2", "user:join", "Host@Test.com", "hostpassphrase"]).to_string()).unwrap();
        let (_, message) = wait_for(&inbox, |m| m.1.contains(r#""id":"h2""#)).await;
        let res: Value = jedi::parse(&message).unwrap();
        assert_eq!(res["e"], json!(0), "{}", message);
        assert_eq!(res["d"]["username"], json!("host@test.com"));
        wait_for(&inbox, |m| m.0 == "inproc://turtl-events" && m.1.contains("user:login")).await;

        // with no handler, what the core sends waits for the poll functions. (The channels are shared
        // with every other test that has made a Turtl, so look through what is queued for the answer
        // and the event this ping causes rather than expecting them to be first.)
        wasm_host::set_message_handler(None);
        wasm_host::send_message(r#"["h3","ping"]"#).unwrap();
        let (mut answered, mut ponged) = (false, false);
        for _ in 0..500 {
            while let Some(message) = wasm_host::poll_message(None).unwrap() {
                answered = answered || message == r#"{"id":"h3","e":0,"d":"pong"}"#;
            }
            while let Some(event) = wasm_host::poll_event().unwrap() {
                ponged = ponged || event == r#"{"e":"pong","d":null}"#;
            }
            if answered && ponged { break; }
            exec::sleep(20).await;
        }
        assert!(answered, "the ping's answer was queued for pollMessage()");
        assert!(ponged, "the ping's event was queued for pollEvent()");

        // `app:shutdown` answers, and then there is no core any more
        let (inbox, _handler) = collect();
        wasm_host::send_message(r#"["h4","app:shutdown"]"#).unwrap();
        wait_for(&inbox, |m| m.1.contains(r#""id":"h4""#)).await;
        assert!(wasm_host::send_message(r#"["h5","ping"]"#).is_err());
        wasm_host::set_message_handler(None);
    }
    async_test!(host_api_flow, host_api());
}

// ------------------------------------------------------------------------------------------------------------------------------------
// sealed copies of a notebook (see `seal`): the master key lives in the vault, objects are sealed and opened by commands, and another vault
// takes the master key out of its wrapped form with the passphrase it was wrapped with

/// What a page is, on the way in and out of the commands (base64).
fn b64(bytes: &[u8]) -> String {
    crypto::to_base64(&bytes.to_vec()).unwrap()
}

async fn sealed_copies() {
    // (vaults made at the cost of the tests, so that the passphrases don't each cost 128 MiB here)
    let _cheap = crate::models::user::ServerCostAccounts::new();
    let server = start_server().await;
    let mut turtl = test_turtl(&server);
    turtl.make_local_only();
    let nb = "garden-0001";
    let status = |id: &'static str| json!([id, "seal:master:status"]);

    // a core with a server has no vault, and none of this is for it; a vault that is locked has no key
    let with_a_server = test_turtl(&server);
    for (i, command) in ["seal:master:status", "seal:master:make", "seal:objects:seal", "seal:index:open"].iter().enumerate() {
        let refused = ask(&with_a_server, json!([format!("s{}", i), command])).await;
        assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("permission_denied")), "{}: {}", command, refused);
    }
    let locked = ask(&turtl, status("s-locked")).await;
    assert_eq!((&locked["e"], &locked["d"]["type"]), (&json!(1), &json!("missing_data")), "{}", locked);

    // the first vault: no key yet; one is made, wrapped by the passphrase, kept in the vault, and made only once
    let joined = ask(&turtl, json!(["s-join", "user:join", "first-device", "a passphrase to keep"])).await;
    assert_eq!(joined["e"], json!(0), "{}", joined);
    assert_eq!(ask(&turtl, status("s1")).await["d"], json!({"has": false}));
    let before_a_key = ask(&turtl, json!(["s2", "seal:objects:seal", nb, [{"path": "Home.txt", "data": b64(b"x")}]])).await;
    assert_eq!((&before_a_key["e"], &before_a_key["d"]["type"]), (&json!(1), &json!("not_found")), "{}", before_a_key);
    // a key is made for the passphrase that opens the vault and no other (wrapping hands the key out, so whoever asks has to know it), and nothing is kept until it is taken
    let made_wrong = ask(&turtl, json!(["s3a", "seal:master:make", "not the passphrase of the vault"])).await;
    assert_eq!((&made_wrong["e"], &made_wrong["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}", made_wrong);
    let created = ask(&turtl, json!(["s3", "seal:master:make", "a passphrase to keep"])).await;
    assert_eq!(created["e"], json!(0), "{}", created);
    let wrapped = String::from(created["d"]["wrapped"].as_str().unwrap());
    let check = created["d"]["check"].as_str().unwrap().to_string();
    assert_eq!(crypto::from_base64(&wrapped).unwrap().len(), 104);
    assert_eq!(check.len(), 32);
    assert!(created["d"].as_object().unwrap().len() == 2, "nothing but the wrapped key and its check value is given: {}", created);
    assert_eq!(ask(&turtl, status("s4")).await["d"], json!({"has": false}), "making a key keeps nothing");
    let kept = ask(&turtl, json!(["s4a", "seal:master:unwrap", wrapped, "a passphrase to keep"])).await;
    assert_eq!(kept["d"], json!({"kept": true, "check": check}), "{}", kept);
    assert_eq!(ask(&turtl, status("s4b")).await["d"], json!({"has": true, "check": check}));
    let again = ask(&turtl, json!(["s5", "seal:master:unwrap", wrapped, "a passphrase to keep"])).await;
    assert_eq!(again["d"], json!({"kept": false, "check": check}), "{}", again);
    // (another key is not taken over it)
    let other = ask(&turtl, json!(["s5a", "seal:master:make", "a passphrase to keep"])).await;
    let other_wrapped = String::from(other["d"]["wrapped"].as_str().unwrap());
    assert_ne!(other["d"]["check"], json!(check));
    let refused = ask(&turtl, json!(["s5b", "seal:master:unwrap", other_wrapped, "a passphrase to keep"])).await;
    assert_eq!((&refused["e"], &refused["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", refused);
    assert_eq!(ask(&turtl, status("s5c")).await["d"], json!({"has": true, "check": check}), "and the key that is there is still there");

    // pages and a picture are sealed: under names that say nothing, and open again
    let page = "====== Home ======\nThe vault door code is 7391.\n";
    let picture: Vec<u8> = vec![137, 80, 78, 71, 0, 255, 13, 10, 26, 10];
    let sealed = ask(&turtl, json!(["s6", "seal:objects:seal", nb, [{"path": "Home.txt", "data": b64(page.as_bytes())}, {"path": "Home/picture.png", "data": b64(&picture)}]])).await;
    assert_eq!(sealed["e"], json!(0), "{}", sealed);
    let objects = sealed["d"].as_array().unwrap().clone();
    assert_eq!(objects.len(), 2);
    assert_eq!(objects[0]["size"], json!(page.len()));
    assert_eq!(objects[0]["sha256"], json!(crypto::to_hex(&crypto::sha256(page.as_bytes()).unwrap()).unwrap()));
    for object in &objects {
        let name = object["name"].as_str().unwrap();
        assert!(name.len() == 38 && name.ends_with(".zseal") && !name.contains("Home") && !name.contains("picture"), "{}", name);
        let bytes = crypto::from_base64(&String::from(object["sealed"].as_str().unwrap())).unwrap();
        assert!(!bytes.windows(7).any(|w| w == b"7391.\nT" || w == b"door co"), "the sealed object holds the page's words");
    }
    let open_args = |id: &str, items: Vec<Value>| json!([id, "seal:objects:open", nb, items]);
    let item = |o: &Value| json!({"name": o["name"], "sealed": o["sealed"]});
    let opened = ask(&turtl, open_args("s7", objects.iter().map(|o| item(o)).collect())).await;
    assert_eq!(opened["e"], json!(0), "{}", opened);
    assert_eq!(crypto::from_base64(&String::from(opened["d"][0]["data"].as_str().unwrap())).unwrap(), page.as_bytes());
    assert_eq!(crypto::from_base64(&String::from(opened["d"][1]["data"].as_str().unwrap())).unwrap(), picture);

    // what is not the object is refused, and nothing is half given: another name, another notebook, a changed byte, what is not even a name
    let swapped = vec![json!({"name": objects[0]["name"], "sealed": objects[1]["sealed"]})];
    let refused = ask(&turtl, open_args("s8", swapped)).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    let mut damaged = crypto::from_base64(&String::from(objects[0]["sealed"].as_str().unwrap())).unwrap();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    let refused = ask(&turtl, open_args("s9", vec![item(&objects[1]), json!({"name": objects[0]["name"], "sealed": b64(&damaged)})])).await;
    assert_eq!(refused["e"], json!(1), "{}", refused);
    assert!(refused["d"].get("data").is_none() && !refused.to_string().contains("7391"), "{}", refused);
    let elsewhere = ask(&turtl, json!(["s10", "seal:objects:open", "orchard-0002", [item(&objects[0])]])).await;
    assert_eq!(elsewhere["e"], json!(1), "{}", elsewhere);
    let not_a_name = ask(&turtl, open_args("s11", vec![json!({"name": "Home.txt", "sealed": objects[0]["sealed"]})])).await;
    assert_eq!((&not_a_name["e"], &not_a_name["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", not_a_name);
    // and what may not be sealed: a notebook id that is not one, a path that leaves the notebook, too many at once
    for (i, (what, args)) in vec![
        ("an id with a slash", json!(["s12", "seal:objects:seal", "a/b/c/d/e/f/g", [{"path": "Home.txt", "data": b64(b"x")}]])),
        ("a short id", json!(["s13", "seal:objects:seal", "short", [{"path": "Home.txt", "data": b64(b"x")}]])),
        ("a path that leaves", json!(["s14", "seal:objects:seal", nb, [{"path": "../Home.txt", "data": b64(b"x")}]])),
        ("an absolute path", json!(["s15", "seal:objects:seal", nb, [{"path": "/Home.txt", "data": b64(b"x")}]])),
        ("data that is not base64", json!(["s16", "seal:objects:seal", nb, [{"path": "Home.txt", "data": "!!!"}]])),
        ("no list", json!(["s17", "seal:objects:seal", nb, "Home.txt"])),
        ("too many", json!(["s18", "seal:objects:seal", nb, (0..2001).map(|n| json!({"path": format!("P{}.txt", n), "data": ""})).collect::<Vec<_>>()])),
    ].into_iter().enumerate() {
        let refused = ask(&turtl, args).await;
        assert_eq!(refused["e"], json!(1), "{} ({}) was not refused: {}", what, i, refused);
    }

    // an index: sealed and opened, and refused when it says what an index may not
    let name = objects[0]["name"].clone();
    let index = json!({"counter": 3, "title": "Garden", "files": [{"path": "Home.txt", "name": name, "size": page.len(), "sha256": objects[0]["sha256"]}]});
    let sealed_index = ask(&turtl, json!(["s19", "seal:index:seal", nb, index])).await;
    assert_eq!(sealed_index["e"], json!(0), "{}", sealed_index);
    let opened_index = ask(&turtl, json!(["s20", "seal:index:open", nb, sealed_index["d"]["sealed"]])).await;
    assert_eq!(opened_index["d"], index, "{}", opened_index);
    let index_bytes = String::from(sealed_index["d"]["sealed"].as_str().unwrap());
    assert!(!crypto::from_base64(&index_bytes).unwrap().windows(6).any(|w| w == b"Garden"), "the index's title shows");
    let bad_index = ask(&turtl, json!(["s21", "seal:index:seal", nb, {"counter": 1, "title": "x", "files": [{"path": "../x", "name": name, "size": 1, "sha256": objects[0]["sha256"]}]}])).await;
    assert_eq!(bad_index["e"], json!(1), "{}", bad_index);
    assert_eq!(ask(&turtl, json!(["s22", "seal:index:open", "orchard-0002", index_bytes])).await["e"], json!(1), "another notebook's key does not open it");

    // a second vault, with a passphrase of its own, has none; it takes the key from the wrapped one with the passphrase that wrapped it, and then opens what the first sealed
    turtl.logout().unwrap();
    let second = ask(&turtl, json!(["s27", "user:join", "second-device", "another passphrase entirely"])).await;
    assert_eq!(second["e"], json!(0), "{}", second);
    assert_eq!(ask(&turtl, status("s28")).await["d"], json!({"has": false}));
    assert_eq!(ask(&turtl, json!(["s28b", "seal:master:wrap", "another passphrase entirely"])).await["e"], json!(1), "there is no key to wrap");
    assert_eq!(ask(&turtl, open_args("s29", objects.iter().map(|o| item(o)).collect())).await["e"], json!(1), "without the key, nothing opens");
    let wrong = ask(&turtl, json!(["s30", "seal:master:unwrap", wrapped, "another passphrase entirely"])).await;
    assert_eq!(wrong["e"], json!(1), "the vault's own passphrase is not the one that wrapped it: {}", wrong);
    assert_eq!(ask(&turtl, status("s31")).await["d"], json!({"has": false}), "a refusal keeps nothing");
    let junk = ask(&turtl, json!(["s32", "seal:master:unwrap", b64(&[1u8; 104]), "a passphrase to keep"])).await;
    assert_eq!(junk["e"], json!(1), "{}", junk);
    let taken = ask(&turtl, json!(["s33", "seal:master:unwrap", wrapped, "a passphrase to keep"])).await;
    assert_eq!((&taken["e"], &taken["d"]), (&json!(0), &json!({"kept": true, "check": check})), "{}", taken);
    let now_opens = ask(&turtl, open_args("s34", objects.iter().map(|o| item(o)).collect())).await;
    assert_eq!(now_opens["e"], json!(0), "{}", now_opens);
    assert_eq!(crypto::from_base64(&String::from(now_opens["d"][0]["data"].as_str().unwrap())).unwrap(), page.as_bytes(), "the second vault opens what the first sealed");
    let twice = ask(&turtl, json!(["s35", "seal:master:unwrap", wrapped, "a passphrase to keep"])).await;
    assert_eq!(twice["d"], json!({"kept": false, "check": check}), "{}", twice);

    // after the vault's passphrase changes, the key is wrapped again by the new one: a third vault takes it with the new passphrase and not the old. (Only the vault's passphrase
    // wraps it: not the one it had before the change, and not one that is not the vault's.)
    let changed = ask(&turtl, json!(["s36a", "user:change-passphrase", "another passphrase entirely", "a newer passphrase for it"])).await;
    assert_eq!(changed["e"], json!(0), "{}", changed);
    for (i, passphrase) in ["another passphrase entirely", "something else altogether"].iter().enumerate() {
        let refused = ask(&turtl, json!([format!("s36b{}", i), "seal:master:wrap", passphrase])).await;
        assert_eq!((&refused["e"], &refused["d"]["subtype"]), (&json!(1), &json!("Unauthorized")), "{}: {}", passphrase, refused);
    }
    let rewrapped = ask(&turtl, json!(["s36", "seal:master:wrap", "a newer passphrase for it"])).await;
    assert_eq!(rewrapped["e"], json!(0), "{}", rewrapped);
    assert_eq!(rewrapped["d"]["check"], json!(check), "the same key");
    let newer = String::from(rewrapped["d"]["wrapped"].as_str().unwrap());
    assert_ne!(newer, wrapped);
    turtl.logout().unwrap();
    let third = ask(&turtl, json!(["s37", "user:join", "third-device", "a third passphrase altogether"])).await;
    assert_eq!(third["e"], json!(0), "{}", third);
    assert_eq!(ask(&turtl, json!(["s38", "seal:master:unwrap", newer, "a passphrase to keep"])).await["e"], json!(1), "the old passphrase no longer opens the new wrapping");
    assert_eq!(ask(&turtl, json!(["s39", "seal:master:unwrap", newer, "a newer passphrase for it"])).await["d"]["kept"], json!(true));
    assert_eq!(ask(&turtl, open_args("s40", objects.iter().map(|o| item(o)).collect())).await["e"], json!(0));

    // a vault that has a key of its own is not given another
    turtl.logout().unwrap();
    let fourth = ask(&turtl, json!(["s41", "user:join", "fourth-device", "a fourth passphrase altogether"])).await;
    assert_eq!(fourth["e"], json!(0), "{}", fourth);
    let own = ask(&turtl, json!(["s42", "seal:master:make", "a fourth passphrase altogether"])).await;
    assert_eq!(own["e"], json!(0), "{}", own);
    assert_eq!(ask(&turtl, json!(["s42b", "seal:master:unwrap", own["d"]["wrapped"], "a fourth passphrase altogether"])).await["d"]["kept"], json!(true));
    let different = ask(&turtl, json!(["s43", "seal:master:unwrap", wrapped, "a passphrase to keep"])).await;
    assert_eq!((&different["e"], &different["d"]["type"]), (&json!(1), &json!("bad_value")), "{}", different);

    // none of this asked a server for anything, or queued anything for one
    assert_eq!(requests(&server).await, Vec::<String>::new());
    assert!(sync_records(&turtl.db).is_empty(), "nothing is queued for a server");
}
async_test!(sealed_copies_flow, sealed_copies());

/// The key for sealed copies is in the vault, on disk: it is still there when the vault is locked and unlocked, and it goes with a backup of the vault to another computer, where what was
/// sealed opens.
#[cfg(not(target_arch = "wasm32"))]
async fn sealed_key_is_kept_in_the_vault() {
    let _cheap = crate::models::user::ServerCostAccounts::new();
    let server = start_server().await;
    let started = || { let mut turtl = test_turtl(&server); turtl.make_local_only(); turtl };
    let (name, passphrase, nb) = ("sealed-vault", "the passphrase of the sealed vault", "garden-0001");
    let open_args = |id: &str, objects: &Vec<Value>| json!([id, "seal:objects:open", nb, objects.iter().map(|o| json!({"name": o["name"], "sealed": o["sealed"]})).collect::<Vec<_>>()]);

    let first_computer = DiskFolder::new("seal-first");
    let (objects, bytes) = {
        let a = started();
        let joined = ask(&a, json!(["k1", "user:join", name, passphrase])).await;
        assert_eq!(joined["e"], json!(0), "{}", joined);
        let made = ask(&a, json!(["k2", "seal:master:make", passphrase])).await;
        assert_eq!(made["e"], json!(0), "{}", made);
        assert_eq!(ask(&a, json!(["k2b", "seal:master:unwrap", made["d"]["wrapped"], passphrase])).await["d"]["kept"], json!(true));
        let sealed = ask(&a, json!(["k3", "seal:objects:seal", nb, [{"path": "Home.txt", "data": b64(b"The vault door code is 7391.")}]])).await;
        assert_eq!(sealed["e"], json!(0), "{}", sealed);
        let objects = sealed["d"].as_array().unwrap().clone();
        // locked and unlocked again: the key is read from the vault with the rest of the profile
        a.logout().unwrap();
        assert_eq!(ask(&a, json!(["k4", "seal:master:status"])).await["e"], json!(1), "locked, there is no key to use");
        let back = ask(&a, json!(["k5", "user:login", name, passphrase])).await;
        assert_eq!(back["e"], json!(0), "{}", back);
        assert_eq!(ask(&a, json!(["k6", "seal:master:status"])).await["d"]["has"], json!(true));
        let opened = ask(&a, open_args("k7", &objects)).await;
        assert_eq!(opened["e"], json!(0), "{}", opened);
        assert_eq!(crypto::from_base64(&String::from(opened["d"][0]["data"].as_str().unwrap())).unwrap(), b"The vault door code is 7391.");
        let bytes = read_backup_in_pieces(&a, 50_000).await;
        a.logout().unwrap();
        (objects, bytes)
    };
    drop(first_computer);

    // another computer, where the vault is restored from the backup: the key is there, and the object opens
    let second_computer = DiskFolder::new("seal-second");
    let b = started();
    let restored = send_backup_in_pieces(&b, &bytes, 30_000).await;
    assert_eq!(restored["e"], json!(0), "{}", restored);
    let logged = ask(&b, json!(["k8", "user:login", name, passphrase])).await;
    assert_eq!(logged["e"], json!(0), "{}", logged);
    assert_eq!(ask(&b, json!(["k9", "seal:master:status"])).await["d"]["has"], json!(true), "the key came with the backup");
    assert_eq!(ask(&b, open_args("k10", &objects)).await["e"], json!(0), "and what was sealed opens");
    // (the backup, like the files, holds nothing that can be read: the key is sealed in it by the vault's key)
    assert!(!bytes.windows(7).any(|w| w == b"7391.\"\n" || w == b"door co"));
    b.logout().unwrap();
    drop(second_computer);
}
#[cfg(not(target_arch = "wasm32"))]
async_test!(sealed_key_is_kept_in_the_vault_flow, sealed_key_is_kept_in_the_vault());
