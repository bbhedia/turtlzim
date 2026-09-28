//! Proof-of-concept: reproduce `turtl_core`'s exact ciphertext envelope
//! format in a `wasm32-unknown-unknown` build, using REAL libsodium (via the
//! `libsodium-wrappers` npm package, loaded through a wasm-bindgen JS
//! bridge) -- not a reimplementation of the AEAD primitive.
//!
//! This crate is deliberately standalone (see docs/wasm-port-plan.md, step
//! 2): it does not attempt to compile any of `turtl_core` itself for wasm.
//! It only reproduces the one hand-rolled piece of framing that sits on top
//! of libsodium's `chacha20poly1305_ietf` AEAD -- the versioned binary
//! envelope built/parsed in `core/turtl-core-rs/src/crypto/mod.rs`
//! (`serialize_header`/`serialize`/`deserialize`/`encrypt`/`decrypt`) -- and
//! feeds the *entire header* to the AEAD as additional-authenticated-data,
//! exactly as that native code does.
//!
//! Envelope layout (see `crypto::mod::deserialize` in the native crate):
//!
//! ```text
//! |-2 bytes-| |-1 byte----| |-N bytes-----------| |-1 byte-----| |-N bytes-| |-N bytes--|
//! | version | |desc length| |payload description| |nonce length| |  nonce  | |ciphertext|
//! ```
//!
//! - `version` (big-endian u16): `CRYPTO_VERSION` in the native crate, `6` as
//!   of this writing.
//! - `desc length` / `payload description`: in the native crate,
//!   `PayloadDescription` is currently always exactly 1 byte -- an index
//!   into `SYM_ALGORITHM`, which has exactly one entry
//!   (`"chacha20poly1305"`, index `0`). This PoC only reproduces that one
//!   entry/algorithm (the only one the native "encrypt/decrypt a note" hot
//!   path ever produces).
//! - `nonce length` / `nonce`: the AEAD nonce, `chacha20poly1305_ietf`'s
//!   standard 12 bytes.
//! - `ciphertext`: libsodium's `seal()`/`crypto_aead_*_encrypt` output
//!   (ciphertext with the 16-byte Poly1305 tag appended).
//!
//! The header -- everything up to and including the nonce, i.e. everything
//! except the ciphertext -- is the AEAD's additional-authenticated-data on
//! both seal and open. This is the one non-standard part versus "just call
//! libsodium": get this AAD construction wrong and the ciphertext bytes
//! simply won't match native output, even though decryption might still
//! (coincidentally) succeed against your own output.

use wasm_bindgen::prelude::*;

/// The JS bridge. wasm-bindgen JS snippets given inline can't contain
/// `import`/`require` statements of their own, so the actual
/// `libsodium-wrappers` dependency lives in a standalone glue file
/// (`js/sodium_bridge.js`) referenced here by path -- wasm-bindgen bundles
/// it into the generated package and wires up the `require`/`import` for us.
mod bridge {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(module = "/js/sodium_bridge.js")]
    extern "C" {
        /// Resolves once libsodium-wrappers' underlying wasm module has
        /// finished loading. Must be awaited before any crypto_* call.
        #[wasm_bindgen(js_name = sodiumReady)]
        pub fn sodium_ready() -> js_sys::Promise;

        /// Real chacha20poly1305_ietf AEAD seal via libsodium-wrappers.
        #[wasm_bindgen(js_name = aeadEncrypt, catch)]
        pub fn aead_encrypt(key: &[u8], nonce: &[u8], ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue>;

        /// Real chacha20poly1305_ietf AEAD open via libsodium-wrappers.
        #[wasm_bindgen(js_name = aeadDecrypt, catch)]
        pub fn aead_decrypt(key: &[u8], nonce: &[u8], ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue>;
    }
}

/// `turtl_core::crypto::CRYPTO_VERSION` as of this writing. This PoC only
/// targets the current envelope version (matching what native `encrypt()`
/// actually produces) -- decrypt-side multi-version support is out of scope
/// for this proof of concept.
const CRYPTO_VERSION: u16 = 6;

/// Index of `"chacha20poly1305"` in `turtl_core::crypto::SYM_ALGORITHM`
/// (that array's only entry).
const ALGORITHM_INDEX: u8 = 0;

/// Build the envelope header -- everything except the ciphertext -- exactly
/// as `turtl_core::crypto::serialize_header` does:
/// `[version_hi][version_lo][desc_len=1][desc=algorithm_index][nonce_len][nonce...]`.
fn build_header(nonce: &[u8]) -> Vec<u8> {
    let mut header = Vec::with_capacity(2 + 1 + 1 + 1 + nonce.len());
    header.push((CRYPTO_VERSION >> 8) as u8);
    header.push((CRYPTO_VERSION & 0xFF) as u8);
    header.push(1u8); // desc length -- PayloadDescription is always 1 byte
    header.push(ALGORITHM_INDEX);
    header.push(nonce.len() as u8);
    header.extend_from_slice(nonce);
    header
}

struct ParsedEnvelope {
    /// Everything up to and including the nonce -- the AEAD's AAD.
    header: Vec<u8>,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

/// Parse an envelope exactly as `turtl_core::crypto::deserialize` does,
/// returning the header (AAD), nonce, and ciphertext separately.
fn parse_envelope(envelope: &[u8]) -> Result<ParsedEnvelope, JsValue> {
    if envelope.len() <= 2 {
        return Err(JsValue::from_str("wasm_decrypt: envelope too short (version)"));
    }
    let mut idx: usize = 2;

    if envelope.len() <= idx {
        return Err(JsValue::from_str("wasm_decrypt: envelope too short (desc length)"));
    }
    let desc_len = envelope[idx] as usize;
    idx += 1;
    if envelope.len() <= idx + desc_len {
        return Err(JsValue::from_str("wasm_decrypt: envelope too short (desc)"));
    }
    let desc = &envelope[idx..idx + desc_len];
    idx += desc_len;
    if desc.is_empty() || desc[0] != ALGORITHM_INDEX {
        return Err(JsValue::from_str("wasm_decrypt: unsupported algorithm in envelope (only chacha20poly1305 / index 0 is implemented)"));
    }

    if envelope.len() <= idx {
        return Err(JsValue::from_str("wasm_decrypt: envelope too short (nonce length)"));
    }
    let nonce_len = envelope[idx] as usize;
    idx += 1;
    let nonce_end = idx + nonce_len;
    if nonce_end >= envelope.len() {
        return Err(JsValue::from_str("wasm_decrypt: malformed envelope (nonce/ciphertext)"));
    }
    let nonce = envelope[idx..nonce_end].to_vec();
    let ciphertext = envelope[nonce_end..].to_vec();
    let header = envelope[0..nonce_end].to_vec();

    Ok(ParsedEnvelope { header, nonce, ciphertext })
}

/// Encrypt `plaintext` under `key` using the GIVEN `nonce` (not a randomly
/// generated one -- for parity testing against native golden vectors, the
/// nonce that native `encrypt()` happened to pick at random is extracted
/// from its output envelope and fed in here), producing the exact same
/// envelope byte layout as `turtl_core::crypto::encrypt`.
///
/// `key` must be 32 bytes, `nonce` must be 12 bytes
/// (chacha20poly1305_ietf's KEYBYTES/NONCEBYTES) -- libsodium itself
/// enforces this and the JS bridge will throw (surfaced here as `Err`) if
/// violated.
#[wasm_bindgen]
pub async fn wasm_encrypt(key: Vec<u8>, nonce: Vec<u8>, plaintext: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    wasm_bindgen_futures::JsFuture::from(bridge::sodium_ready()).await?;

    let header = build_header(&nonce);
    let ciphertext = bridge::aead_encrypt(&key, &nonce, &header, &plaintext)?;

    let mut envelope = header;
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

/// Parse `envelope` (as produced by either native `turtl_core::crypto::encrypt`
/// or this crate's own `wasm_encrypt`), and decrypt it under `key`, using the
/// envelope's own header bytes as the AEAD's additional-authenticated-data
/// -- exactly as `turtl_core::crypto::decrypt` does. Returns the plaintext,
/// or rejects/throws on a malformed envelope or an authentication failure.
#[wasm_bindgen]
pub async fn wasm_decrypt(key: Vec<u8>, envelope: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    wasm_bindgen_futures::JsFuture::from(bridge::sodium_ready()).await?;

    let parsed = parse_envelope(&envelope)?;
    let plaintext = bridge::aead_decrypt(&key, &parsed.nonce, &parsed.header, &parsed.ciphertext)?;
    Ok(plaintext)
}
