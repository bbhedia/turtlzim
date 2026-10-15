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
| Shell script | `src-tauri/shell.js`: `window.__zimShell` = `{ version, saveFile }` (the web app's `web/src/app/shell.ts` recognises Tauri by `window.__TAURI_INTERNALS__` and says `desktop`) |
| Saving a file | a WebView does nothing with a link to a Blob that has `download`: `saveFile` sends the bytes to the command `save_file`, which opens the system's *Save as* dialog and writes the file (export zip, page download, attachment, vault backup all use it) |
| Linux WebKitGTK | built with the web's **storage and file system APIs off** (Ubuntu 26.04's 2.52 at least): no `navigator.storage`, so no OPFS and no vault. `linux_web_features` in `main.rs` switches on `StorageAPI`, `StorageAPIEstimate`, `FileSystem`, `FileSystemWritableStream` and `AccessHandle` (by `webkit_settings_get_all_features`, WebKitGTK 2.42+, found at run time) and reloads the page |
| Content policy | the web server's, in `tauri.conf.json` (plus the program's own channel in `connect-src`); `web/test/desktop-config.test.ts` keeps the two from drifting |
| Permissions | `core:default` only; no remote page may talk to the program; no network is used by the app itself |
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
- **Not run**: the vault itself (creating an encrypted notebook) in the program; the *Save as* dialog; the `.deb`/`.rpm` installed; the AppImage on
  another distribution; **any of it on Windows** (WebView2, the NSIS and MSI installers: the workflow builds them, nobody has run them).

**Where this machine is not typical** (so that the same symptoms are known): its CPU is a 2011 Pentium (no AVX), and Ubuntu's WebKitGTK **web process dies with
SIGILL** as soon as JavaScript is compiled (`JSC_useJIT=false` makes it run, slowly); there is no desktop session, so GTK waits 25 s for a portal unless the
program runs under `dbus-run-session`; and WebKit's sandbox (bubblewrap) cannot start here (`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` for tests only). None of
these is the program's: a current computer has none of them. To see what a page does when it does not start, run the program with
`ZIM_DESKTOP_DEBUG=1`: the page's errors, the content-policy refusals and a short report of what the WebView offers go to the standard error and onto the page
(never by default: a message can name a page).

## Not done

- **A folder that is watched** (a page changed by another program while it is open), and a lock against two programs writing the same page.
- **Signing and updates**: the installers are unsigned (Windows SmartScreen will warn), and there is no updater; a new version is a new installer.
- macOS: the same project builds it (Tauri) on a Mac; not asked for.
