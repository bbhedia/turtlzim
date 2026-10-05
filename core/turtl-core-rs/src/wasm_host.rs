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
//! The order a host does things in (all of it is synchronous except `initWasmCrypto`):
//!
//! ```text
//!   await init({ module_or_path })      // load the wasm (wasm-bindgen's own init)
//!   await initWasmCrypto(sodium)        // inject libsodium.js (src/crypto/wasm_sodium.rs)
//!   initCore(configJson)                // config + logging; configJson is runtime config, e.g.
//!                                       //   {"api": {"endpoint": "https://..."}, "logging": {"level": "info"}}
//!   setMessageHandler((channel, message) => ...)
//!   startCore()                         // creates the core; announces itself with the `messaging:ready` event
//!   sendMessage('["1","user:login","me@example.com","passphrase"]')
//!   ...
//!   stopCore()                          // or send the `app:shutdown` command
//! ```
//!
//! There is one core per wasm instance. Nothing persists yet (the databases are in memory until
//! step 4b-5b), and attachments and the other filesystem features are native-only.

use ::std::cell::RefCell;
use ::std::sync::Arc;
use ::jedi::{self, Value};
use ::js_sys::Function;
use ::wasm_bindgen::prelude::*;
use crate::dispatch;
use crate::error::{TResult, TError};
use crate::turtl::Turtl;

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
        "enable_files_incoming": false,
        "enable_files_outgoing": false,
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
