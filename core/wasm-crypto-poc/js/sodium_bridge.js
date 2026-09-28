// Standalone JS glue for the wasm-crypto-poc crate.
//
// wasm-bindgen's *inline* JS snippets (`#[wasm_bindgen(inline_js = "...")]`)
// can't contain `import`/`require` statements of their own -- but a
// standalone file referenced via `#[wasm_bindgen(module = "/js/sodium_bridge.js")]`
// can, and wasm-bindgen bundles it into the generated package, generating the
// glue that requires/imports it for us. This file is that bridge: it is the
// only place that touches the `libsodium-wrappers` npm package (real
// libsodium, Emscripten-built -- NOT a reimplementation), and it exposes a
// small, plain-function surface that the Rust side calls into via
// `#[wasm_bindgen] extern "C" { ... }`.
//
// Built with `wasm-pack build --target nodejs`, so wasm-bindgen emits
// CommonJS glue -- this file matches that with `require`/`module.exports`
// rather than ESM `import`/`export` (which is what you'd use instead for a
// `--target web` build).
'use strict';

const sodium = require('libsodium-wrappers');

// sodium.ready is a Promise that resolves once the underlying Emscripten
// wasm module has finished loading -- every sodium.crypto_* call is a no-op
// stub (or throws) until then. The Rust side awaits this (via
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
