// End-to-end check of the `--target web` build, run under Node (no browser needed):
//
//   cd core/turtl-core-rs
//   wasm-pack build --target web
//   node js/web_smoke_test.mjs
//
// It loads the *production* package exactly the way a web app would, as an ES module with an
// explicit `init()`, and plays the host by injecting libsodium into the core
// (docs/wasm-port-plan.md decision 2.1; src/crypto/wasm_sodium.rs for the contract).
//
// Needs `npm install` in this directory first, for libsodium-wrappers-sumo: in a real app that
// dependency belongs to the app's own package.json, not to the core. Use 0.8.x or later for
// ES-module imports: 0.7.x's `.mjs` entry imports a sibling file that only exists in another
// package, so it cannot be imported as ESM at all (a bundler would need an alias). That quirk is
// the host's to deal with, which is the point of injecting libsodium rather than importing it
// from the core.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import sodium from 'libsodium-wrappers-sumo';
import init, {
    initWasmCrypto, cryptoSelfTest,
    initCore, startCore, stopCore, sendMessage, setMessageHandler, pollMessage, pollEvent,
} from '../pkg/turtl_core.js';
// the stand-in Turtl server the wasm tests use (CommonJS, so this is its module.exports)
import testSupport from './test_support.js';

const pkg = new URL('../pkg/', import.meta.url);

// 1. The package must be self-contained: no JS snippets, and glue that loads no modules at all
//    (the word "libsodium" does appear, in doc comments copied from the Rust docs). That is the
//    point of injection: nothing here can break under a bundler, and the dependency is the host's.
assert.ok(!existsSync(new URL('snippets', pkg)), 'the production package must contain no JS snippets');
for (const file of readdirSync(pkg).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(new URL(file, pkg), 'utf8');
    assert.ok(!/^\s*import\s|\brequire\(|\bimport\(/m.test(text), `${file} must not import or require anything`);
}

// 2. Load the core's wasm. A browser would let init() fetch() it by URL; Node takes the bytes.
await init({ module_or_path: readFileSync(new URL('turtl_core_bg.wasm', pkg)) });

// 3. Crypto before injection fails with a clear message, never silently.
assert.throws(() => cryptoSelfTest(), /not been injected yet/);

// 4. Injection refuses anything that isn't a usable libsodium, naming the problem.
await assert.rejects(() => initWasmCrypto(undefined), /expected the libsodium\.js object/);
await assert.rejects(
    () => initWasmCrypto({ ready: Promise.resolve() }),
    /crypto_pwhash_scryptsalsa208sha256.*sumo/,
);

// 5. The real thing initialises (init waits for sodium.ready itself) and passes the known-answer
//    self-test: SHA, HMAC, RFC 8439 AEAD, scrypt, a sealed box made by the original JS client.
await initWasmCrypto(sodium);
const report = cryptoSelfTest();
assert.match(report, /^crypto self-test passed against libsodium \d+\.\d+\.\d+/);

// 6. A failed init must leave the working libsodium in place...
await assert.rejects(() => initWasmCrypto({ ready: Promise.resolve() }), /sumo/);
assert.match(cryptoSelfTest(), /passed/);

// 7. ...and initialising again with a good object is harmless.
await initWasmCrypto(sodium);
assert.match(cryptoSelfTest(), /passed/);

// 8. The host API (src/wasm_host.rs): run the core as a service, the way a web app would, with the
//    stand-in server playing the Turtl API. Nothing here is available before libsodium is injected
//    and the core configured and started.
assert.throws(() => sendMessage('["x","ping"]'), /isn't started/);
const port = await testSupport.startFlowServer();
initCore(JSON.stringify({ api: { endpoint: `http://127.0.0.1:${port}` }, logging: { level: 'error' } }));
const received = [];
setMessageHandler((channel, message) => received.push({ channel, message }));
startCore();
assert.throws(() => startCore(), /already started/);

const waitFor = async (what, predicate) => {
    for (let i = 0; i < 1000; i++) {
        const found = received.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`the core never sent ${what}; it sent ${JSON.stringify(received)}`);
};

await waitFor('its ready event', (m) => m.channel === 'inproc://turtl-events' && m.message === '{"e":"messaging:ready","d":true}');

// a message in, its answer out, in the JSON every platform uses
sendMessage(JSON.stringify(['s1', 'ping']));
const pong = await waitFor('the answer to s1', (m) => m.message.includes('"id":"s1"'));
assert.equal(pong.channel, 'inproc://turtl-req-core-out');
assert.equal(pong.message, '{"id":"s1","e":0,"d":"pong"}');

// joining goes through crypto, the API (fetch, to the stand-in server) and storage
sendMessage(JSON.stringify(['s2', 'user:join', 'smoke@test.com', 'smokepassphrase']));
const joined = JSON.parse((await waitFor('the answer to s2', (m) => m.message.includes('"id":"s2"'))).message);
assert.equal(joined.e, 0, JSON.stringify(joined));
assert.equal(joined.d.username, 'smoke@test.com');

// without a handler the same messages wait for the poll functions
setMessageHandler(null);
sendMessage(JSON.stringify(['s3', 'ping']));
let polled;
for (let i = 0; i < 1000 && polled === undefined; i++) {
    polled = pollMessage();
    if (polled === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(polled, '{"id":"s3","e":0,"d":"pong"}');
assert.equal(pollEvent(), '{"e":"pong","d":null}');

stopCore();
assert.throws(() => sendMessage('["s4","ping"]'), /isn't started/);
testSupport.stopServer();

console.log(report);
console.log('web smoke test OK');
