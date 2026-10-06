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
    turtl.local_only = true;

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

    // what only a server can do is refused
    for (mid, args) in &[
        ("l11", json!(["sync:start"])),
        ("l12", json!(["user:login-from-token", "abc"])),
        ("l13", json!(["user:change-password", "vault-one", "a passphrase to keep", "vault-one", "a new passphrase"])),
        ("l14", json!(["user:delete-account"])),
    ] {
        let mut message = vec![json!(mid)];
        message.extend(args.as_array().unwrap().iter().cloned());
        let refused = ask(&turtl, Value::Array(message)).await;
        assert_eq!(refused["e"], json!(1), "{} was not refused: {}", args[0], refused);
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

#[cfg(not(target_arch = "wasm32"))]
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
        "ATTACHMENT-BYTES-5529", "image/x-secret", passphrase,
    ];

    let (user_id, space_id, page_id, file_note_id) = {
        let mut turtl = test_turtl(&server);
        turtl.local_only = true;
        let joined = ask(&turtl, json!(["d1", "user:join", "Disk-Vault", passphrase])).await;
        assert_eq!(joined["e"], json!(0), "{}", joined);
        let user_id = String::from(joined["d"]["id"].as_str().unwrap());
        let space = ask(&turtl, json!(["d2", "profile:sync:model", "add", "space", {"user_id": "0", "title": secrets[0], "color": "#439645"}])).await;
        assert_eq!(space["e"], json!(0), "{}", space);
        let space_id = String::from(space["d"]["id"].as_str().unwrap());
        let page = ask(&turtl, json!(["d3", "profile:sync:model", "add", "note", {
            "space_id": space_id, "user_id": "0", "type": "text", "title": secrets[1], "text": format!("{}.\n", secrets[2]),
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
        turtl.logout().unwrap();
        (user_id, space_id, page_id, file_note_id)
    };

    // the core is started again: a new Turtl over the same files, which knows nothing but them
    let mut turtl = test_turtl(&server);
    turtl.local_only = true;
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
