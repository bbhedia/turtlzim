# The desktop program (Windows and Linux)

The web app (`web/`) as an installed program: a Tauri 2 project in `desktop/` that carries `web/dist` unchanged and shows it in the
system's WebView (WebView2 on Windows, WebKitGTK on Linux). There is **one app**: a new version of the web app is a new `web/dist`, and
the program is that build packed again. No second branch, no second UI.

## Decision: Tauri, not a GTK or Qt interface

- A GTK or Qt interface would mean writing the editor a second time (CodeMirror 6 is the largest piece of the project, CLAUDE.md risk 7: the
  document is the text of the Zim file, with live formatting, tables as a grid, pictures, link completion, one undo per action), once per
  toolkit, and keeping it identical byte for byte to the web one. The same reasoning as for Flutter on phones (`zim-mobile-shell.md`).
- Tauri is the shell that CLAUDE.md names. Its Rust host is a few dozen lines (`desktop/src-tauri/src/main.rs`); GTK is in it only as
  the window of the Linux program, under the web page. Electron would carry its own Chromium (150 MB a program) for the same result.
- The program is **not** Qt/GTK-looking: the whole window is the web app, which is also what it is in a browser and on a phone.

## What the program is

| | |
|---|---|
| Project | `desktop/` (Tauri 2). Its Rust crate is its own workspace, so the toolkit never enters the core's crates (which build for wasm and for tests without it) |
| Web files | `web/dist`, as built (`frontendDist`); the version is `web/package.json`'s (`"version": "../../web/package.json"`) |
| Window | made in `main.rs`: https scheme (`https://tauri.localhost`, a secure context as on Android, which the vault needs), with the shell's script as an initialization script |
| Shell script | `src-tauri/shell.js`: `window.__zimShell` = `{ version, folders, saveFile, account }` (the web app's `web/src/app/shell.ts` recognises Tauri by `window.__TAURI_INTERNALS__` and says `desktop`) |
| Saving a file | a WebView does nothing with a link to a Blob that has `download`: `saveFile` sends the bytes to the command `save_file`, which opens the system's *Save as* dialog and writes the file (export zip, page download, attachment, vault backup all use it) |
| Linux WebKitGTK | built with the web's **storage and file system APIs off** (Ubuntu 26.04's 2.52 at least): no `navigator.storage`, so no OPFS and no vault. `linux_web_features` in `main.rs` switches on `StorageAPI`, `StorageAPIEstimate`, `FileSystem`, `FileSystemWritableStream` and `AccessHandle` (by `webkit_settings_get_all_features`, WebKitGTK 2.42+, found at run time) and reloads the page |
| Content policy | the web server's, in `tauri.conf.json` (plus the program's own channel in `connect-src`); `web/test/desktop-config.test.ts` keeps the two from drifting |
| Permissions | `core:default` only; no remote page may talk to the program. The page itself uses no network (its content policy allows none beyond the program's own channel); the program's commands make the requests to an account server, and only then (below) |
| Not in the program | no service worker (the code is the program, changed by installing another), no "Install the app" |

## The installers

`cd desktop && npm install && npm run package` (add `-- --web` to build `../web` first) makes, in `desktop/out/` with a `SHA256SUMS`:

| System | Files | Notes |
|---|---|---|
| Linux | `.deb`, `.rpm`, `.AppImage` | the packages depend on `libwebkit2gtk-4.1` (Ubuntu 22.04+, Debian 12+, Fedora 38+); the AppImage runs without installing (it takes the system's WebKitGTK) |
| Windows | `-setup.exe` (NSIS, per user, English and French) and `.msi` | the installer fetches WebView2 if the PC has none (Windows 11 has it) |

**Every change of the web app → new installers**: `.github/workflows/desktop.yml` builds the web app once (wasm of the core, typecheck,
`npm run build`, unit tests, `pwa:check`), keeps `web/dist`, and packs that same `web/dist` on a Linux and a Windows runner. It runs on every push
to master that touches `web/`, `core/` or `desktop/`, by hand, and on a tag `v*`, which also makes a draft release with the installers.

## Building here (Linux, no root)

The Linux program needs the development files of WebKitGTK, which this machine does not have and cannot get without root:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev patchelf file
```

After that, `npm run package -- --web` here builds the `.deb`, `.rpm` and `.AppImage`. Windows installers are built by the workflow (a Windows
runner); cross-building them from Linux (cargo-xwin and NSIS) is possible and has not been tried.

## Notebooks as folders of Zim files

In the program a notebook is a **real folder**: pages are `Name.txt` (`Projects:Garden` is `Projects/Garden.txt`), the folder named like a page holds its
attachments, and `notebook.zim` marks the folder as a notebook, so Zim opens it as it is, and git, grep and any editor read it. The program's
notebook menu has **Open a folder as a notebook…** (a folder of Zim files, or just of `.txt` files, is taken as it is: nothing is written until a page is
saved, and what is not a page or an attachment, or is hidden, or is not valid UTF-8, is left alone) and **New notebook…**, which in the program is a folder
by default (the system's folder dialog; refused if a file of the same name is already there). **Remove notebook** only stops listing it. The browser
app is as it was: notebooks kept in the browser, and zip and folder import and export.

| | |
|---|---|
| The store | `web/src/notebook/folder-store.ts`: a `NotebookStore` over `window.__zimShell.folders`, routed by id (`folder:`) with the open and the encrypted ones |
| The program's side | `desktop/src-tauri/src/folders.rs` (nothing of Tauri in it) and the commands `fs_roots`, `fs_pick`, `fs_forget`, `fs_list`, `fs_read`, `fs_stage`, `fs_commit` |
| What the page can name | a folder by the **id** that the program gave it when the person chose it (kept in `folders.json` in the app's data folder), and a path inside it: relative, `/`, no `.` or `..`, nothing hidden, no link on the way (a link in a notebook folder is not followed, listed or written through) |
| A change | all of it or none: the new files are staged beside the notebook (`.zim-txn/`), every file that is replaced, moved or deleted is put aside, the new state is put in place, and only then is what was put aside let go; a journal says what to put back, so a change cut off by a crash is undone the next time the folder is listed. The folders that a move or a delete leaves empty go |
| What is kept | a page is written to the file it has, spelled as that file is (Zim's own `My Note.txt`), with its byte-order mark and line endings, and with the time that the page says it was changed; a page with a new name, or spelled another way (only the case can differ), goes where its name says and its old file goes |

What it does **not** do: it does not watch the folder (what another program changes is seen the next time the notebook is opened), it does not lock a page
against two programs (the last write wins), it reads the whole notebook when it is opened, and encrypted notebooks stay in the vault, not in folders. The
Android shell has no folders yet (the same hooks, over the Storage Access Framework, are the way).

## An account on a server (E17)

The program can be connected to an account on an account server (`docs/zim-server.md`, *Apps signed in*), to keep notebooks in step with other devices. The page's
content policy is **unchanged** (it allows no network beyond the program's own channel: `connect-src 'self' ipc: http://ipc.localhost`), so **the program makes the
requests**, not the WebView, and the person signs in in **their own browser**: the program never sees the password.

| | |
|---|---|
| The page's side | `web/src/account/native.ts` (address, PKCE, the flow, a `fetch` for the account client that goes through the shell), `native-ui.ts` (the dialogs), `app-request.ts`; `shell.js` sets `window.__zimShell.account = { defaultServer, request, signIn, secrets }` over the commands below |
| Requests | `account_request` (`src-tauri/src/account.rs`, `reqwest` with the system's own trust: OpenSSL on Linux, SChannel on Windows): an `https` address, or `http` to this computer's own address (a server being tried out), with an `/api/` path (the path that is left once the address is parsed: a dot segment, `%2e%2e` too, is resolved first) and no name or password in it; of the page's headers only `authorization`, `content-type`, `x-requested-with` and `accept` go on (no cookie, no origin); **no redirect is followed** (the token is for the server that was typed); the system's proxy settings, never for this computer's own address; 16 MiB out and 32 MiB in at most. A server whose certificate this computer does not trust is refused, and the dialog says so with the system's reason (*The server's certificate is not one that this computer trusts (self-signed certificate in certificate chain)*); the other failures people meet are told as what to check (the server does not answer, its name was not found, it took too long) |
| Signing in | `account_sign_in_begin` opens a port of `127.0.0.1` (the system chooses it) for the state that the page made, and the return address is `http://127.0.0.1:<port>/callback`; `account_sign_in_wait` opens the person's browser (`open`: `xdg-open` on Linux, the shell's handler on Windows; the address is checked first: https, or this computer's) at the server's page and waits up to **five minutes for one answer**: a GET of `/callback` whose Host is `127.0.0.1:<port>` (a web page can't make a browser ask this port by a name that it controls) and whose state is the one that was given. Anything else is answered (400, 404, 405) and **does not end the wait**; a connection that says nothing for five seconds, or sends more than 8 KiB of head, is dropped without holding up the others (a browser opens connections in advance). When the answer comes the port is closed and the page it was given says that the person can go back, and takes the code out of the address bar. `account_sign_in_cancel` ends it at once; beginning another ends the first. `src-tauri/src/signin.rs` |
| The token | `account_secret_*` (`src-tauri/src/secrets.rs`): the system's keychain (Credential Manager on Windows; the Secret Service on Linux: GNOME Keyring, KWallet), and, **where there is none**, a file `secret-account-token` in the program's data folder, mode 600, written beside and renamed; one copy (a keychain that works takes the file away; a keychain that was down while the file was written is read again when it is back); never in the page's storage, and a name is letters, digits and dashes only (not a path) |
| A suggested address | `ZIM_ACCOUNT_SERVER` in the program's environment (a computer set up for a team, a test) is the address that the connect dialog starts with; nothing is asked of it until the person confirms |
| A notebook in a folder | kept on the server like the others (*Keep this notebook on the server…*, E17d): the folder stays the working copy; the server gets its files **byte for byte** (a page is read and written as its file is); what comes from the server is written into the folder by the same all-or-nothing change as any write (`fs_commit`), and `notebook.zim` is edited key by key, so what Zim put there stays. Another device opens the copy as a notebook of its own, in the browser's storage |
| What the app can't do | what a browser must do: change the password, download the data, delete the account, sign out the other apps, and connect a service that needs its own window (Dropbox, Google Drive: the dialog says to do it in the web app, and lists it once connected) |

**Not decided here**: a server with a **self-signed certificate** is refused (the program trusts what the system trusts, and a private authority can be added to the system's list: on Linux
with `SSL_CERT_FILE`, or the distribution's store; on Windows, the certificate store). Pinning a certificate that the person confirms would be a convenience, with its own risks
(a custom check at the handshake, which `native-tls` does not give: it needs `rustls`); it is not built.

## What verifies it

- `cargo check --target x86_64-pc-windows-msvc` in `desktop/src-tauri`: the Rust compiles against Tauri 2.x for Windows.
- `web/test/shell.test.ts` (Tauri is recognised), `desktop-config.test.ts` (version, policy, hooks, commands, permissions, the WebKit features).
- **Linux, built and run here** (2026-10-14: `.deb` 2.9 MB, `.rpm` 2.9 MB, `.AppImage` 85 MB; the program run on a virtual display, Xvfb, under a D-Bus session):
  the sample notebook opens (tree, page, contents, calendar), IndexedDB works, `tauri://localhost` is a secure context, Worker, WebAssembly and
  `crypto.subtle` are there, and, with the features above on, `navigator.storage.getDirectory()` opens the OPFS root (without them it was undefined, and
  `MiniBrowser`, WebKitGTK's own, showed the same on `http://127.0.0.1`: it is the build, not the custom scheme).
- **Folders**: `cargo test` in `desktop/src-tauri` (13 tests: paths, links, listing, a change that writes, moves, swaps and deletes, one that fails half way, one
  cut off by a crash, the registry; 12 mutants of the module, all caught but one that is equivalent), the store contract run over a file system in memory (13 tests) and
  11 more about folders (`web/test/store.test.ts`), a browser scenario with a stand-in file system in the page, and **a run of the program on Linux**: the folder dialog of
  GTK chose a folder of Zim files, the notebook opened with its name from `notebook.zim` and its tree, text typed was saved into `Start.txt` with the header lines as
  they were and nothing else touched, and a new notebook in an empty folder made `notebook.zim` and `Home.txt` as Zim writes them.
- **The account** (E17): `cargo test` in `desktop/src-tauri` (33 tests, 20 of them for the account: the addresses that may be asked and the browser's, the headers that go on and the
  ones that don't, every kind of request, the status and headers given back, no redirect followed, an answer that is too big, a server that is not there, a certificate told as such and
  the other failures as what to check, no proxy for this computer; the return port: what it answers and does not take for the answer, a connection that says nothing, a head that
  is too long, cancelling, time running out, another sign-in beginning, beginning with a state that can't be one, loopback only; the token: keychain, file, one copy, mode 600, names that
  are not paths; **28 mutants of those three modules, all caught**), plus one test by hand against a real https server (below); `web/test/native-account.test.ts` (18 tests of the page's
  side; 40 mutants of the page's code, all caught but one that was equivalent, a check that the next line made again, which was removed), `desktop-config.test.ts` (every command that is written is listed, the page's policy is still closed, every placeholder of `shell.js` is filled in), and
  five browser scenarios (Chromium and WebKit) with a **stand-in program** (the hooks over Node: requests, a port, the keychain, "the browser" as a second browser context) against the
  real server: sign-in through the browser, the token outside the page's storage, every request through the shell, a notebook kept on the server, the app signed out from the browser's list
  and by itself, no, cancel and Escape, requests that are not valid, a request kept while signing in with a service, an Android request's link, and an encrypted notebook kept sealed
  (the program's requests and the server's files are searched for its text and title).
  **A run of the program on Linux** (2026-10-19, the debug build on Xvfb under `dbus-run-session`, WebKitGTK; the real account server on `127.0.0.1`, plain http; `xdg-open` replaced
  by a script that opens Playwright's Chromium, which signs in and presses *Allow*; `xdotool` for the clicks in the program): the connect dialog started with the suggested address
  (`ZIM_ACCOUNT_SERVER`), the browser was opened at the server's page, the program's port answered *Allowed* once, the program was connected (menu, *synced* badge), the sample notebook was kept on
  the server with the token (its files are in the server's database), and *Sign out of this app* removed the token file and the server's session. The token had been kept in
  `secret-account-token`, mode 600, 43 bytes (no Secret Service runs here, so this was the file). And **by hand against a real https server** (the web server with its own authority, on
  another port): without trusting its authority the request is refused with *The server's certificate is not one that this computer trusts (self-signed certificate in certificate chain)*;
  with `SSL_CERT_FILE` naming the authority it is answered (`ZIM_TLS_URL=… cargo test --bin zim-notebook-desktop certificate_that_the_system -- --ignored --nocapture`).
- **Not run**: the vault itself (creating an encrypted notebook) in the program; the *Save as* dialog; the `.deb`/`.rpm` installed; the AppImage on
  another distribution; **any of it on Windows** (WebView2, the NSIS and MSI installers: the workflow builds them, nobody has run them; the Rust compiles for Windows,
  `cargo check --target x86_64-pc-windows-msvc`); for the account in particular **the Secret Service** (GNOME Keyring, KWallet: only the file was used), **the Credential Manager** and SChannel, a
  certificate from a real authority, a proxy, and the system's own default browser (a stand-in was started instead).

**Where this machine is not typical** (so that the same symptoms are known): its CPU is a 2011 Pentium (no AVX), and Ubuntu's WebKitGTK **web process dies with
SIGILL** as soon as JavaScript is compiled (`JSC_useJIT=false` makes it run, slowly); there is no desktop session, so GTK waits 25 s for a portal unless the
program runs under `dbus-run-session`; and WebKit's sandbox (bubblewrap) cannot start here (`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` for tests only). None of
these is the program's: a current computer has none of them. To see what a page does when it does not start, run the program with
`ZIM_DESKTOP_DEBUG=1`: the page's errors, the content-policy refusals and a short report of what the WebView offers go to the standard error and onto the page
(never by default: a message can name a page).

## Not done

- **A folder that is watched** (a page changed by another program while it is open), and a lock against two programs writing the same page.
- **A server with a certificate of its own** (a self-signed one): refused until its authority is among the system's (see *An account on a server*); there is no pinning.
- **Signing and updates**: the installers are unsigned (Windows SmartScreen will warn), and there is no updater; a new version is a new installer.
- macOS: the same project builds it (Tauri) on a Mac; not asked for.
