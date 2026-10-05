// Real-libsodium.js JS glue for turtl_core's wasm32 crypto bridge
// (docs/wasm-port-plan.md decision 2.1).
//
// This is the SAME bridge mechanism already proven byte-exact against native
// `sodiumoxide` in the standalone `core/wasm-crypto-poc` crate (see
// `core/wasm-crypto-poc/js/sodium_bridge.js` -- this file adapts that exact
// pattern, plus a `randomBytes` export for `crypto::low::rand_bytes()`).
//
// wasm-bindgen's *inline* JS snippets (`#[wasm_bindgen(inline_js = "...")]`)
// can't contain `import`/`require` statements of their own -- but a
// standalone file referenced via `#[wasm_bindgen(module = "/js/sodium_bridge.js")]`
// can, and wasm-bindgen bundles it into the generated package, generating the
// glue that requires/imports it for us. This file is the only place in
// turtl_core that touches the `libsodium-wrappers-sumo` npm package (real
// libsodium, Emscripten-built -- NOT a reimplementation); it exposes a
// small, plain-function surface that src/crypto/low.rs's `wasm_bridge`
// extern block calls into.
//
// Why the *sumo* build: native `crypto::gen_key()` is scrypt
// (sodiumoxide 0.0.16's `pwhash` is `crypto_pwhash_scryptsalsa208sha256`), and
// the standard `libsodium-wrappers` has no password hashing at all (neither
// scrypt nor Argon2) and no explicit `crypto_hash_sha512`. Sumo is a strict
// superset with the same API and the same `sodium.ready` init, so the AEAD
// hot path is unchanged and there is still exactly one libsodium instance.
// Every primitive below is the same libsodium C code native links against,
// so byte-identical output is structural, and is proven by running the
// crate's own known-answer tests on both targets (see crypto/mod.rs).
//
// wasm-bindgen emits CommonJS glue for both `--target nodejs` builds and
// `wasm-pack test --node` runs, so this file matches that with
// `require`/`module.exports` rather than ESM `import`/`export`.
'use strict';

const sodium = require('libsodium-wrappers-sumo');

// sodium.ready is a Promise that resolves once the underlying Emscripten
// wasm module has finished loading -- every sodium.crypto_*/randombytes_*
// call is a no-op stub (or throws) until then. The Rust side awaits this
// exactly once (via `crypto::low::init_wasm_crypto()`, which uses
// wasm_bindgen_futures::JsFuture) before its first crypto call.
const readyPromise = sodium.ready;

module.exports.sodiumReady = function sodiumReady() {
    return readyPromise;
};

// Real ChaCha20-Poly1305-IETF AEAD seal, via libsodium-wrappers.
//
// Argument order matches libsodium.js's actual wrapper signature (verified
// against jedisct1/libsodium.js's wrapper/symbols/*.json definitions):
//   crypto_aead_chacha20poly1305_ietf_encrypt(message, additional_data,
//     secret_nonce, public_nonce, key, outputFormat)
// `secret_nonce` (nsec) is part of libsodium's generic AEAD API but unused by
// this particular construction -- always null, same as native sodiumoxide's
// `aead::seal` (which never supplies one either).
module.exports.aeadEncrypt = function aeadEncrypt(key, nonce, ad, plaintext) {
    return sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        plaintext,
        ad,
        null,
        nonce,
        key,
        'uint8array'
    );
};

// Real ChaCha20-Poly1305-IETF AEAD open, via libsodium-wrappers.
//
//   crypto_aead_chacha20poly1305_ietf_decrypt(secret_nonce, ciphertext,
//     additional_data, public_nonce, key, outputFormat)
// Throws on authentication failure -- the `catch` attribute on the Rust
// extern binding turns that into a JS-side `Err(JsValue)`.
module.exports.aeadDecrypt = function aeadDecrypt(key, nonce, ad, ciphertext) {
    return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        ad,
        nonce,
        key,
        'uint8array'
    );
};

// Real CSPRNG bytes, via libsodium-wrappers' randombytes_buf (backs
// crypto::low::rand_bytes() -- nonce/key generation on wasm32).
module.exports.randomBytes = function randomBytes(len) {
    return sodium.randombytes_buf(len, 'uint8array');
};

// ---------------------------------------------------------------------------
// The rest of crypto::low's primitives (hashes, HMAC, key derivation, sealed
// boxes). All inputs/outputs are raw bytes (Uint8Array), exactly like the
// native sodiumoxide calls they mirror: in particular `password` is passed as
// bytes, never re-encoded as text. Length validation (hmac key, scrypt salt,
// box keys) happens on the Rust side so errors match native's `BadData`
// errors; libsodium.js itself would throw a differently-worded Error.
// ---------------------------------------------------------------------------

// crypto_hash_sha256 -- backs crypto::low::sha256().
module.exports.hashSha256 = function hashSha256(data) {
    return sodium.crypto_hash_sha256(data, 'uint8array');
};

// crypto_hash_sha512 -- backs crypto::low::sha512().
module.exports.hashSha512 = function hashSha512(data) {
    return sodium.crypto_hash_sha512(data, 'uint8array');
};

// crypto_auth = HMAC-SHA512-256 (a 32-byte tag; NOT the same as SHA-512/256
// of anything) -- backs crypto::low::hmac(). Same as sodiumoxide's
// `auth::authenticate`. Argument order is (message, key).
module.exports.hmacSha512256 = function hmacSha512256(key, data) {
    return sodium.crypto_auth(data, key, 'uint8array');
};

// scrypt (crypto_pwhash_scryptsalsa208sha256) -- backs crypto::low::gen_key().
// Same function sodiumoxide's `pwhash::derive_key` calls. Argument order is
// (keyLength, password, salt, opsLimit, memLimit). libsodium clamps tiny
// limits upward on both targets, so e.g. ops=2/mem=2048 behaves identically.
module.exports.scryptDeriveKey = function scryptDeriveKey(password, salt, opsLimit, memLimit, outLen) {
    return sodium.crypto_pwhash_scryptsalsa208sha256(
        outLen,
        password,
        salt,
        opsLimit,
        memLimit,
        'uint8array'
    );
};

// crypto_box_keypair -- backs crypto::low::asym::keygen(). Returned as one
// 64-byte array, public key (32) followed by secret key (32), so the Rust side
// needs a single bridge call and a split rather than a JS object.
module.exports.boxKeypair = function boxKeypair() {
    const kp = sodium.crypto_box_keypair('uint8array');
    const out = new Uint8Array(kp.publicKey.length + kp.privateKey.length);
    out.set(kp.publicKey, 0);
    out.set(kp.privateKey, kp.publicKey.length);
    return out;
};

// crypto_box_seal (anonymous sealed box) -- backs crypto::low::asym::encrypt().
// Argument order is (message, publicKey).
module.exports.sealedBoxSeal = function sealedBoxSeal(publicKey, plaintext) {
    return sodium.crypto_box_seal(plaintext, publicKey, 'uint8array');
};

// crypto_box_seal_open -- backs crypto::low::asym::decrypt(). Argument order is
// (ciphertext, publicKey, privateKey). Throws if the box doesn't open (wrong
// keys or tampered data); the Rust `catch` binding turns that into an Err.
module.exports.sealedBoxOpen = function sealedBoxOpen(publicKey, privateKey, ciphertext) {
    return sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey, 'uint8array');
};
