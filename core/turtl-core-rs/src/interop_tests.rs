//! Cross-target interoperability: what one build encrypts, the other can read.
//!
//! The crypto primitives are checked byte for byte against each other (src/crypto/mod.rs: golden
//! vectors made by native, verified on wasm32). This is the same promise at the level of a whole
//! account: the user record, the keychain, spaces, boards and a note, with the keys derived from the
//! passphrase and unwrapped along the real chain, plus the search over the decrypted note.
//!
//! `test-fixtures/interop_from_native.json` and `interop_from_wasm.json` each hold what a server
//! would store for an account that one build made with `join` and filled with a note: the user
//! record (as `POST /users` sent it) and the auth token that goes with it, every sync record the
//! profile produced (the ciphertext, as `POST /sync` would send it), and what the maker saw in
//! plaintext. A test seeds the stand-in server
//! with one fixture, logs in with the passphrase, starts the sync engine (which loads the profile from
//! those records) and compares what it decrypts with what the other build wrote down. Both targets
//! read both fixtures, so all four combinations are covered, the two same-target ones included.
//!
//! The fixtures are made once and checked in. To make new ones (after a change of format, or to
//! refresh them), run the generators; each rewrites its own file:
//!
//! ```text
//!   TURTL_WRITE_FIXTURES=1 cargo test --features sqlite-static -p turtl_core interop
//!   TURTL_WRITE_FIXTURES=1 NODE_PATH=$(pwd)/node_modules wasm-pack test --node -- interop
//! ```

use ::jedi::{self, Value};
use crate::flow_tests::{seed, start_server, test_turtl, Server};
use crate::models::model::Model;
use crate::models::sync_record::SyncRecord;
use crate::models::user;
use crate::search::Query;

#[cfg(not(target_arch = "wasm32"))]
const FIXTURE_FROM_THIS_TARGET: &str = "interop_from_native.json";
#[cfg(target_arch = "wasm32")]
const FIXTURE_FROM_THIS_TARGET: &str = "interop_from_wasm.json";

const FROM_NATIVE: &str = include_str!("../test-fixtures/interop_from_native.json");
const FROM_WASM: &str = include_str!("../test-fixtures/interop_from_wasm.json");

const USERNAME: &str = "interop@test.com";
const PASSPHRASE: &str = "interoppassphrase";
const NOTE_TITLE: &str = "Interop note";
const NOTE_TEXT: &str = "Zim wiki notes, encrypted end-to-end, read by the other build.";

#[cfg(not(target_arch = "wasm32"))]
fn write_fixtures_requested() -> bool {
    ::std::env::var("TURTL_WRITE_FIXTURES").map(|x| x == "1").unwrap_or(false)
}

#[cfg(target_arch = "wasm32")]
use ::wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(module = "/js/test_support.js")]
extern "C" {
    #[wasm_bindgen(js_name = shouldWriteFixtures)]
    fn write_fixtures_requested() -> bool;
    #[wasm_bindgen(js_name = writeFixture)]
    fn write_fixture(name: &str, text: &str);
}

#[cfg(not(target_arch = "wasm32"))]
fn write_fixture(name: &str, text: &str) {
    let path = ::std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures").join(name);
    ::std::fs::write(path, text).unwrap();
}

/// Titles of what is in the profile, sorted: (spaces, boards).
fn profile_titles(turtl: &crate::turtl::Turtl) -> (Vec<String>, Vec<String>) {
    let profile_guard = lockr!(turtl.profile);
    let mut spaces: Vec<String> = profile_guard.spaces.iter().map(|x| x.title.clone().unwrap()).collect();
    let mut boards: Vec<String> = profile_guard.boards.iter().map(|x| x.title.clone().unwrap()).collect();
    spaces.sort();
    boards.sort();
    (spaces, boards)
}

/// Make an account with this build, put a note in it, and write down what a server would hold and
/// what the build itself sees.
async fn make_fixture() -> Value {
    let server = start_server().await;
    let turtl = test_turtl(&server);
    turtl.join(String::from(USERNAME), String::from(PASSPHRASE)).await.unwrap();

    // a note, in the first space, the way the UI makes one
    let (spaces, _) = profile_titles(&turtl);
    let space_id = {
        let profile_guard = lockr!(turtl.profile);
        let space = profile_guard.spaces.iter().find(|x| x.title.as_ref() == Some(&spaces[0])).unwrap();
        space.id().unwrap().clone()
    };
    let mut note = SyncRecord::default();
    note.action = crate::models::sync_record::SyncAction::Add;
    note.ty = crate::models::sync_record::SyncType::Note;
    note.data = Some(json!({
        "space_id": space_id, "user_id": "0", "type": "text",
        "title": NOTE_TITLE, "text": NOTE_TEXT, "tags": ["interop"],
    }));
    let saved = crate::sync::sync_model::dispatch(&turtl, note).unwrap();
    let note_id: String = jedi::get(&["id"], &saved).unwrap();

    // what the server holds: the user record and the sync records (the profile's ciphertext)
    let api = crate::api::Api::new();
    api.set_endpoint(Some(server.url.clone()));
    let user: Value = api.get("/users/42").unwrap().call().await.unwrap();
    let records: Vec<SyncRecord> = {
        let db_guard = lock!(turtl.db);
        db_guard.as_ref().unwrap().all("sync").unwrap()
    };
    let (spaces, boards) = profile_titles(&turtl);
    let (_, auth) = user::generate_auth(&String::from(USERNAME), &String::from(PASSPHRASE), 0).unwrap();
    json!({
        "username": USERNAME,
        "passphrase": PASSPHRASE,
        "auth": auth,
        "user": user,
        "sync_records": jedi::to_val(&records).unwrap(),
        "expected": {
            "spaces": spaces,
            "boards": boards,
            "note": {"id": note_id, "space_id": space_id, "title": NOTE_TITLE, "text": NOTE_TEXT},
        },
    })
}

/// Write the fixture for this target when asked to (`TURTL_WRITE_FIXTURES=1`); otherwise do nothing.
async fn write_fixture_when_asked() {
    if !write_fixtures_requested() {
        return;
    }
    let fixture = make_fixture().await;
    write_fixture(FIXTURE_FROM_THIS_TARGET, &format!("{}\n", ::serde_json::to_string_pretty(&fixture).unwrap()));
}
async_test!(writes_this_targets_fixture_when_asked, write_fixture_when_asked());

/// Log in to an account another build made, load its profile from the ciphertext that build stored,
/// and check that what comes out is what that build saw.
async fn read_fixture(fixture_json: &str) {
    let fixture: Value = jedi::parse(&String::from(fixture_json)).unwrap();
    let username = String::from(fixture["username"].as_str().expect("the fixture is empty: generate it"));
    let passphrase = String::from(fixture["passphrase"].as_str().unwrap());
    let expected = &fixture["expected"];

    // the same passphrase gives the same auth token on every build (it is what the server checks)
    let (_, auth) = user::generate_auth(&username, &passphrase, 0).unwrap();
    assert_eq!(json!(auth), fixture["auth"], "the auth token derived from the passphrase");

    // the server knows the account as the other build made it, and hands out the profile it stored
    let server = start_server().await;
    seed(&server, json!({"username": username, "auth": auth, "data": fixture["user"]}), fixture["sync_records"].clone()).await;
    let turtl = test_turtl(&server);

    // logging in unlocks the user record: the private half of the keypair is inside the ciphertext
    turtl.login(username.clone(), passphrase).await.unwrap();
    assert!(lockr!(turtl.user).privkey.is_some(), "the user record decrypted");

    // starting sync loads the profile from the records: keychain, then spaces and boards with the
    // keys it unwraps
    turtl.sync_start().await.unwrap();
    let (spaces, boards) = profile_titles(&turtl);
    assert_eq!(json!(spaces), expected["spaces"]);
    assert_eq!(json!(boards), expected["boards"]);

    // the note decrypts to what was written...
    let note_id = String::from(expected["note"]["id"].as_str().unwrap());
    let notes = turtl.load_notes(&vec![note_id.clone()]).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title.as_ref().map(|x| x.as_str()), expected["note"]["title"].as_str());
    assert_eq!(notes[0].text.as_ref().map(|x| x.as_str()), expected["note"]["text"].as_str());

    // ...and the full-text search over the decrypted notes finds it
    let query: Query = jedi::from_val(json!({"space_id": expected["note"]["space_id"], "text": "encrypted"})).unwrap();
    {
        let search_guard = lock!(turtl.search);
        let (found, total) = search_guard.as_ref().expect("the notes were indexed").find(&query).unwrap();
        assert_eq!((found, total), (vec![note_id.clone()], 1));
    }

    turtl.sync_shutdown(true).await.unwrap();
}
async_test!(reads_what_native_made, read_fixture(FROM_NATIVE));
async_test!(reads_what_wasm_made, read_fixture(FROM_WASM));
