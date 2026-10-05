// Test-only (compiled into `wasm-pack test --node` builds only, never into a production build).
//
// 1. libsodium reaches turtl_core by injection: the host passes the libsodium.js object to
//    `initWasmCrypto(sodium)` (src/crypto/wasm_sodium.rs). In tests this file plays the host,
//    doing what a real app does with `import sodium from 'libsodium-wrappers-sumo'`.
// 2. `startServer()` is the HTTP server the Api tests talk to on wasm32 (the native equivalent is
//    src/util/mock_server.rs); the routes in src/api.rs's tests must match both.
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

module.exports.stopServer = function stopServer() {
    if (server) { server.close(); server = null; }
};
