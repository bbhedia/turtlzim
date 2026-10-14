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

## What verifies it

- `cargo check --target x86_64-pc-windows-msvc` in `desktop/src-tauri`: the Rust compiles against Tauri 2.x.
- `web/test/shell.test.ts` (Tauri is recognised), `desktop-config.test.ts` (version, policy, hooks, command, permissions).
- **Not run yet**: a Linux build (needs the packages above), either installer, the program itself on either system. The things to look at first
  when it runs: that `https://tauri.localhost` (Windows) and `tauri://localhost` (Linux, WebKitGTK) give the vault OPFS and a Worker, that the policy
  lets the app and Tauri's own scripts run, and the *Save as* dialog.

## Not done

- **Open notebooks as real `.txt` folders** (a locked decision): the notebooks are in the WebView's storage, as in a browser. A store on the
  file system (Tauri's fs, a folder chosen by the person, the same Zim layout) is the next milestone of the program.
- **Signing and updates**: the installers are unsigned (Windows SmartScreen will warn), and there is no updater; a new version is a new installer.
- macOS: the same project builds it (Tauri) on a Mac; not asked for.
