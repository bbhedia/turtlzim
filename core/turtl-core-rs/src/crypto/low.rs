//! Low-level crypto primitives/modules.
//!
//! Every primitive in this file has two implementations, split by
//! `#[cfg(target_arch = "wasm32")]`: native calls `sodiumoxide` (libsodium C
//! bindings, which have no `wasm32-unknown-unknown` build story -- see
//! docs/wasm-port-plan.md §1); wasm32 calls the very same libsodium C code,
//! Emscripten-built (npm `libsodium-wrappers-sumo`), through a wasm-bindgen JS
//! bridge (`wasm_bridge`, below, backed by `js/sodium_bridge.js`), per
//! docs/wasm-port-plan.md decision 2.1. That makes byte-identical output a
//! structural property rather than something to hope for, and it is verified:
//! the crate's own known-answer tests (SHA, HMAC, scrypt key derivation, AEAD
//! envelopes, a sealed box produced by the original JS client) run on BOTH
//! targets, see `crypto_test!` in mod.rs. The *sumo* build is required because
//! native `gen_key()` is scrypt, which the standard build omits.
//!
//! Because libsodium-wrappers needs an async `sodium.ready` before any of its
//! `crypto_*`/`randombytes_*` calls work, and wasm32-unknown-unknown in a
//! browser is single-threaded (a sync fn can't block on a JS Promise without
//! deadlocking), callers MUST call and await `init_wasm_crypto()` exactly
//! once before using any crypto:: function on wasm32 -- see that function's
//! doc comment.

use ::hex;
use ::base64;
#[cfg(not(target_arch = "wasm32"))]
use ::sodiumoxide;
#[cfg(not(target_arch = "wasm32"))]
use ::sodiumoxide::crypto::hash;
#[cfg(not(target_arch = "wasm32"))]
use ::sodiumoxide::crypto::auth as sodium_auth;
#[cfg(not(target_arch = "wasm32"))]
use ::sodiumoxide::crypto::pwhash;
#[cfg(target_arch = "wasm32")]
use ::wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use ::std::sync::atomic::{AtomicBool, Ordering};
use ::crypto::error::{CResult, CryptoError};

/// wasm32 real-crypto bridge to `libsodium-wrappers-sumo` (real libsodium.js), per
/// docs/wasm-port-plan.md decision 2.1. See `../../js/sodium_bridge.js` for
/// the JS glue this binds to -- this is the same bridge mechanism already
/// proven byte-exact against native `sodiumoxide` in the standalone
/// `core/wasm-crypto-poc` crate.
#[cfg(target_arch = "wasm32")]
mod wasm_bridge {
    use ::wasm_bindgen::prelude::*;

    #[wasm_bindgen(module = "/js/sodium_bridge.js")]
    extern "C" {
        /// Resolves once libsodium-wrappers' underlying wasm module has
        /// finished loading. Must be awaited (via `init_wasm_crypto()`,
        /// below) before any other function in this module is called.
        #[wasm_bindgen(js_name = sodiumReady)]
        pub fn sodium_ready() -> ::js_sys::Promise;

        /// Real chacha20poly1305_ietf AEAD seal via libsodium-wrappers.
        #[wasm_bindgen(js_name = aeadEncrypt, catch)]
        pub fn aead_encrypt(key: &[u8], nonce: &[u8], ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// Real chacha20poly1305_ietf AEAD open via libsodium-wrappers.
        #[wasm_bindgen(js_name = aeadDecrypt, catch)]
        pub fn aead_decrypt(key: &[u8], nonce: &[u8], ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// Real CSPRNG bytes via libsodium-wrappers' randombytes_buf.
        #[wasm_bindgen(js_name = randomBytes, catch)]
        pub fn random_bytes(len: u32) -> Result<Vec<u8>, JsValue>;

        /// crypto_hash_sha256.
        #[wasm_bindgen(js_name = hashSha256, catch)]
        pub fn hash_sha256(data: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// crypto_hash_sha512.
        #[wasm_bindgen(js_name = hashSha512, catch)]
        pub fn hash_sha512(data: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// crypto_auth (HMAC-SHA512-256). `key` must already be validated as 32 bytes.
        #[wasm_bindgen(js_name = hmacSha512256, catch)]
        pub fn hmac_sha512256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// scrypt (crypto_pwhash_scryptsalsa208sha256). `salt` must already be validated as 32 bytes.
        #[wasm_bindgen(js_name = scryptDeriveKey, catch)]
        pub fn scrypt_derive_key(password: &[u8], salt: &[u8], ops_limit: u32, mem_limit: u32, out_len: u32) -> Result<Vec<u8>, JsValue>;

        /// crypto_box_keypair: the 32-byte public key followed by the 32-byte secret key.
        #[wasm_bindgen(js_name = boxKeypair, catch)]
        pub fn box_keypair() -> Result<Vec<u8>, JsValue>;

        /// crypto_box_seal (anonymous sealed box). `pubkey` must already be validated as 32 bytes.
        #[wasm_bindgen(js_name = sealedBoxSeal, catch)]
        pub fn sealed_box_seal(pubkey: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// crypto_box_seal_open; errors if the box doesn't open. Keys must already be validated as 32 bytes.
        #[wasm_bindgen(js_name = sealedBoxOpen, catch)]
        pub fn sealed_box_open(pubkey: &[u8], privkey: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue>;
    }
}

/// Tracks whether `init_wasm_crypto()` has resolved yet. wasm32-unknown-unknown
/// in a browser is single-threaded, so a plain atomic flag is enough here --
/// no real synchronization primitive (e.g. a `Mutex`) is needed.
#[cfg(target_arch = "wasm32")]
static CRYPTO_READY: AtomicBool = AtomicBool::new(false);

/// A manual (non-`async fn`) `Future` that awaits `sodium.ready` and then
/// marks `CRYPTO_READY`. Written by hand rather than as `async fn .. { ..
/// .await .. }` because `turtl_core` is (and, per docs/wasm-port-plan.md,
/// stays) a Rust 2015-edition crate -- `async`/`.await` syntax is rejected
/// outright there (`error[E0670]: async fn is not permitted in Rust 2015`),
/// and bumping the crate's edition to get the sugar is NOT a safe, narrow
/// change: it was tried and reverted during this milestone (edition 2018
/// broke ~600 unrelated call sites crate-wide, from this crate's pervasive
/// 2015-style macro/path resolution). Implementing the `Future` trait by
/// hand has no such restriction -- only the `async`/`.await` *syntax* is
/// edition-gated, not the trait itself.
#[cfg(target_arch = "wasm32")]
struct InitCryptoFuture {
    ready: ::wasm_bindgen_futures::JsFuture,
}

#[cfg(target_arch = "wasm32")]
impl ::std::future::Future for InitCryptoFuture {
    type Output = Result<JsValue, JsValue>;

    fn poll(self: ::std::pin::Pin<&mut Self>, cx: &mut ::std::task::Context) -> ::std::task::Poll<Self::Output> {
        let this = self.get_mut();
        match ::std::pin::Pin::new(&mut this.ready).poll(cx) {
            ::std::task::Poll::Ready(Ok(_)) => {
                CRYPTO_READY.store(true, Ordering::Relaxed);
                ::std::task::Poll::Ready(Ok(JsValue::UNDEFINED))
            }
            ::std::task::Poll::Ready(Err(e)) => ::std::task::Poll::Ready(Err(e)),
            ::std::task::Poll::Pending => ::std::task::Poll::Pending,
        }
    }
}

/// Must be called and awaited (from JS: `await wasm.initWasmCrypto()`)
/// exactly once, before any other `crypto::` function is used on wasm32 --
/// `rand_bytes()`, `chacha20poly1305::{encrypt, decrypt}`, the hashes, `hmac()`,
/// `gen_key()` (scrypt), the `asym` sealed-box functions, and everything
/// built on top of them (`crypto::encrypt()`/`crypto::decrypt()` in
/// `mod.rs`, and everything in `models/` that goes through those, e.g.
/// `models/protected.rs`, `models/file.rs`, `models/user.rs`).
///
/// This one entry point exists (and is the *only* async-flavored crypto fn)
/// because `libsodium-wrappers` needs an async `sodium.ready` before any of
/// its `crypto_*`/`randombytes_*` calls work (the underlying Emscripten wasm
/// module has to finish loading first), but `wasm32-unknown-unknown` in a
/// browser is single-threaded: a synchronous Rust fn cannot block on a JS
/// Promise without deadlocking (nothing could run the microtask queue that
/// would resolve it). Making `rand_bytes()`/`chacha20poly1305::{encrypt,
/// decrypt}` themselves async instead would force `crypto::encrypt()`/
/// `decrypt()` and everything that calls them to become async too -- a much
/// bigger, separate "make the whole crate async" refactor, not part of this
/// milestone. So instead: await this once (via the returned `Promise`), then
/// every other crypto function stays a plain, synchronous fn with the exact
/// same signature as native, calling into the (by-then-ready) synchronous JS
/// bridge functions above.
///
/// Returns a `js_sys::Promise` (rather than being an `async fn`, which this
/// Rust-2015-edition crate cannot use -- see `InitCryptoFuture`'s doc comment)
/// so a JS embedder can `await wasm.initWasmCrypto()` directly, and so
/// in-crate Rust callers (e.g. this file's own wasm-bindgen-test tests, in
/// `crypto/mod.rs`) can drive it via `wasm_bindgen_futures::JsFuture`.
/// Calling any of those crypto functions before this has resolved is a
/// programming error on the embedder's part: `require_wasm_crypto_ready()`
/// turns it into a `CryptoError::OperationFailed` with a clear message, not a
/// silent no-op or fallback.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = initWasmCrypto)]
pub fn init_wasm_crypto() -> ::js_sys::Promise {
    let fut = InitCryptoFuture { ready: ::wasm_bindgen_futures::JsFuture::from(wasm_bridge::sodium_ready()) };
    ::wasm_bindgen_futures::future_to_promise(fut)
}

/// Returns an error unless `init_wasm_crypto()` has already resolved. Called
/// at the top of every real wasm32 crypto primitive below.
#[cfg(target_arch = "wasm32")]
fn require_wasm_crypto_ready(fn_name: &str) -> CResult<()> {
    if CRYPTO_READY.load(Ordering::Relaxed) {
        Ok(())
    } else {
        Err(CryptoError::OperationFailed(format!(
            "crypto::low::{}() -- wasm crypto bridge not initialized; call and await crypto::low::init_wasm_crypto() once before any crypto:: call (see docs/wasm-port-plan.md)",
            fn_name
        )))
    }
}

/// Abstract the size of hmac keys
#[allow(dead_code)]
#[cfg(not(target_arch = "wasm32"))]
pub const HMAC_KEYLEN: usize = sodium_auth::KEYBYTES;
/// Abstract the size of hmac keys
// Literal value of sodiumoxide::crypto::auth::KEYBYTES (HMAC-SHA512-256); libsodium.js reports the
// same 32. `can_hmac_256` slices its key to this length and compares against a known answer, on
// both targets, so a drifted value fails there.
#[allow(dead_code)]
#[cfg(target_arch = "wasm32")]
pub const HMAC_KEYLEN: usize = 32;

/// Abstract the size of salts in our KDF
pub const KEYGEN_SALT_LEN: usize = 32;

/// Abstract the ops limit for key generation (524288)
#[cfg(not(target_arch = "wasm32"))]
pub const KEYGEN_OPS_DEFAULT: usize = pwhash::OPSLIMIT_INTERACTIVE.0;
/// Abstract the mem limit for key generation (16777216)
#[cfg(not(target_arch = "wasm32"))]
pub const KEYGEN_MEM_DEFAULT: usize = pwhash::MEMLIMIT_INTERACTIVE.0;
// Literal values of sodiumoxide's pwhash::OPSLIMIT_INTERACTIVE / MEMLIMIT_INTERACTIVE (scrypt);
// libsodium.js reports the same 524288 / 16777216. The known-answer key derivations in the tests
// run on both targets with these constants, so a drifted value fails there.
#[cfg(target_arch = "wasm32")]
pub const KEYGEN_OPS_DEFAULT: usize = 524288;
#[cfg(target_arch = "wasm32")]
pub const KEYGEN_MEM_DEFAULT: usize = 16777216;

/// Run a sha256 hash on some data
#[allow(dead_code)]
#[cfg(not(target_arch = "wasm32"))]
pub fn sha256(data: &[u8]) -> CResult<Vec<u8>> {
    Ok(hash::sha256::hash(data).0.to_vec())
}
/// Run a sha256 hash on some data
///
/// libsodium.js's crypto_hash_sha256 via the JS bridge. Requires `init_wasm_crypto()` to have been
/// awaited first.
#[allow(dead_code)]
#[cfg(target_arch = "wasm32")]
pub fn sha256(data: &[u8]) -> CResult<Vec<u8>> {
    require_wasm_crypto_ready("sha256")?;
    wasm_bridge::hash_sha256(data)
        .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::sha256() -- js bridge error: {:?}", e)))
}

/// Run a sha512 hash on some data
#[cfg(not(target_arch = "wasm32"))]
pub fn sha512(data: &[u8]) -> CResult<Vec<u8>> {
    Ok(hash::sha512::hash(data).0.to_vec())
}
/// Run a sha512 hash on some data
///
/// libsodium.js's crypto_hash_sha512 via the JS bridge. Requires `init_wasm_crypto()` to have been
/// awaited first.
#[cfg(target_arch = "wasm32")]
pub fn sha512(data: &[u8]) -> CResult<Vec<u8>> {
    require_wasm_crypto_ready("sha512")?;
    wasm_bridge::hash_sha512(data)
        .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::sha512() -- js bridge error: {:?}", e)))
}

/// Convert a byte array into a hex string
pub fn to_hex(data: &Vec<u8>) -> CResult<String> {
    Ok(hex::encode(data))
}

/// Convert a hex string to a u8 vector.
#[allow(dead_code)]
pub fn from_hex(data: &String) -> CResult<Vec<u8>> {
    Ok(hex::decode(data)?)
}

/// Convert a u8 vector of binary data into a base64 string.
pub fn to_base64(data: &Vec<u8>) -> CResult<String> {
    Ok(base64::encode(data))
}

/// Convert a base64 string to a vector of u8 data.
pub fn from_base64(data: &String) -> CResult<Vec<u8>> {
    Ok(base64::decode(data)?)
}

/// Given a key (password/secret) and a set of data, run an HMAC-SHA512256 and
/// return the binary result as a u8 vec.
#[allow(dead_code)]
#[cfg(not(target_arch = "wasm32"))]
pub fn hmac(key: &[u8], data: &[u8]) -> CResult<Vec<u8>> {
    let key = match sodium_auth::Key::from_slice(key) {
        Some(x) => x,
        None => return Err(CryptoError::BadData(format!("crypto::low::hmac() -- invalid hmac key supplied"))),
    };
    let tag = sodium_auth::authenticate(data, &key);
    Ok(tag.0.to_vec())
}
/// Given a key (password/secret) and a set of data, run an HMAC-SHA512256 and
/// return the binary result as a u8 vec.
///
/// libsodium.js's crypto_auth via the JS bridge. The key length is checked here, so a bad key is
/// the same `BadData` error native gives (libsodium.js would throw its own, differently-worded
/// one). Requires `init_wasm_crypto()` to have been awaited first.
#[allow(dead_code)]
#[cfg(target_arch = "wasm32")]
pub fn hmac(key: &[u8], data: &[u8]) -> CResult<Vec<u8>> {
    if key.len() != HMAC_KEYLEN {
        return Err(CryptoError::BadData(format!("crypto::low::hmac() -- invalid hmac key supplied")));
    }
    require_wasm_crypto_ready("hmac")?;
    wasm_bridge::hmac_sha512256(key, data)
        .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::hmac() -- js bridge error: {:?}", e)))
}

/// Do a secure comparison of two byte arrays.
///
/// We do this using the double-hmac method, as opposed to fighting tooth and
/// nail against compilers of various platforms in search for a constant-time
/// comparison method.
///
/// This takes a bit more legwork, but is able to securely compare two values
/// without leaking information about either.
#[allow(dead_code)]
#[cfg(not(target_arch = "wasm32"))]
pub fn secure_compare(arr1: &[u8], arr2: &[u8]) -> CResult<bool> {
    let key = sodium_auth::gen_key().0.to_vec();
    let hash1 = hmac(key.as_slice(), arr1)?;
    let hash2 = hmac(key.as_slice(), arr2)?;
    Ok(hash1 == hash2)
}
/// Do a secure comparison of two byte arrays.
///
/// The same double-hmac method as native (see above), with the throwaway key coming from
/// `rand_bytes()` instead of `sodium_auth::gen_key()` -- both are just KEYBYTES of CSPRNG output.
#[allow(dead_code)]
#[cfg(target_arch = "wasm32")]
pub fn secure_compare(arr1: &[u8], arr2: &[u8]) -> CResult<bool> {
    let key = rand_bytes(HMAC_KEYLEN)?;
    let hash1 = hmac(key.as_slice(), arr1)?;
    let hash2 = hmac(key.as_slice(), arr2)?;
    Ok(hash1 == hash2)
}

/// Generate N number of CS random bytes.
#[cfg(not(target_arch = "wasm32"))]
pub fn rand_bytes(len: usize) -> CResult<Vec<u8>> {
    Ok(sodiumoxide::randombytes::randombytes(len))
}
/// Generate N number of CS random bytes.
///
/// Real implementation via the libsodium.js JS bridge (docs/wasm-port-plan.md
/// decision 2.1) -- NOT a second RNG crate/implementation. Requires
/// `init_wasm_crypto()` to have been awaited first.
#[cfg(target_arch = "wasm32")]
pub fn rand_bytes(len: usize) -> CResult<Vec<u8>> {
    require_wasm_crypto_ready("rand_bytes")?;
    wasm_bridge::random_bytes(len as u32)
        .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::rand_bytes() -- js bridge error: {:?}", e)))
}

/// Generate a random u64. Uses rand_bytes() and bit shifting to build a u64.
pub fn rand_int() -> CResult<u64> {
    let bytes = rand_bytes(8)?;
    let mut val: u64 = 0;
    for &x in &bytes {
        val = val << 8;
        val += x as u64;
    }
    Ok(val)
}

/// Generate a random floating point (f64) between 0.0 and 1.0. Uses rand_int()
/// and divides it by u64::MAX to get the value.
#[allow(dead_code)]
pub fn rand_float() -> CResult<f64> {
    Ok((rand_int()? as f64) / (::std::u64::MAX as f64))
}

/// Generate a random salt for use with the key deriver (gen_key())
#[allow(dead_code)]
#[cfg(not(target_arch = "wasm32"))]
pub fn random_salt() -> CResult<Vec<u8>> {
    Ok(pwhash::gen_salt().0.to_vec())
}
/// Generate a random salt for use with the key deriver (gen_key())
///
/// Native's `pwhash::gen_salt()` is SALTBYTES (32) bytes of CSPRNG output, which is exactly this.
#[allow(dead_code)]
#[cfg(target_arch = "wasm32")]
pub fn random_salt() -> CResult<Vec<u8>> {
    rand_bytes(KEYGEN_SALT_LEN)
}

/// Generate a key given a password and a salt
#[cfg(not(target_arch = "wasm32"))]
pub fn gen_key(password: &[u8], salt: &[u8], cpu: usize, mem: usize) -> CResult<Vec<u8>> {
    let len = chacha20poly1305::keylen();
    let mut key: Vec<u8> = vec![0; len];
    let salt_wrap = match pwhash::Salt::from_slice(salt) {
        Some(x) => x,
        None => return Err(CryptoError::BadData(format!("crypto::low::gen_key() -- bad salt given"))),
    };
    match pwhash::derive_key(key.as_mut_slice(), password, &salt_wrap, pwhash::OpsLimit(cpu), pwhash::MemLimit(mem)) {
        Ok(x) => Ok(Vec::from(x)),
        Err(()) => Err(CryptoError::OperationFailed(format!("crypto::low::gen_key() -- could not generate key (OOM?)"))),
    }
}
/// Generate a key given a password and a salt
///
/// scrypt via libsodium.js (`crypto_pwhash_scryptsalsa208sha256`, the same function native's
/// `pwhash::derive_key` calls), so the derived key is byte-identical to native and to every
/// existing client: this is what turns a user's passphrase into the master key. The password is
/// passed as raw bytes. The salt length is checked here (native's `Salt::from_slice` does the
/// same). Requires `init_wasm_crypto()` to have been awaited first.
#[cfg(target_arch = "wasm32")]
pub fn gen_key(password: &[u8], salt: &[u8], cpu: usize, mem: usize) -> CResult<Vec<u8>> {
    if salt.len() != KEYGEN_SALT_LEN {
        return Err(CryptoError::BadData(format!("crypto::low::gen_key() -- bad salt given")));
    }
    require_wasm_crypto_ready("gen_key")?;
    // usize is 32 bits on wasm32, so the `as u32` casts are lossless.
    wasm_bridge::scrypt_derive_key(password, salt, cpu as u32, mem as u32, chacha20poly1305::keylen() as u32)
        .map_err(|_| CryptoError::OperationFailed(format!("crypto::low::gen_key() -- could not generate key (OOM?)")))
}

pub mod chacha20poly1305 {
    //! Our chacha20poly1305 wrapper.

    #[cfg(not(target_arch = "wasm32"))]
    use ::sodiumoxide::crypto::aead::chacha20poly1305_ietf as aead;
    use ::crypto::{CResult, CryptoError};

    /// Get the key length for chacha20poly1305
    #[cfg(not(target_arch = "wasm32"))]
    pub fn keylen() -> usize {
        aead::KEYBYTES
    }
    /// Get the key length for chacha20poly1305
    // Hardcoded to match sodiumoxide's chacha20poly1305_ietf::KEYBYTES (32) --
    // this is a public algorithm-dimension constant, not a secret, so it's safe to mirror
    // directly rather than stub as NotImplemented. See docs/wasm-port-plan.md.
    #[cfg(target_arch = "wasm32")]
    pub fn keylen() -> usize {
        32
    }

    /// Get the nonce length for chacha20poly1305
    #[cfg(not(target_arch = "wasm32"))]
    pub fn noncelen() -> usize {
        aead::NONCEBYTES
    }
    /// Get the nonce length for chacha20poly1305
    // Hardcoded to match sodiumoxide's chacha20poly1305_ietf::NONCEBYTES (12), same
    // rationale as keylen() above. See docs/wasm-port-plan.md.
    #[cfg(target_arch = "wasm32")]
    pub fn noncelen() -> usize {
        12
    }

    /// Generate a key specifically for use with chacha20poly1305
    pub fn random_key() -> CResult<Vec<u8>> {
        super::rand_bytes(keylen())
    }

    /// Generate a nonce specifically for use with chacha20poly1305
    pub fn random_nonce() -> CResult<Vec<u8>> {
        super::rand_bytes(noncelen())
    }

    /// Encrypt data using chacha20poly1305
    #[cfg(not(target_arch = "wasm32"))]
    pub fn encrypt(key: &[u8], nonce: &[u8], auth: &[u8], plaintext: &[u8]) -> CResult<Vec<u8>> {
        let key_wrap = match aead::Key::from_slice(key) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(format!("crypto::low::encrypt() -- bad key given"))),
        };
        let nonce_wrap = match aead::Nonce::from_slice(nonce) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(format!("crypto::low::encrypt() -- bad nonce given"))),
        };
        Ok(aead::seal(plaintext, Some(auth), &nonce_wrap, &key_wrap))
    }
    /// Encrypt data using chacha20poly1305
    ///
    /// Real implementation via the libsodium.js JS bridge (docs/wasm-port-plan.md
    /// decision 2.1) -- byte-identical to native by construction (same
    /// underlying C implementation, just Emscripten-built), already proven
    /// out in `core/wasm-crypto-poc`. Requires `init_wasm_crypto()` to have
    /// been awaited first.
    #[cfg(target_arch = "wasm32")]
    pub fn encrypt(key: &[u8], nonce: &[u8], auth: &[u8], plaintext: &[u8]) -> CResult<Vec<u8>> {
        super::require_wasm_crypto_ready("chacha20poly1305::encrypt")?;
        super::wasm_bridge::aead_encrypt(key, nonce, auth, plaintext)
            .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::chacha20poly1305::encrypt() -- js bridge error: {:?}", e)))
    }

    /// Decrypt data using chacha20poly1305
    #[cfg(not(target_arch = "wasm32"))]
    pub fn decrypt(key: &[u8], nonce: &[u8], auth: &[u8], ciphertext: &[u8]) -> CResult<Vec<u8>> {
        let key_wrap = match aead::Key::from_slice(key) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(format!("crypto::low::decrypt() -- bad key given"))),
        };
        let nonce_wrap = match aead::Nonce::from_slice(nonce) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(format!("crypto::low::decrypt() -- bad nonce given"))),
        };
        match aead::open(ciphertext, Some(auth), &nonce_wrap, &key_wrap) {
            Ok(x) => Ok(x),
            Err(_) => Err(CryptoError::Authentication(format!("crypto::low::decrypt() -- authentication failed while decrypting"))),
        }
    }
    /// Decrypt data using chacha20poly1305
    ///
    /// Real implementation via the libsodium.js JS bridge (docs/wasm-port-plan.md
    /// decision 2.1), same rationale/provenance as encrypt() above. Requires
    /// `init_wasm_crypto()` to have been awaited first. Once that's true, any
    /// error from the bridge here (bad key/nonce, or -- the common case --
    /// tampered/mismatched additional-authenticated-data or ciphertext) means
    /// authentication failed, mirroring native's `aead::open` error mapping.
    #[cfg(target_arch = "wasm32")]
    pub fn decrypt(key: &[u8], nonce: &[u8], auth: &[u8], ciphertext: &[u8]) -> CResult<Vec<u8>> {
        super::require_wasm_crypto_ready("chacha20poly1305::decrypt")?;
        super::wasm_bridge::aead_decrypt(key, nonce, auth, ciphertext)
            .map_err(|_| CryptoError::Authentication(format!("crypto::low::chacha20poly1305::decrypt() -- authentication failed while decrypting")))
    }
}

pub mod asym {
    use ::crypto::error::{CryptoError, CResult};
    #[cfg(not(target_arch = "wasm32"))]
    use ::sodiumoxide::crypto::box_ as crypto_box;
    #[cfg(not(target_arch = "wasm32"))]
    use ::sodiumoxide::crypto::sealedbox;

    /// Generate a public/private keypair for use with the crypto::box lib
    #[cfg(not(target_arch = "wasm32"))]
    pub fn keygen() -> CResult<(Vec<u8>, Vec<u8>)> {
        let (pk, sk) = crypto_box::gen_keypair();
        Ok((pk.0.to_vec(), sk.0.to_vec()))
    }
    /// crypto_box_PUBLICKEYBYTES / crypto_box_SECRETKEYBYTES (curve25519): both 32.
    #[cfg(target_arch = "wasm32")]
    const PUBLICKEYBYTES: usize = 32;
    #[cfg(target_arch = "wasm32")]
    const SECRETKEYBYTES: usize = 32;

    /// Generate a public/private keypair for use with the crypto::box lib
    ///
    /// libsodium.js's crypto_box_keypair via the JS bridge. Requires `init_wasm_crypto()` to have
    /// been awaited first.
    #[cfg(target_arch = "wasm32")]
    pub fn keygen() -> CResult<(Vec<u8>, Vec<u8>)> {
        super::require_wasm_crypto_ready("asym::keygen")?;
        let both = super::wasm_bridge::box_keypair()
            .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::asym::keygen() -- js bridge error: {:?}", e)))?;
        if both.len() != PUBLICKEYBYTES + SECRETKEYBYTES {
            return Err(CryptoError::OperationFailed(format!("crypto::low::asym::keygen() -- js bridge returned {} bytes, expected {}", both.len(), PUBLICKEYBYTES + SECRETKEYBYTES)));
        }
        Ok((both[..PUBLICKEYBYTES].to_vec(), both[PUBLICKEYBYTES..].to_vec()))
    }

    /// Encrypt data using crypto_box (asym)
    #[cfg(not(target_arch = "wasm32"))]
    pub fn encrypt(their_pubkey: &[u8], plaintext: &[u8]) -> CResult<Vec<u8>> {
        let pubkey = match crypto_box::PublicKey::from_slice(their_pubkey) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(String::from("crypto::low::async::encrypt() -- bad public key given"))),
        };
        Ok(sealedbox::seal(plaintext, &pubkey))
    }
    /// Encrypt data using crypto_box (asym)
    ///
    /// libsodium.js's crypto_box_seal via the JS bridge; the key length is checked here so a bad
    /// key is native's `BadData` error. Requires `init_wasm_crypto()` to have been awaited first.
    #[cfg(target_arch = "wasm32")]
    pub fn encrypt(their_pubkey: &[u8], plaintext: &[u8]) -> CResult<Vec<u8>> {
        if their_pubkey.len() != PUBLICKEYBYTES {
            return Err(CryptoError::BadData(String::from("crypto::low::async::encrypt() -- bad public key given")));
        }
        super::require_wasm_crypto_ready("asym::encrypt")?;
        super::wasm_bridge::sealed_box_seal(their_pubkey, plaintext)
            .map_err(|e| CryptoError::OperationFailed(format!("crypto::low::asym::encrypt() -- js bridge error: {:?}", e)))
    }

    /// Decrypt data using crypto_box (asym)
    #[cfg(not(target_arch = "wasm32"))]
    pub fn decrypt(our_pubkey: &[u8], our_privkey: &[u8], ciphertext: &[u8]) -> CResult<Vec<u8>> {
        let pubkey = match crypto_box::PublicKey::from_slice(our_pubkey) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(String::from("crypto::low::async::decrypt() -- bad public key given"))),
        };
        let privkey = match crypto_box::SecretKey::from_slice(our_privkey) {
            Some(x) => x,
            None => return Err(CryptoError::BadData(String::from("crypto::low::async::decrypt() -- bad private key given"))),
        };
        match sealedbox::open(ciphertext, &pubkey, &privkey) {
            Ok(x) => Ok(x),
            Err(_) => Err(CryptoError::OperationFailed(String::from("crypto::low::async::decrypt() -- decrypt failed"))),
        }
    }
    /// Decrypt data using crypto_box (asym)
    ///
    /// libsodium.js's crypto_box_seal_open via the JS bridge; the key lengths are checked here so a
    /// bad key is native's `BadData` error, and a box that doesn't open (wrong keys or tampered
    /// data) is native's "decrypt failed". Requires `init_wasm_crypto()` to have been awaited first.
    #[cfg(target_arch = "wasm32")]
    pub fn decrypt(our_pubkey: &[u8], our_privkey: &[u8], ciphertext: &[u8]) -> CResult<Vec<u8>> {
        if our_pubkey.len() != PUBLICKEYBYTES {
            return Err(CryptoError::BadData(String::from("crypto::low::async::decrypt() -- bad public key given")));
        }
        if our_privkey.len() != SECRETKEYBYTES {
            return Err(CryptoError::BadData(String::from("crypto::low::async::decrypt() -- bad private key given")));
        }
        super::require_wasm_crypto_ready("asym::decrypt")?;
        super::wasm_bridge::sealed_box_open(our_pubkey, our_privkey, ciphertext)
            .map_err(|_| CryptoError::OperationFailed(String::from("crypto::low::async::decrypt() -- decrypt failed")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str;
    use std::vec::Vec;
    use std::collections::HashMap;
    use std::u64;
    //use time::PreciseTime;

    /// Grab a random libertarian string, used for testing our heroic crypto
    /// primitives.
    ///
    /// For those who are offended by the data used, and wish to become even
    /// more offended, check out the [elsbot comment history](https://www.reddit.com/user/elsbot),
    /// an aggregation of comments and statements from American propertarians
    /// that are just too ridiculously good not to read.
    fn get_string(key: &str) -> String {
        let mut quotes: HashMap<&str, String> = HashMap::new();

        quotes.insert("the poor", String::from(r#"I've got no issues helping the poor but that isn't where an income tax is going to go and if anything it would make the poor poorer."#));
        quotes.insert("sweatshops", String::from(r#"They wouldn't be forced, that would be their choice. Thankfully, we are out of our industrial revolution, so no one has to make make that choice anymore. However, in third world countries sweatshops are a very good choice, and I would never want to take that choice away from them."#));
        quotes.insert("global warming benefits", String::from(r#"Is the current trend of what appears to be global warming harmful or beneficial? In the news you hear only the negative side of it. But what about the benefits?"#));
        quotes.insert("informed opinion", String::from(r#"My opinion is that I don't know. I don't care enough even to look at the data. I have seen some things that suggest it exists because of the sun and other that it exists because of CO2. I know that shit has been changing for as long as the earth has been. What I don't like is when people say that most or all scientists agree. This is an appeal to authority and should be disregarded. One thing that makes me skeptical of the claims is that the solution is always more state power in some form. I was all ears, then I was told the governments would need more tax money to forgive my sin fix the problem. Riiiiight. I see whats going on here."#));
        quotes.insert("zoning is communism", String::from(r#"This is a violation of private property rights. They're calling it an issue of zoning. Zoning is communism."#));
        quotes.insert("kill your workforce", String::from(r#"Fire them, if they resist, stike or occupy your premises, buy an M134 Minigun to revolve the dispute, then hire new workers"#));
        quotes.insert("age of consent", String::from(r#"Age of consent laws were basically created and supported by the Christian Woman's Association and feminism in order to decrease the supply of available sex to men in order to make it easier for older ladies to find a mate."#));
        quotes.insert("free baby market", String::from(r#"...in a libertarian society the existence of a free baby market will bring such 'neglect' down to a minimum."#));
        quotes.insert("child labor", String::from(r#"If the options available to a person are work or starve, why would you take away the work option? If people are voluntarily choosing to work in a factory under terrible conditions, it means the alternatives available to them are even worse. That work is an opportunity for them to better themselves. Child labour regulations only hampered the development and expansion of the industries that were providing these opportunities."#));
        quotes.insert("social contract", String::from(r#"I can't seem to find this mythical document called the "social contract" you claim I am party to."#));
        quotes.insert("starve the child", String::from(r#"...the parent should have the legal right not to feed the child, i.e., to allow it to die."#));
        quotes.insert("statistical nonsense", String::from(r#"The problem with your argument is that you are relying on statistics to support your worldview."#));
        quotes.insert("genghis khan", String::from(r#"Genghis Khan has done more good for society and the world than any Democracy that has ever existed..."#));
        quotes.insert("no tolerance", String::from(r#"In a covenant...among proprietor and community tenants for the purpose of protecting their private property, no such thing as a right to free (unlimited) speech exists, not even to unlimited speech on one's own tenant-property. One may say innumerable things and promote almost any idea under the sun, but naturally no one is permitted to advocate ideas contrary to the very covenant of preserving and protecting private property, such as democracy and communism. There can be no tolerance toward democrats and communists in a libertarian social order. They will have to be physically separated and removed from society."#));
        quotes.insert("right to starve", String::from(r#"Also I don't see why right to food is a thing. It's not a thing naturally. You have the right to get yourself food in nature, but you aren't entitled to it. It's survival of the fittest."#));
        quotes.insert("slavery", String::from(r#"Should a business owner be forced to provide goods and services to a citizen against their will? That is the basic question here. If a government or any entity is forcing you against your will to use your knowledge, resources, energy, and money, to do something you do not want to do. We have a word for that, it's slavery."#));
        quotes.insert("security services", String::from(r#"If the market for security weren't warped by the violent imposition of a feckless monopoly ("police"), then maybe this child wouldn't have had to provide such a crude implementation of security services for his family."#));
        quotes.insert("filthy statists", String::from(r#"And I can go on for hours on hundreds of free market solutions that could solve that problem, The statist can only come up with one solution, Make A LAW!!!"#));
        quotes.insert("out of context", String::from(r#"None of which is to say that the Empire isn't sometimes brutal. In Episode IV, Imperial stormtroopers kill Luke's aunt and uncle and Grand Moff Tarkin orders the destruction of an entire planet, Alderaan. But viewed in context, these acts are less brutal than they initially appear. Poor Aunt Beru and Uncle Owen reach a grisly end, but only after they aid the rebellion by hiding Luke and harboring two fugitive droids. They aren't given due process, but they are traitors."#));
        quotes.insert("right to harass", String::from(r#"You would have made the choice yourself. No one is holding a gun to your head and telling you to quit, either. If a boss wants to sexually harass you, that's their right. If you want to quit, that is your right. The market will solve any problems."#));
        quotes.insert("honorable labor", String::from(r#"Moreover, the institution of child labor is an honorable one, with a long and glorious history of good works. And the villains of the piece are not the employers, but rather those who prohibit the free market in child labor. These do-gooders are responsible for the untold immiseration of those who are thus forced out of employment. Although the harm done was greater in the past, when great poverty made widespread child labor necessary, there are still people in dire straits today. Present prohibitions of child labor are thus an unconscionable interference with their lives."#));
        quotes.insert("free market justice", String::from(r#"We can theorize all we want about what a free market justice system would look like, but really, we know about as much about it as we could've known about Bitcoin in the year 1999. The freedom to switch services means innovation in ways we can't presently foresee."#));
        // not elsbot, but i had to throw it in
        quotes.insert("minimum wage", String::from(r#"Is there a 'progressive' response to the idea of the minimum wage being immoral because it violates the non-aggression principle?"#));

        if key == "" {
            let mut keys = quotes.keys();
            let rand = match rand_float() {
                Ok(x) => x,
                Err(..) => 0f64,
            };
            let idx = ((keys.len() as f64) * rand).floor() as usize;
            let randkey = keys.nth(idx).unwrap().clone();
            quotes.get(randkey).unwrap().clone()
        } else if quotes.contains_key(key) {
            quotes.get(key).unwrap().clone()
        } else {
            String::from("<not found>")
        }
    }

    #[test]
    fn can_convert_bytes_to_hex() {
        let res = to_hex(&vec![176u8, 11u8, 85u8]).unwrap();
        assert_eq!(res, "b00b55");
    }

    #[test]
    fn can_convert_hex_to_bytes() {
        let res = from_hex(&String::from("b00b55")).unwrap();
        assert_eq!(res, vec![176u8, 11u8, 85u8]);
    }

    #[test]
    fn can_convert_bytes_to_base64() {
        let res = to_base64(&Vec::from(get_string("the poor").as_bytes())).unwrap();
        assert_eq!(res, "SSd2ZSBnb3Qgbm8gaXNzdWVzIGhlbHBpbmcgdGhlIHBvb3IgYnV0IHRoYXQgaXNuJ3Qgd2hlcmUgYW4gaW5jb21lIHRheCBpcyBnb2luZyB0byBnbyBhbmQgaWYgYW55dGhpbmcgaXQgd291bGQgbWFrZSB0aGUgcG9vciBwb29yZXIu");
    }

    #[test]
    fn can_convert_base64_to_bytes() {
        let res = from_base64(&String::from("VGhleSB3b3VsZG4ndCBiZSBmb3JjZWQsIHRoYXQgd291bGQgYmUgdGhlaXIgY2hvaWNlLiBUaGFua2Z1bGx5LCB3ZSBhcmUgb3V0IG9mIG91ciBpbmR1c3RyaWFsIHJldm9sdXRpb24sIHNvIG5vIG9uZSBoYXMgdG8gbWFrZSBtYWtlIHRoYXQgY2hvaWNlIGFueW1vcmUuIEhvd2V2ZXIsIGluIHRoaXJkIHdvcmxkIGNvdW50cmllcyBzd2VhdHNob3BzIGFyZSBhIHZlcnkgZ29vZCBjaG9pY2UsIGFuZCBJIHdvdWxkIG5ldmVyIHdhbnQgdG8gdGFrZSB0aGF0IGNob2ljZSBhd2F5IGZyb20gdGhlbS4=")).unwrap();
        assert_eq!(String::from_utf8(res).unwrap(), get_string("sweatshops"));
    }

    fn can_sha256_body() {
        let data = get_string("global warming benefits");
        let hash = to_hex(&sha256(data.as_bytes()).unwrap()).unwrap();
        assert_eq!(hash, "bb2747436ce21a01d44636f4566e65a60c982dac2f493d2e517089f2d3b03e71");
    }

    fn can_sha512_body() {
        let data = get_string("informed opinion");
        let hash = to_hex(&sha512(data.as_bytes()).unwrap()).unwrap();
        assert_eq!(hash, "c077cf5be30704b119a0cd4b28947f12b02152543030f649f45dd518636831f71d889d7236eb6041dc4f661c8bc823425269a5f798287badb41fb9ecf750490e");
    }

    fn can_hmac_256_body() {
        let data = get_string("zoning is communism");
        let keystr = get_string("kill your workforce");
        let key = sha512(keystr.as_bytes()).unwrap();
        let res = to_hex(&hmac(&key[0..HMAC_KEYLEN], &data.as_bytes()).unwrap()).unwrap();
        assert_eq!(res, "9308b40116068920c7cea98aa5bbc340cfabdaa27316413804050cfc6a7b4873");
    }

    fn random_bytes_works_body() {
        let bytes = rand_bytes(4).unwrap();
        assert_eq!(bytes.len(), 4);
    }

    fn random_int_works_body() {
        let int = rand_int().unwrap();
        assert!(int <= u64::MAX);
    }

    fn random_float_works_body() {
        let val = rand_float().unwrap();
        assert!(0f64 <= val);
        assert!(val <= 1f64);
    }

    fn can_generate_keys_body() {
        let password = String::from("not at all, to some extent (always the same), very much so, don't know");
        let salt = sha256(String::from("don't know").as_bytes()).unwrap();
        let key = gen_key(password.as_bytes(), &salt[0..KEYGEN_SALT_LEN], KEYGEN_OPS_DEFAULT, KEYGEN_MEM_DEFAULT).unwrap();
        // TODO: verify independently
        assert_eq!(key, vec![191, 247, 89, 55, 132, 218, 68, 194, 90, 194, 233, 50, 99, 98, 25, 230, 102, 217, 215, 59, 136, 61, 249, 107, 127, 124, 62, 119, 145, 56, 216, 191]);
    }

    fn can_encrypt_chacha20poly1305_body() {
        let key = from_base64(&String::from("v/dZN4TaRMJawukyY2IZ5mbZ1zuIPflrf3w+d5E42L8=")).unwrap();
        let plaintext = get_string("minimum wage");
        let nonce: Vec<u8> = vec![235, 108, 139, 46, 102, 80, 89, 151, 101, 191, 11, 130];
        let mut auth: Vec<u8> = vec![0, 6, 4, 0, 1, 0, 2, nonce.len() as u8];
        auth.append(&mut nonce.clone());
        let enc = chacha20poly1305::encrypt(key.as_slice(), nonce.as_slice(), auth.as_slice(), plaintext.as_bytes()).unwrap();
        assert_eq!(to_base64(&enc).unwrap(), "fL/qHHkkvTiLo8a7xcUJKOyiXZGhAUW8OLXDXB4D5KQ1JGbRenWpxiuGw/bLIWin3/7ZgDTQJ7TuH9CvPJF07HQBMdGaeM8hjhJQxtDLmcM/ntGCXXQ8+3dk5u1u1Wru2P5QBjuCHWaN9ccRc8wlMLr2r5MWdED6nAIEDa8nUvxQaOLlMRSp8TGGAGKi2e4+vg==");
    }

    fn can_decrypt_chacha20poly1305_body() {
        let key = from_base64(&String::from("v/dZN4TaRMJawukyY2IZ5mbZ1zuIPflrf3w+d5E42L8=")).unwrap();
        let ciphertext = from_base64(&String::from("fL/qHHkkvTiLo8a7xcUJKOyiXZGhAUW8OLXDXB4D5KQ1JGbRenWpxiuGw/bLIWin3/7ZgDTQJ7TuH9CvPJF07HQBMdGaeM8hjhJQxtDLmcM/ntGCXXQ8+3dk5u1u1Wru2P5QBjuCHWaN9ccRc8wlMLr2r5MWdED6nAIEDa8nUvxQaOLlMRSp8TGGAGKi2e4+vg==")).unwrap();
        let nonce: Vec<u8> = vec![235, 108, 139, 46, 102, 80, 89, 151, 101, 191, 11, 130];
        let mut auth: Vec<u8> = vec![0, 6, 4, 0, 1, 0, 2, nonce.len() as u8];
        auth.append(&mut nonce.clone());
        let dec = chacha20poly1305::decrypt(key.as_slice(), nonce.as_slice(), auth.as_slice(), ciphertext.as_slice()).unwrap();
        assert_eq!(String::from_utf8(dec).unwrap(), get_string("minimum wage"));
    }

    fn auth_failure_body() {
        let password = String::from("mike fitzgibbon's son is a nuclear physicist, and my son CAN EAT A CHICKENNNN SANDWHICHHHHH");
        let plaintext = get_string("");

        // make sure your compost pile gets plenty of air
        let salt = random_salt().unwrap();
        let key = gen_key(password.as_bytes(), salt.as_slice(), 2, 2048).unwrap();
        let nonce = chacha20poly1305::random_nonce().unwrap();
        // hardcode what very well might be a header for a turtl message
        let mut auth: Vec<u8> = vec![0, 6, 4, 0, 1, 0, 2, nonce.len() as u8];
        auth.append(&mut nonce.clone());

        let enc = chacha20poly1305::encrypt(key.as_slice(), nonce.as_slice(), auth.as_slice(), plaintext.as_bytes()).unwrap();
        // let's downgrade the version LOL!
        auth[1] = 5;
        match chacha20poly1305::decrypt(key.as_slice(), nonce.as_slice(), auth.as_slice(), enc.as_slice()) {
            Ok(..) => panic!("Authentication succeeded on bad data!"),
            Err(e) => match e {
                CryptoError::Authentication(..) => {},
                _ => panic!("Non-authentication error: {}", e),
            }
        };
        auth[1] = 6;
        let dec = chacha20poly1305::decrypt(key.as_slice(), nonce.as_slice(), auth.as_slice(), enc.as_slice()).unwrap(); 
        assert_eq!(String::from_utf8(dec).unwrap(), plaintext);
    }

    /// we aren't going to test for contant-time avoidance or anything like that
    /// but we can at least make sure two equal values return true and two
    /// different values return false.
    fn secure_comparison_body() {
        let key1 = sha256(String::from("harrr").as_bytes()).unwrap();
        let key2 = sha256(String::from("harrr").as_bytes()).unwrap();
        let key3 = sha256(get_string("child labor").as_bytes()).unwrap();

        let comp1 = secure_compare(key1.as_slice(), key2.as_slice()).unwrap();
        let comp2 = secure_compare(key1.as_slice(), key3.as_slice()).unwrap();
        assert_eq!(comp1, true);
        assert_eq!(comp2, false);
    }

    fn asym_crypto_body() {
        let (her_pk, her_sk) = asym::keygen().unwrap();
        let message = String::from("I'M NOT A PERVERT");

        let encrypted = asym::encrypt(her_pk.as_slice(), message.as_bytes()).unwrap();
        let decrypted = asym::decrypt(her_pk.as_slice(), her_sk.as_slice(), encrypted.as_slice()).unwrap();
        let decrypted_str = String::from_utf8(decrypted).unwrap();
        assert_eq!(decrypted_str, "I'M NOT A PERVERT");
    }

    /// Independent anchor for the hashes: the FIPS 180 "abc" test vectors. The other hash tests use
    /// this project's own expected values; these come from the standard, not from this codebase.
    fn hashes_match_standard_vectors_body() {
        assert_eq!(
            to_hex(&sha256(b"abc").unwrap()).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            to_hex(&sha512(b"abc").unwrap()).unwrap(),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        // and the empty input, which exercises a zero-length view across the JS bridge on wasm32
        assert_eq!(
            to_hex(&sha256(b"").unwrap()).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// Bad key/salt lengths and boxes that won't open must fail with the same error *kinds* on
    /// every target (native checks these via sodiumoxide's `from_slice`; wasm32 checks them in Rust
    /// before the JS bridge, since libsodium.js would throw its own differently-worded errors).
    fn rejects_bad_inputs_body() {
        fn is_bad_data<T: ::std::fmt::Debug>(res: CResult<T>) -> bool {
            match res { Err(CryptoError::BadData(..)) => true, _ => false }
        }
        // hmac wants exactly HMAC_KEYLEN bytes of key
        assert!(is_bad_data(hmac(&[7u8; 16], b"data")));
        assert!(is_bad_data(hmac(&[7u8; 33], b"data")));
        // scrypt wants exactly KEYGEN_SALT_LEN bytes of salt
        assert!(is_bad_data(gen_key(b"pw", &[7u8; 16], KEYGEN_OPS_DEFAULT, KEYGEN_MEM_DEFAULT)));
        assert!(is_bad_data(gen_key(b"pw", &[7u8; 33], KEYGEN_OPS_DEFAULT, KEYGEN_MEM_DEFAULT)));
        // sealed boxes want 32-byte keys
        let (pk, sk) = asym::keygen().unwrap();
        assert_eq!(pk.len(), 32);
        assert_eq!(sk.len(), 32);
        assert!(is_bad_data(asym::encrypt(&pk[..16], b"x")));
        assert!(is_bad_data(asym::decrypt(&pk[..16], &sk, b"x")));
        assert!(is_bad_data(asym::decrypt(&pk, &sk[..16], b"x")));
        // a well-formed box that doesn't open (wrong keypair) is a failed operation, not bad data
        let sealed = asym::encrypt(&pk, b"secret").unwrap();
        let (other_pk, other_sk) = asym::keygen().unwrap();
        match asym::decrypt(&other_pk, &other_sk, &sealed) {
            Err(CryptoError::OperationFailed(..)) => {},
            other => panic!("opening a box with the wrong keypair should be OperationFailed, got: {:?}", other),
        }
        // ...and the right keypair still opens it
        assert_eq!(asym::decrypt(&pk, &sk, &sealed).unwrap(), b"secret".to_vec());
    }

    fn random_salt_works_body() {
        let salt1 = random_salt().unwrap();
        let salt2 = random_salt().unwrap();
        assert_eq!(salt1.len(), KEYGEN_SALT_LEN);
        assert_eq!(salt2.len(), KEYGEN_SALT_LEN);
        assert!(salt1 != salt2);
    }

    crypto_test!(can_sha256, can_sha256_body);
    crypto_test!(can_sha512, can_sha512_body);
    crypto_test!(can_hmac_256, can_hmac_256_body);
    crypto_test!(random_bytes_works, random_bytes_works_body);
    crypto_test!(random_int_works, random_int_works_body);
    crypto_test!(random_float_works, random_float_works_body);
    crypto_test!(can_generate_keys, can_generate_keys_body);
    crypto_test!(can_encrypt_chacha20poly1305, can_encrypt_chacha20poly1305_body);
    crypto_test!(can_decrypt_chacha20poly1305, can_decrypt_chacha20poly1305_body);
    crypto_test!(auth_failure, auth_failure_body);
    crypto_test!(secure_comparison, secure_comparison_body);
    crypto_test!(asym_crypto, asym_crypto_body);
    crypto_test!(hashes_match_standard_vectors, hashes_match_standard_vectors_body);
    crypto_test!(rejects_bad_inputs, rejects_bad_inputs_body);
    crypto_test!(random_salt_works, random_salt_works_body);
}

