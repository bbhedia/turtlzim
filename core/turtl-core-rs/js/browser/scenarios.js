// What the browser tests check, run on the page by page.js against a CoreClient. Each scenario is
// `async (ctx) => {}` and fails by throwing; ctx has `assert`, `CoreClient`, `workerUrl` and
// `origin` (the page's origin, where the static files and the stand-in Turtl API are both served).

function assert(condition, message) {
    if (!condition) throw new Error(`assertion failed: ${message || ''}`);
}

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export const scenarios = {
    // The production package, in a real dedicated Worker: wasm and libsodium.js loaded by the
    // browser, the core configured and started, and a user flow through crypto, fetch and storage.
    async basics({ CoreClient, workerUrl, origin }) {
        const core = new CoreClient(workerUrl);
        await core.boot({ api: { endpoint: origin }, logging: { level: 'warn' } });
        await core.waitForEvent((event) => event.e === 'messaging:ready');

        assertEqual((await core.request('ping')).d, 'pong', 'ping');

        const joined = await core.request('user:join', 'Browser@Test.com', 'browserpassphrase');
        assertEqual(joined.e, 0, `join: ${JSON.stringify(joined)}`);
        assertEqual(joined.d.username, 'browser@test.com');
        await core.waitForEvent((event) => event.e === 'user:login');

        assertEqual((await core.request('user:logout')).e, 0, 'logout');
        const refused = await core.request('user:login', 'browser@test.com', 'wrong passphrase');
        assertEqual([refused.e, refused.d.type, refused.d.subtype], [1, 'api', 'Unauthorized'], 'bad login');
        const loggedIn = await core.request('user:login', 'browser@test.com', 'browserpassphrase');
        assertEqual(loggedIn.e, 0, `login: ${JSON.stringify(loggedIn)}`);
        assert(loggedIn.d.pubkey, 'the user record came back');

        const profile = await core.request('profile:load');
        assertEqual(profile.e, 0, 'profile:load');

        await core.stop();
        core.terminate();
    },
};

export { assert, assertEqual };
