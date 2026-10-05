//! wasm32 only: the libsodium.js object the *host* hands us, and the typed bindings the crypto
//! primitives in `low.rs` call it through (docs/wasm-port-plan.md decision 2.1, "injection").
//!
//! # Host contract
//!
//! ```js
//! import init, { initWasmCrypto, cryptoSelfTest } from 'turtl_core';  // the wasm-pack output
//! import sodium from 'libsodium-wrappers-sumo';                       // the HOST owns this dependency
//!
//! await init();                    // load the core's own wasm module
//! await initWasmCrypto(sodium);    // awaits `sodium.ready`, checks it is the sumo build, keeps it
//! cryptoSelfTest();                // optional: known-answer check of the injected libsodium
//! ```
//!
//! Every crypto primitive native links from libsodium C is, on wasm32, a method call on that
//! injected object: the very same C code, Emscripten-built, so byte-identical output is structural
//! (and verified: the crate's known-answer tests run on both targets, see `crypto_test!`).
//!
//! # Why inject it instead of having the crate import libsodium itself
//!
//! * **No JS of its own.** The crate ships no `require`/`import` glue, so there is no
//!   CommonJS-vs-ES-module split per wasm-bindgen target (`web`, `bundler`, `nodejs`, Deno all
//!   work from the same wasm), and `wasm-pack build` never sees an npm dependency of the crate (it
//!   chokes on one: wasm-bindgen copies a `dependencies` object into `pkg/package.json` and
//!   wasm-pack 0.15.0 cannot parse it).
//! * **The dependency lives where it belongs:** in the web app's (or Tauri/Capacitor shell's)
//!   `package.json`, resolved by whatever bundler it already uses.
//! * **The trust model does not change.** The host is the app itself, same origin and same code, so
//!   which libsodium build it loads was always the app's responsibility (SRI, pinned service
//!   worker; open issue #6 in CLAUDE.md). `cryptoSelfTest()` additionally lets the host assert at
//!   startup that the object it injected behaves like libsodium; that catches a wrong build or a
//!   version mismatch, not a malicious host.
//!
//! # Why init is a Promise
//!
//! libsodium-wrappers needs an async `sodium.ready` before any of its calls work, and wasm32 in a
//! browser is single-threaded (a sync fn cannot block on a JS Promise without deadlocking). So
//! `initWasmCrypto` returns a Promise the host awaits once; afterwards every crypto function stays
//! a plain synchronous fn with native's exact signature.

use ::std::cell::RefCell;

use ::js_sys::{Error as JsError, Promise, Reflect, Uint8Array};
use ::wasm_bindgen::prelude::*;
use ::wasm_bindgen::JsCast;
use ::wasm_bindgen_futures::JsFuture;

use crate::crypto::error::{CResult, CryptoError};

#[wasm_bindgen]
extern "C" {
    /// The libsodium.js object the host injects (npm `libsodium-wrappers-sumo`'s default export).
    /// Only the methods below are ever called on it; `REQUIRED_FUNCTIONS` must list all of them.
    pub type Sodium;

    #[wasm_bindgen(method, getter)]
    fn ready(this: &Sodium) -> JsValue;

    #[wasm_bindgen(method, catch)]
    pub fn sodium_version_string(this: &Sodium) -> Result<String, JsValue>;

    /// `secret_nonce` is part of libsodium's generic AEAD API but unused by this construction:
    /// always `null`, same as native sodiumoxide's `aead::seal`.
    #[wasm_bindgen(method, catch)]
    pub fn crypto_aead_chacha20poly1305_ietf_encrypt(
        this: &Sodium, message: &[u8], additional_data: &[u8], secret_nonce: &JsValue,
        public_nonce: &[u8], key: &[u8], output_format: &str,
    ) -> Result<Vec<u8>, JsValue>;

    /// Throws on authentication failure.
    #[wasm_bindgen(method, catch)]
    pub fn crypto_aead_chacha20poly1305_ietf_decrypt(
        this: &Sodium, secret_nonce: &JsValue, ciphertext: &[u8], additional_data: &[u8],
        public_nonce: &[u8], key: &[u8], output_format: &str,
    ) -> Result<Vec<u8>, JsValue>;

    #[wasm_bindgen(method, catch)]
    pub fn randombytes_buf(this: &Sodium, length: u32, output_format: &str) -> Result<Vec<u8>, JsValue>;

    #[wasm_bindgen(method, catch)]
    pub fn crypto_hash_sha256(this: &Sodium, message: &[u8], output_format: &str) -> Result<Vec<u8>, JsValue>;

    #[wasm_bindgen(method, catch)]
    pub fn crypto_hash_sha512(this: &Sodium, message: &[u8], output_format: &str) -> Result<Vec<u8>, JsValue>;

    /// HMAC-SHA512-256 (a 32-byte tag). The key must already be checked as 32 bytes by the caller.
    #[wasm_bindgen(method, catch)]
    pub fn crypto_auth(this: &Sodium, message: &[u8], key: &[u8], output_format: &str) -> Result<Vec<u8>, JsValue>;

    /// scrypt. The salt must already be checked as 32 bytes by the caller.
    #[wasm_bindgen(method, catch)]
    pub fn crypto_pwhash_scryptsalsa208sha256(
        this: &Sodium, key_length: u32, password: &[u8], salt: &[u8],
        ops_limit: u32, mem_limit: u32, output_format: &str,
    ) -> Result<Vec<u8>, JsValue>;

    /// Returns a JS object `{ publicKey, privateKey, keyType }`; read it with `bytes_property`.
    #[wasm_bindgen(method, catch)]
    pub fn crypto_box_keypair(this: &Sodium, output_format: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch)]
    pub fn crypto_box_seal(this: &Sodium, message: &[u8], public_key: &[u8], output_format: &str) -> Result<Vec<u8>, JsValue>;

    /// Throws if the box doesn't open (wrong keys or tampered data).
    #[wasm_bindgen(method, catch)]
    pub fn crypto_box_seal_open(
        this: &Sodium, ciphertext: &[u8], public_key: &[u8], private_key: &[u8], output_format: &str,
    ) -> Result<Vec<u8>, JsValue>;
}

/// Every method of the injected object that `low.rs` calls. `initWasmCrypto` refuses an object that
/// lacks any of them, so handing in the standard `libsodium-wrappers` (no password hashing, no
/// explicit sha512) fails loudly at startup instead of deep inside a login.
const REQUIRED_FUNCTIONS: &'static [&'static str] = &[
    "crypto_aead_chacha20poly1305_ietf_encrypt",
    "crypto_aead_chacha20poly1305_ietf_decrypt",
    "randombytes_buf",
    "crypto_hash_sha256",
    "crypto_hash_sha512",
    "crypto_auth",
    "crypto_pwhash_scryptsalsa208sha256",
    "crypto_box_keypair",
    "crypto_box_seal",
    "crypto_box_seal_open",
];

thread_local! {
    /// The injected, ready libsodium. wasm32-unknown-unknown is single-threaded, so a
    /// thread-local `RefCell` is all the synchronisation this needs.
    static SODIUM: RefCell<Option<Sodium>> = RefCell::new(None);
}

/// Run `f` with the injected libsodium, or fail with a clear error if `initWasmCrypto(sodium)` has
/// not resolved yet (a programming error on the host's part, never a silent no-op or fallback).
pub fn with_sodium<T, F: FnOnce(&Sodium) -> T>(fn_name: &str, f: F) -> CResult<T> {
    SODIUM.with(|cell| {
        match *cell.borrow() {
            Some(ref sodium) => Ok(f(sodium)),
            None => Err(CryptoError::OperationFailed(format!(
                "crypto::low::{}() -- libsodium has not been injected yet; the host must `await initWasmCrypto(sodium)` once before any crypto:: call (see docs/wasm-port-plan.md)",
                fn_name
            ))),
        }
    })
}

/// Read a byte-array property (e.g. `publicKey`) off an object libsodium.js returned.
pub fn bytes_property(obj: &JsValue, name: &str) -> CResult<Vec<u8>> {
    match Reflect::get(obj, &JsValue::from_str(name)) {
        Ok(ref value) if value.is_instance_of::<Uint8Array>() => Ok(Uint8Array::new(value).to_vec()),
        _ => Err(CryptoError::OperationFailed(format!("crypto::low -- libsodium.js returned no `{}` byte array", name))),
    }
}

/// The names in `REQUIRED_FUNCTIONS` that `sodium` does not provide as functions.
fn missing_functions(sodium: &JsValue) -> Vec<&'static str> {
    REQUIRED_FUNCTIONS.iter()
        .filter(|name| match Reflect::get(sodium, &JsValue::from_str(name)) {
            Ok(func) => !func.is_function(),
            Err(_) => true,
        })
        .cloned()
        .collect()
}

/// Awaits `sodium.ready`, then checks the object has everything we need and keeps it. A failed
/// init leaves any previously injected libsodium untouched.
async fn init(sodium: JsValue) -> Result<JsValue, JsValue> {
    if !sodium.is_object() {
        return Err(JsError::new(
            "initWasmCrypto(sodium): expected the libsodium.js object (`import sodium from 'libsodium-wrappers-sumo'`)"
        ).into());
    }
    let sodium: Sodium = sodium.unchecked_into();
    JsFuture::from(Promise::resolve(&sodium.ready())).await?;
    let missing = missing_functions(&sodium);
    if !missing.is_empty() {
        return Err(JsError::new(&format!(
            "initWasmCrypto(sodium): the libsodium object you passed lacks {} -- pass the *sumo* build (`import sodium from 'libsodium-wrappers-sumo'`); the standard libsodium-wrappers has no password hashing",
            missing.join(", ")
        )).into());
    }
    SODIUM.with(|cell| *cell.borrow_mut() = Some(sodium));
    Ok(JsValue::UNDEFINED)
}

/// Hand the core its libsodium (see the module docs for the host contract). Must be called and
/// awaited exactly once, before any other `crypto::` function is used on wasm32: `rand_bytes()`,
/// `chacha20poly1305::{encrypt, decrypt}`, the hashes, `hmac()`, `gen_key()` (scrypt), the `asym`
/// sealed-box functions, and everything built on them (`crypto::encrypt()`/`crypto::decrypt()`,
/// and everything in `models/` that goes through those).
///
/// `sodium` is libsodium.js (npm `libsodium-wrappers-sumo`'s default export); it need not be ready
/// yet, this waits for `sodium.ready`. The returned Promise rejects, with a message that names the
/// problem, if `sodium` is not an object or lacks a function the core needs. Calling it again with a
/// good object is harmless and replaces the stored one.
#[wasm_bindgen(js_name = initWasmCrypto)]
pub fn init_wasm_crypto(sodium: JsValue) -> Promise {
    ::wasm_bindgen_futures::future_to_promise(init(sodium))
}

/// Run the crypto known-answer self-test (`selftest::run`) against the injected libsodium and
/// return a one-line report, or throw naming the first check that failed. A cheap startup
/// assertion for hosts: it catches the wrong libsodium build or a version that behaves differently
/// from the native one. Needs `initWasmCrypto(sodium)` to have been awaited first.
#[wasm_bindgen(js_name = cryptoSelfTest)]
pub fn crypto_self_test() -> Result<String, JsValue> {
    crate::crypto::selftest::run().map_err(|e| JsValue::from(JsError::new(&format!("{}", e))))?;
    let version = with_sodium("cryptoSelfTest", |s| s.sodium_version_string())
        .ok()
        .and_then(|res| res.ok())
        .unwrap_or_else(|| String::from("unknown version"));
    Ok(format!(
        "crypto self-test passed against libsodium {}: sha256, sha512, hmac, aead (RFC 8439), scrypt, sealed box, secure_compare, random",
        version
    ))
}
