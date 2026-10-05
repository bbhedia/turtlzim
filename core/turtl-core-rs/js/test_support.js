// Test-only (compiled into `wasm-pack test --node` builds only, never into a production build).
//
// libsodium reaches turtl_core by injection: the host passes the libsodium.js object to
// `initWasmCrypto(sodium)` (src/crypto/wasm_sodium.rs). In tests this file plays the host, doing
// what a real app does with `import sodium from 'libsodium-wrappers-sumo'`. CommonJS, because
// `wasm-pack test --node` runs the wasm-bindgen glue under Node's CommonJS loader.
'use strict';

module.exports.loadSodium = function loadSodium() {
    return require('libsodium-wrappers-sumo');
};
