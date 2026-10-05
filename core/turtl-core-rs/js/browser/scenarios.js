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

/**
 * Join in one Worker, "reload" (stop the core, kill the Worker, start a new one) and log in again:
 * the account lives on the stand-in server, the profile that joining made (three spaces and three
 * boards) only in the Worker's local database. Returns the profile the second run sees.
 */
async function profileAfterReload({ CoreClient, workerUrl, origin }, name, persistence) {
    const config = { api: { endpoint: origin }, logging: { level: 'warn' } };
    const username = `${name}@test.com`;

    let core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    const joined = await core.request('user:join', username, 'reloadpassphrase');
    assertEqual(joined.e, 0, `join: ${JSON.stringify(joined)}`);
    const first = await core.request('sync:start');
    assertEqual(first.e, 0, `sync:start: ${JSON.stringify(first)}`);
    const before = (await core.request('profile:load')).d;
    assertEqual([before.spaces.length, before.boards.length], [3, 3], 'the profile joining made');
    await core.request('sync:shutdown', true);
    await core.stop();
    core.terminate();

    core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    const login = await core.request('user:login', username, 'reloadpassphrase');
    assertEqual(login.e, 0, `login: ${JSON.stringify(login)}`);
    const started = await core.request('sync:start');
    assertEqual(started.e, 0, `sync:start: ${JSON.stringify(started)}`);
    const after = (await core.request('profile:load')).d;
    await core.request('sync:shutdown', true);
    await core.stop();
    core.terminate();
    return { before, after };
}

scenarios.persistence = async (ctx) => {
    const { before, after } = await profileAfterReload(ctx, 'persist', { directory: 'turtl-test' });
    // the same spaces and boards, read back from the database in OPFS
    assertEqual(after.spaces.map((s) => s.id).sort(), before.spaces.map((s) => s.id).sort(), 'spaces survive a reload');
    assertEqual(after.boards.map((b) => b.id).sort(), before.boards.map((b) => b.id).sort(), 'boards survive a reload');
};

// The control for the scenario above: without persistence the reloaded core starts empty, which is
// what shows that the scenario above would notice if persistence did nothing.
scenarios.in_memory_control = async (ctx) => {
    const { after } = await profileAfterReload(ctx, 'control', undefined);
    assertEqual([after.spaces.length, after.boards.length], [0, 0], 'nothing survives a reload in memory');
};

async function assertRejects(promise, pattern, message) {
    try {
        await promise;
    } catch (e) {
        if (!pattern.test(String(e && e.message || e))) {
            throw new Error(`${message || 'rejected'}, but with the wrong error: ${e && e.message || e}`);
        }
        return;
    }
    throw new Error(`${message || 'expected a rejection'}, but it resolved`);
}

// A data folder with nothing to persist into would quietly keep the data in memory: refuse that.
scenarios.data_folder_needs_persistence = async ({ CoreClient, workerUrl, origin }) => {
    const core = new CoreClient(workerUrl);
    await assertRejects(
        core.boot({ api: { endpoint: origin }, data_folder: 'turtl' }),
        /persistence isn't enabled/,
        'booting with a data_folder and no persistence',
    );
    core.terminate();
};

// One worker at a time holds the stored data. A second tab is told so; once the first is gone, the
// data is there for the next.
scenarios.second_tab_is_refused = async ({ CoreClient, workerUrl, origin }) => {
    const config = { api: { endpoint: origin }, logging: { level: 'error' } };
    const persistence = { directory: 'turtl-shared' };
    const first = new CoreClient(workerUrl);
    await first.boot(config, persistence);

    const second = new CoreClient(workerUrl);
    await assertRejects(second.boot(config, persistence), /in use by another tab or worker/, 'a second worker');
    second.terminate();

    await first.stop();
    first.terminate();
    const third = new CoreClient(workerUrl);
    await third.boot(config, persistence);
    assertEqual((await third.request('ping')).d, 'pong', 'the third worker can use the data');
    await third.stop();
    third.terminate();
};

// Wiping a user's data (and then all of the app's) removes the databases from OPFS: a user who logs
// in again afterwards finds an empty profile.
scenarios.wipe = async ({ CoreClient, workerUrl, origin }) => {
    const config = { api: { endpoint: origin }, logging: { level: 'error' } };
    const persistence = { directory: 'turtl-wipe' };
    const username = 'wipe@test.com';
    const spaces = async (core) => {
        assertEqual((await core.request('sync:start')).e, 0, 'sync:start');
        const profile = (await core.request('profile:load')).d;
        await core.request('sync:shutdown', true);
        return profile.spaces.length;
    };

    let core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    assertEqual((await core.request('user:join', username, 'wipepassphrase')).e, 0, 'join');
    assertEqual(await spaces(core), 3, 'the profile joining made');
    // (the wipe waits for the sync system to wind down, which takes a few seconds)
    assertEqual((await core.request('app:wipe-user-data')).e, 0, 'wipe-user-data');
    await core.stop();
    core.terminate();

    core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    assertEqual((await core.request('user:login', username, 'wipepassphrase')).e, 0, 'login after the wipe');
    assertEqual(await spaces(core), 0, 'the wiped profile is gone');
    assertEqual((await core.request('app:wipe-app-data')).e, 0, 'wipe-app-data');
    // the core still works afterwards (it has made itself a fresh kv store)
    assertEqual((await core.request('ping')).d, 'pong', 'ping after wiping everything');
    await core.stop();
    core.terminate();
};

// "Remember me" across a reload: the saved login lives in the kv store, which lives in OPFS, so a new
// Worker can log in with just the user id and the key the page kept.
scenarios.saved_login_survives_reload = async ({ CoreClient, workerUrl, origin }) => {
    const config = { api: { endpoint: origin }, logging: { level: 'error' } };
    const persistence = { directory: 'turtl-saved-login' };

    let core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    assertEqual((await core.request('user:join', 'remember@test.com', 'rememberpassphrase')).e, 0, 'join');
    const saved = await core.request('user:save-login');
    assertEqual(saved.e, 0, `save-login: ${JSON.stringify(saved)}`);
    await core.stop();
    core.terminate();

    core = new CoreClient(workerUrl);
    await core.boot(config, persistence);
    const back = await core.request('user:login-from-saved', saved.d.user_id, saved.d.key);
    assertEqual(back.e, 0, `login-from-saved: ${JSON.stringify(back)}`);
    assertEqual(back.d.username, 'remember@test.com');
    await core.stop();
    core.terminate();
};

// A note's file, in the browser: saved encrypted under the note's key into the database, read back
// decrypted, and uploaded by the file sync loop (fetch, with a binary body, to the stand-in server).
scenarios.attachments = async ({ CoreClient, workerUrl, origin }) => {
    const core = new CoreClient(workerUrl);
    await core.boot({ api: { endpoint: origin }, logging: { level: 'error' } });
    assertEqual((await core.request('user:join', 'files@test.com', 'filespassphrase')).e, 0, 'join');
    const profile = (await core.request('profile:load')).d;

    const bytes = [72, 105, 0, 255, 254, 13, 10, 65, 66, 67, 0, 200, 100, 50];
    const base64 = btoa(String.fromCharCode(...bytes));
    const added = await core.request('profile:sync:model', 'add', 'note', {
        space_id: profile.spaces[0].id, user_id: '0', type: 'file', title: 'with a file',
        file: { name: 'hi.bin', type: 'application/octet-stream', filedata: { data: base64 } },
    });
    assertEqual(added.e, 0, `add: ${JSON.stringify(added)}`);
    const noteId = added.d.id;

    const read = await core.request('profile:note:get-file', noteId);
    assertEqual([read.e, read.d], [0, base64], 'the file reads back');

    assertEqual((await core.request('sync:start')).e, 0, 'sync:start');
    const upload = `PUT /notes/${noteId}/attachment`;
    let uploaded = false;
    for (let i = 0; i < 150 && !uploaded; i++) {
        uploaded = (await (await fetch('/requests')).json()).includes(upload);
        if (!uploaded) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(uploaded, 'the file loop uploaded the file');

    await core.request('sync:shutdown', true);
    await core.stop();
    core.terminate();
};

// The interoperability fixtures (src/interop_tests.rs): an account made by the native build and one
// made by the wasm32 build under Node. Here the production package, in a Worker in a real browser,
// logs in to each, loads the profile from the ciphertext the other build stored and decrypts it.
scenarios.reads_what_other_builds_made = async ({ CoreClient, workerUrl, origin }) => {
    for (const name of ['interop_from_native.json', 'interop_from_wasm.json']) {
        const fixture = await (await fetch(`/test-fixtures/${name}`)).json();
        const expected = fixture.expected;
        const seeded = await fetch('/seed', {
            method: 'POST',
            body: JSON.stringify({
                account: { username: fixture.username, auth: fixture.auth, data: fixture.user },
                full_sync: fixture.sync_records,
            }),
        });
        assertEqual(seeded.status, 200, `seeding ${name}`);

        const core = new CoreClient(workerUrl);
        await core.boot({ api: { endpoint: origin }, logging: { level: 'error' } });
        const login = await core.request('user:login', fixture.username, fixture.passphrase);
        assertEqual(login.e, 0, `${name}: login ${JSON.stringify(login)}`);
        assertEqual((await core.request('sync:start')).e, 0, `${name}: sync:start`);

        const profile = (await core.request('profile:load')).d;
        assertEqual(profile.spaces.map((s) => s.title).sort(), expected.spaces, `${name}: spaces`);
        assertEqual(profile.boards.map((b) => b.title).sort(), expected.boards, `${name}: boards`);

        const notes = await core.request('profile:get-notes', [expected.note.id]);
        assertEqual(notes.e, 0, `${name}: get-notes ${JSON.stringify(notes)}`);
        assertEqual([notes.d[0].title, notes.d[0].text], [expected.note.title, expected.note.text], `${name}: the note`);

        const found = await core.request('profile:find-notes', { space_id: expected.note.space_id, text: 'encrypted' });
        assertEqual(found.e, 0, `${name}: find-notes ${JSON.stringify(found)}`);
        assertEqual(found.d.notes.map((n) => n.id), [expected.note.id], `${name}: search finds the note`);

        await core.request('sync:shutdown', true);
        await core.stop();
        core.terminate();
    }
};

export { assert, assertEqual };
