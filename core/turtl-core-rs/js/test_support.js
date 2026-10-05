// Test-only (compiled into `wasm-pack test --node` builds only, never into a production build).
//
// 1. libsodium reaches turtl_core by injection: the host passes the libsodium.js object to
//    `initWasmCrypto(sodium)` (src/crypto/wasm_sodium.rs). In tests this file plays the host,
//    doing what a real app does with `import sodium from 'libsodium-wrappers-sumo'`.
// 2. `startServer()` is the HTTP server the Api tests talk to on wasm32 (the native equivalent is
//    src/util/mock_server.rs); the routes in src/api.rs's tests must match both.
// 3. `startFlowServer()` is a small stand-in for the Turtl server (accounts, login, sync) for the
//    end-to-end tests in src/flow_tests.rs, which lists its routes; the native equivalent is the
//    `flow_route` function there, and the two must behave identically.
//
// CommonJS, because `wasm-pack test --node` runs the wasm-bindgen glue under Node's CommonJS loader.
'use strict';

const http = require('http');

module.exports.loadSodium = function loadSodium() {
    return require('libsodium-wrappers-sumo');
};

let server = null;

// Starts the test server on an ephemeral localhost port and resolves to the port.
module.exports.startServer = function startServer() {
    return new Promise((resolve) => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                const header = (name) => req.headers[name] || null;
                const send = (status, type, text, delay = 0) => setTimeout(() => {
                    res.writeHead(status, { 'content-type': type });
                    res.end(text);
                }, delay);
                const json = (status, obj, delay) => send(status, 'application/json', JSON.stringify(obj), delay);
                switch (req.url) {
                    case '/hello':
                        return json(200, { hello: 'world', client: header('x-turtl-client'), auth: header('authorization') });
                    case '/echo': {
                        let parsed = null;
                        try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
                        return json(200, {
                            method: req.method,
                            auth: header('authorization'),
                            content_type: header('content-type'),
                            custom: header('x-custom'),
                            body: parsed,
                        });
                    }
                    case '/missing': return json(404, { error: 'nope' });
                    case '/plain-error': return send(500, 'text/plain', 'server on fire');
                    case '/not-json': return send(200, 'text/plain', 'definitely not json');
                    case '/slow': return json(200, { slow: true }, 3000);
                    default: return json(404, { error: 'unknown route' });
                }
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
};

const flowServers = [];

// The stand-in Turtl server's logic (see src/flow_tests.rs for the routes): returns a function
// `(req, res, body) => void` that answers one request. Every call makes a handler with an empty
// account list of its own, so tests can't see each other's state. (js/browser_test.mjs serves the
// same handler next to the static files of the browser tests, to stay on one origin.)
//
// `options.note` (default true) is whether the first sync poll reports the one fake note, n1, that the
// Rust tests look for; the browser tests turn it off, because a note with a made-up body only makes
// the real core log that it can't decrypt it.
function createFlowHandler(options = {}) {
    const withNote = options.note !== false;
    let account = null;
    let polls = 0;
    let fullSync = [];
    const log = [];
    return function handle(req, res, body) {
        const json = (status, obj) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (req.method === 'GET' && req.url === '/requests') {
            return json(200, log);
        }
        log.push(`${req.method} ${req.url}`);
        if (req.method === 'POST' && req.url === '/users') {
            const posted = JSON.parse(body);
            account = { username: posted.username, auth: posted.auth, data: posted.data };
            return json(200, { id: '42', data: posted.data });
        }
        if (req.method === 'POST' && req.url === '/auth') {
            const expected = account && 'Basic ' + Buffer.from(`${account.username}:${account.auth}`).toString('base64');
            if (account && req.headers['authorization'] === expected) {
                return json(200, '42');
            }
            return json(401, { error: 'bad login' });
        }
        if (req.method === 'GET' && req.url === '/users/42' && account) {
            return json(200, Object.assign({}, account.data, { id: '42' }));
        }
        if (req.method === 'PUT' && req.url === '/users/42') {
            const posted = JSON.parse(body);
            account = { username: posted.user.username, auth: posted.auth, data: posted.user };
            return json(200, { sync_ids: [102] });
        }
        if (req.method !== 'GET' && req.url.startsWith('/spaces/')) {
            return json(200, {});
        }
        if (req.method === 'POST' && req.url === '/sync') {
            const records = JSON.parse(body);
            if (records.length > 0) { records[0].sync_ids = [101]; }
            return json(200, { success: records, failures: [], blocked: [] });
        }
        if (req.method === 'POST' && req.url === '/seed') {
            const seed = JSON.parse(body);
            account = seed.account;
            fullSync = seed.full_sync || [];
            return json(200, {});
        }
        if (req.method === 'GET' && req.url === '/sync/full') {
            return json(200, { records: fullSync, sync_id: 7 });
        }
        if (req.method === 'GET' && req.url.startsWith('/sync?')) {
            polls += 1;
            const records = withNote && polls === 1 ? [{
                id: '1001', type: 'note', action: 'add', item_id: 'n1', user_id: 42,
                data: { id: 'n1', space_id: 's1', user_id: 42, board_id: null, body: 'AAYBAAw=' },
            }] : [];
            return json(200, { records: records, sync_id: 9 });
        }
        return json(404, { error: 'unknown route' });
    };
}
module.exports.createFlowHandler = createFlowHandler;

// Starts a fresh stand-in Turtl server on an ephemeral localhost port and resolves to the port.
module.exports.startFlowServer = function startFlowServer() {
    return new Promise((resolve) => {
        const handle = createFlowHandler();
        const flowServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => handle(req, res, body));
        });
        flowServers.push(flowServer);
        flowServer.listen(0, '127.0.0.1', () => resolve(flowServer.address().port));
    });
};

// The interoperability fixtures (src/interop_tests.rs, test-fixtures/): they are only rewritten when
// the run is asked to, with TURTL_WRITE_FIXTURES=1.
module.exports.shouldWriteFixtures = function shouldWriteFixtures() {
    return process.env.TURTL_WRITE_FIXTURES === '1';
};

// (The runner's working directory is the crate's: cargo runs tests from the package root. This file
// itself is copied into a temporary snippets directory, so `__dirname` is no use here.)
module.exports.writeFixture = function writeFixture(name, text) {
    const path = require('path');
    require('fs').writeFileSync(path.join(process.cwd(), 'test-fixtures', name), text);
};

module.exports.stopServer = function stopServer() {
    if (server) { server.close(); server = null; }
    while (flowServers.length > 0) { flowServers.pop().close(); }
};
