//! How a JavaScript host runs the core on wasm32: the counterpart of `start()`/`send()`/`recv()` and
//! the C API on native (docs/wasm-port-plan.md decision 2.4 and step 4b-3).
//!
//! The wire protocol is exactly the native one. The host sends `["<message id>", "<command>", args..]`
//! as a JSON string and the core answers on the same channels with the same JSON, so the UI code
//! above this layer cannot tell the targets apart:
//!
//!   * responses go out on `<messaging.reqres>-core-out` (plus `:<message id>` when
//!     `messaging.reqres_append_mid` is set), events on `<messaging.events>`;
//!   * what differs is the transport. There is no thread to block on a channel, so every message
//!     the core sends is handed to the function registered with `setMessageHandler(channel, message)`
//!     as it is sent, and every message the host sends becomes a task on the host's event loop
//!     (`spawn_local`) instead of being read off a channel by a loop. With no handler registered, the
//!     outgoing messages queue up in the same in-process channels native uses, and `pollMessage` /
//!     `pollEvent` read them without blocking (the native `recv_nb` / `recv_event_nb`).
//!
//! The order a host does things in (only `init`, `initWasmCrypto` and `enablePersistence` are async):
//!
//! ```text
//!   await init({ module_or_path })      // load the wasm (wasm-bindgen's own init)
//!   await initWasmCrypto(sodium)        // inject libsodium.js (src/crypto/wasm_sodium.rs)
//!   await enablePersistence(dir)        // optional, Worker only: keep the databases in OPFS
//!   initCore(configJson)                // config + logging; configJson is runtime config, e.g.
//!                                       //   {"api": {"endpoint": "https://..."}, "logging": {"level": "info"}}
//!   setMessageHandler((channel, message) => ...)
//!   startCore()                         // creates the core; announces itself with the `messaging:ready` event
//!   sendMessage('["1","user:login","me@example.com","passphrase"]')
//!   ...
//!   stopCore()                          // or send the `app:shutdown` command
//! ```
//!
//! There is one core per wasm instance. **Persistence:** without `enablePersistence()` the databases
//! live in memory and are gone with the page. With it they are kept in the origin-private file system
//! (OPFS) through SQLite's SAHPool VFS, which needs a dedicated Worker, so the core has to run in
//! one (js/browser/core_worker.js is the reference), and which lets one worker use a given
//! `directory` at a time: a second tab (or a worker that hasn't died yet) is told so. `data_folder`
//! then names the folder inside it (default `turtl`). Note attachments are kept in that same database
//! (a table of encrypted blobs), so they persist, and are wiped, with it.

use ::std::cell::RefCell;
use ::std::sync::Arc;
use ::jedi::{self, Value};
use ::js_sys::Function;
use ::sqlite_wasm_vfs::sahpool::{self, OpfsSAHError, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil};
use ::wasm_bindgen::prelude::*;
use crate::dispatch;
use crate::error::{TResult, TError};
use crate::turtl::Turtl;
use crate::util::exec;

/// The OPFS directory the databases go in unless the host names another.
const DEFAULT_PERSISTENCE_DIRECTORY: &str = "turtl-core";

/// The folder inside that directory (`data_folder` in the config) when persistence is on and the host
/// doesn't choose one.
const DEFAULT_DATA_FOLDER: &str = "turtl";

/// How many files the pool can hold at once. Every database takes one, and so does its journal while
/// a write is in flight; the pool does not grow by itself.
const POOL_CAPACITY: u32 = 16;

/// The config the core needs to run, wherever a host's runtime config leaves a hole. The same keys
/// as config.yaml, except that nothing here may point at a file (`data_folder` is `:memory:` until
/// there is persistent storage) and logging goes to the JS console.
const DEFAULT_CONFIG: &str = r#"{
    "wrap_errors": false,
    "data_folder": ":memory:",
    "integration_tests": {"data_folder": ":memory:"},
    "messaging": {
        "reqres": "inproc://turtl-req",
        "events": "inproc://turtl-events",
        "reqres_append_mid": false
    },
    "logging": {"level": "warn"},
    "api": {
        "endpoint": "https://apiv3.turtlapp.com",
        "client_version_string": "core",
        "proxy": null,
        "allow_invalid_ssl": false
    },
    "sync": {
        "enable_incoming": true,
        "enable_outgoing": true,
        "enable_files_incoming": true,
        "enable_files_outgoing": true,
        "poll_timeout": 25
    }
}"#;

/// What a wasm instance holds: the core, once started, and the host's function for outgoing messages.
#[derive(Default)]
struct Host {
    turtl: Option<Arc<Turtl>>,
    handler: Option<Function>,
}

thread_local! {
    // (wasm32 has one thread, so a thread-local is the instance's global.)
    static HOST: RefCell<Host> = RefCell::new(Host::default());
    /// The OPFS file pool, once `enablePersistence()` has set it up.
    static POOL: RefCell<Option<OpfsSAHPoolUtil>> = RefCell::new(None);
}

/// Set up the config (defaults, then the host's runtime config laid over them) and the logger. This
/// is `crate::init()` on wasm32.
pub fn init(config_str: &str) -> TResult<()> {
    let runtime_config: Value = match jedi::parse(&String::from(config_str)) {
        Ok(x) => x,
        Err(e) => {
            warn!("turtl::init() -- problem parsing runtime config: {}", e);
            json!({})
        }
    };
    // `:null:` is "start from an empty config" (there is no file to load)
    ::config::load_config(Some(String::from(":null:")))?;
    let defaults: Value = jedi::parse(&String::from(DEFAULT_CONFIG))?;
    ::config::merge(&defaults)?;
    ::config::merge(&runtime_config)?;
    // with persistence on, the databases go in a folder of the pool unless the host says otherwise
    if persistence_enabled() && jedi::get_opt::<String>(&["data_folder"], &runtime_config).is_none() {
        ::config::set(&["data_folder"], &String::from(DEFAULT_DATA_FOLDER))?;
    }

    match crate::util::logger::setup_logger() {
        Ok(_) => {}
        Err(e) => return TErr!(toterr!(e)),
    }
    info!("main::init() -- init with user config {}", config_str);
    Ok(())
}

/// Hand the host a message the core is sending on `channel`, if the host has registered a handler.
/// Without one the message is given back, to be queued on the channel. (The handler is called with
/// nothing borrowed, and it can only start more work, never re-enter the core, so it is safe for
/// the core to call it while it holds locks.)
pub fn offer_to_handler(channel: &str, message: String) -> Option<String> {
    let handler = HOST.with(|host| host.borrow().handler.clone());
    match handler {
        Some(handler) => {
            if let Err(e) = handler.call2(&JsValue::NULL, &JsValue::from_str(channel), &JsValue::from_str(&message)) {
                error!("wasm_host::offer_to_handler() -- the message handler threw: {:?}", e);
            }
            None
        }
        None => Some(message),
    }
}

/// Whether `startCore()` has been called (and the core not stopped since).
pub fn is_started() -> bool {
    HOST.with(|host| host.borrow().turtl.is_some())
}

/// Run a message the host (or the core itself, through an app event) sent in: as a task of its own,
/// so that messages are processed concurrently like on native.
pub fn dispatch_inbound(message: String) -> TResult<()> {
    let turtl = match HOST.with(|host| host.borrow().turtl.clone()) {
        Some(turtl) => turtl,
        None => return TErr!(TError::Msg(String::from("the core isn't started (call startCore() first)"))),
    };
    ::wasm_bindgen_futures::spawn_local(async move {
        match dispatch::process(turtl.as_ref(), &message).await {
            Ok(..) => {},
            Err(e) => error!("dispatch::process() -- error processing: {}", e),
        }
    });
    Ok(())
}

/// Let go of the core: what the `app:shutdown` command and `stopCore()` both end in. Messages that
/// are already being processed finish first (they hold the core until they are done).
pub fn stop() {
    let turtl = HOST.with(|host| host.borrow_mut().turtl.take());
    if turtl.is_some() {
        info!("wasm_host::stop() -- core stopped");
    }
}

fn to_js(e: TError) -> JsValue {
    JsValue::from_str(&format!("{}", e))
}

/// Whether `enablePersistence()` has set up the OPFS file pool.
pub fn persistence_enabled() -> bool {
    POOL.with(|pool| pool.borrow().is_some())
}

/// Delete the database file `location` (a path like the native ones: `<data_folder>/<name>.sqlite`)
/// from the file pool. In-memory databases, and a core without persistence, have nothing to delete.
pub fn delete_db(location: &str) -> TResult<()> {
    POOL.with(|pool| match pool.borrow().as_ref() {
        Some(pool) => match pool.delete_db(location) {
            Ok(_) => Ok(()),
            Err(e) => TErr!(TError::Msg(format!("couldn't delete {}: {}", location, e))),
        },
        None => Ok(()),
    })
}

/// Delete every database file in `folder` whose name starts with `turtl-`, like the native wipe.
pub fn delete_all_dbs(folder: &str) -> TResult<()> {
    let prefix = format!("{}/turtl-", folder);
    let names: Vec<String> = POOL.with(|pool| match pool.borrow().as_ref() {
        Some(pool) => pool.list().into_iter().filter(|name| name.starts_with(&prefix)).collect(),
        None => Vec::new(),
    });
    for name in names {
        info!("wasm_host::delete_all_dbs() -- removing {}", name);
        delete_db(&name)?;
    }
    Ok(())
}

/// Keep the core's databases in the browser's origin-private file system from now on, in the
/// OPFS directory `directory` (default `turtl-core`). Call it once, in the Worker the core runs in,
/// after `initWasmCrypto()` and before `initCore()`. Calling it again is harmless.
///
/// It fails when OPFS isn't there (not a dedicated Worker, or not a secure context) or when another
/// tab or worker has the directory open; a worker that is just being replaced is given a few
/// seconds to let go of it first.
#[wasm_bindgen(js_name = enablePersistence)]
pub async fn enable_persistence(directory: Option<String>) -> Result<(), JsValue> {
    if persistence_enabled() {
        return Ok(());
    }
    let config = OpfsSAHPoolCfgBuilder::new()
        .directory(directory.as_deref().unwrap_or(DEFAULT_PERSISTENCE_DIRECTORY))
        .initial_capacity(POOL_CAPACITY)
        .build();
    let mut attempts = 0;
    let pool = loop {
        match sahpool::install::<::sqlite_wasm_rs::WasmOsCallback>(&config, true).await {
            Ok(pool) => break pool,
            // the files are held by another worker. if that one is on its way out (a reload) it lets go
            // in a moment; if it is another tab it won't, and we say so
            Err(OpfsSAHError::CreateSyncAccessHandle(e)) => {
                attempts += 1;
                if attempts >= 30 {
                    return Err(JsValue::from_str(&format!(
                        "the stored data is in use by another tab or worker (close it and try again): {:?}", e
                    )));
                }
                exec::sleep(100).await;
            }
            Err(e) => return Err(JsValue::from_str(&format!("couldn't set up persistent storage: {}", e))),
        }
    };
    POOL.with(|slot| *slot.borrow_mut() = Some(pool));
    info!("wasm_host::enable_persistence() -- databases are kept in OPFS");
    Ok(())
}

/// Set up the config and logging. `config` is the host's runtime config as a JSON string (`"{}"` for
/// the defaults); see the module docs. Call it once, before `startCore()`.
#[wasm_bindgen(js_name = initCore)]
pub fn init_core(config: &str) -> Result<(), JsValue> {
    init(config).map_err(to_js)
}

/// Create the core and announce it with the `messaging:ready` event. Needs libsodium injected
/// (`initWasmCrypto`) and `initCore()` called first.
#[wasm_bindgen(js_name = startCore)]
pub fn start_core() -> Result<(), JsValue> {
    if HOST.with(|host| host.borrow().turtl.is_some()) {
        return Err(JsValue::from_str("the core is already started"));
    }
    // a data folder only means something with a file pool behind it: anything else would quietly keep
    // the data in memory, which is the one way to lose it without being told
    let data_folder: String = ::config::get(&["data_folder"]).map_err(|e| to_js(From::from(e)))?;
    if data_folder != ":memory:" && !persistence_enabled() {
        return Err(JsValue::from_str(&format!(
            "data_folder is \"{}\" but persistence isn't enabled: await enablePersistence() first, or leave data_folder as \":memory:\"",
            data_folder
        )));
    }
    let turtl = Turtl::new().map_err(to_js)?;
    HOST.with(|host| host.borrow_mut().turtl = Some(Arc::new(turtl)));
    crate::messaging::ui_event("messaging:ready", &true).map_err(to_js)?;
    info!("wasm_host::start_core() -- core started");
    Ok(())
}

/// Stop the core (the same as sending it `app:shutdown`, minus the response).
#[wasm_bindgen(js_name = stopCore)]
pub fn stop_core() {
    stop();
}

/// Send the core a message (`["<message id>", "<command>", args..]` as JSON). The answer comes back
/// through the message handler (or `pollMessage`).
#[wasm_bindgen(js_name = sendMessage)]
pub fn send_message(message: &str) -> Result<(), JsValue> {
    dispatch_inbound(String::from(message)).map_err(to_js)
}

/// Register the function `(channel: string, message: string) => void` that every message the core
/// sends is handed to (`null` unregisters it; messages then queue up for `pollMessage`/`pollEvent`).
#[wasm_bindgen(js_name = setMessageHandler)]
pub fn set_message_handler(handler: Option<Function>) {
    HOST.with(|host| host.borrow_mut().handler = handler);
}

/// The next queued response (for `msg_id`, when `messaging.reqres_append_mid` is set), if there is
/// one. Only messages sent while no handler was registered are queued.
#[wasm_bindgen(js_name = pollMessage)]
pub fn poll_message(msg_id: Option<String>) -> Result<Option<String>, JsValue> {
    crate::recv_nb(msg_id.as_deref()).map_err(to_js)
}

/// The next queued event, if there is one (see `pollMessage`).
#[wasm_bindgen(js_name = pollEvent)]
pub fn poll_event() -> Result<Option<String>, JsValue> {
    crate::recv_event_nb().map_err(to_js)
}
