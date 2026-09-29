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
// turtl_core that touches the `libsodium-wrappers` npm package (real
// libsodium, Emscripten-built -- NOT a reimplementation); it exposes a
// small, plain-function surface that src/crypto/low.rs's `wasm_bridge`
// extern block calls into.
//
// wasm-bindgen emits CommonJS glue for both `--target nodejs` builds and
// `wasm-pack test --node` runs, so this file matches that with
// `require`/`module.exports` rather than ESM `import`/`export`.
'use strict';

const sodium = require('libsodium-wrappers');

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
