// The browser test page: runs the scenarios named in ?scenarios=a,b (default: all) and leaves the
// outcome where js/browser_test.mjs looks for it: window.__results = [{ name, ok, error }] and
// window.__done = true.
import { CoreClient } from './core_client.js';
import { scenarios, assert } from './scenarios.js';

const wanted = new URLSearchParams(location.search).get('scenarios');
const names = wanted ? wanted.split(',') : Object.keys(scenarios);
const ctx = {
    assert,
    CoreClient,
    workerUrl: new URL('./core_worker.js', import.meta.url),
    origin: location.origin,
};

window.__results = [];
for (const name of names) {
    const started = performance.now();
    try {
        if (!scenarios[name]) throw new Error('no such scenario');
        await scenarios[name](ctx);
        window.__results.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (e) {
        window.__results.push({ name, ok: false, error: String(e && e.stack || e) });
    }
}
window.__done = true;
