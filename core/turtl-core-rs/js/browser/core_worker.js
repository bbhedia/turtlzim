// A dedicated Worker that hosts the core: the shape docs/wasm-port-plan.md decision 2.4 prescribes
// (the core lives in a Worker so that nothing it does can block the page) and the place OPFS
// persistence needs (its synchronous file handles exist only in dedicated Workers).
//
// It is a module Worker, started with `new Worker(url, { type: 'module' })`, and speaks a small
// protocol with the page (see core_client.js, which is the page's side of it):
//
//   page -> worker   { op: 'boot', config, persistence }   load the core and start it. `persistence`
//                                                            (optional) is { directory } of the OPFS
//                                                            directory to keep the databases in
//                    { op: 'send', message }                 hand the core a message (JSON string)
//                    { op: 'stop' }                          stop the core
//   worker -> page   { type: 'booted' } | { type: 'stopped' }
//                    { type: 'message', channel, message }   everything the core sends
//                    { type: 'error', op, error }
//
// The imports below are what the browser tests' static server maps (/pkg is the production
// `wasm-pack build --target web` package, /vendor serves libsodium.js); an app that bundles its code
// imports `turtl_core` and `libsodium-wrappers-sumo` by name instead. Everything else here is
// exactly what an app has to do, in this order.
import init, {
    initWasmCrypto, enablePersistence, initCore, startCore, stopCore, sendMessage, setMessageHandler,
} from '../../pkg/turtl_core.js';
import sodium from '../../vendor/libsodium-wrappers.mjs';

self.onmessage = async (event) => {
    const request = event.data;
    try {
        switch (request.op) {
            case 'boot':
                await init({ module_or_path: new URL('../../pkg/turtl_core_bg.wasm', import.meta.url) });
                await initWasmCrypto(sodium);
                if (request.persistence) await enablePersistence(request.persistence.directory);
                initCore(JSON.stringify(request.config || {}));
                setMessageHandler((channel, message) => self.postMessage({ type: 'message', channel, message }));
                startCore();
                self.postMessage({ type: 'booted' });
                break;
            case 'send':
                sendMessage(request.message);
                break;
            case 'stop':
                stopCore();
                setMessageHandler(null);
                self.postMessage({ type: 'stopped' });
                break;
            default:
                throw new Error(`unknown op: ${request.op}`);
        }
    } catch (e) {
        self.postMessage({ type: 'error', op: request.op, error: String(e && e.message || e) });
    }
};
