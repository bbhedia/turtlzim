# The app on the device (`web/pwa`, `web/src/pwa`, `web/scripts/pwa.mjs`)

The web app can be **installed** and **saved on the device** by a service worker: after the first visit it
starts with no network at all (the open notebooks and the encrypted ones live on the device anyway), and the
code it runs is kept as it was installed until a new version is approved. This is the "installed PWA" of
CLAUDE.md, Open issue 6. It is **not** a proof against a hostile host: what it does and does not do is said
plainly in the second half of this page.

## What a person sees

* The browser offers to **install the app** (a window of its own, an icon on the home screen), and the
  notebook menu says **Install the app…** when it does. The manifest and icons are in `web/public/`.
* The first time, the status line says that the app is **saved on this device: it works without the network**.
* **About this version…** (notebook menu) shows the version, whether the app is saved, and a way to look for
  a new one. The version is a 16-digit fingerprint of every file of the app and of the code of the worker.
* **A new version is offered, never put under a page that is running.** When the browser finds one on the
  server, it is installed in the background and a banner says that it is ready (*Update…*, *Not now*, and an
  item in the notebook menu). The question lists the files that differ. Saying yes starts the app again on the
  new version: what was typed is saved first (and the person is asked if it can't be), and an unlocked
  encrypted notebook is locked, as any restart does. Other tabs of the app start again by themselves.
* A page on a plain `http://` address other than `localhost` is not a secure context, so the browser offers
  no service worker there: the app works as it did, says why in *About this version*, and is not saved.

## How it works

```
 vite build ──► dist/  (index.html, assets/*, manifest, icons)
                  │
   vite plugin ───┴─► dist/sw.js = web/pwa/sw.js with the list of every file written in:
                      { id, files: [{ url, size, sha256 }] }        (scripts/pwa.mjs)
```

* **The list.** `web/pwa/sw.js` is a plain JavaScript file (type-checked as a worker by `tsc -p pwa`, not
  compiled: what is read is what runs). The build writes the list of every file of the app, with its size and
  SHA-256, into the one place that has a marker for it. The **version id** is a fingerprint of that list and
  of the worker's own code, so a change to either is a new version.
* **Installing.** The worker downloads each file from the server (not from the browser's own HTTP cache),
  compares its size and SHA-256 with the list, and keeps it in a cache of its own, `zim-web-v-<id>`. If one
  file is not the listed one, the install fails, nothing of that version is kept, and what was there goes on.
* **The approved version.** One record, `zim-web-approved` in the cache `zim-web-state`, says which version
  the app runs. The first version is trusted as it comes (**trust on first use**). After that only an
  approval changes it.
* **Answering.** Every request for a file of the approved version is answered from its cache. The browser may
  clear a cache when the disk is short of room: then the file is fetched again, and served **only if it is the
  listed one**; if not, nothing is served (a plain page says the files could not be checked) rather than
  something unchecked. A request for anything else goes to the network as if there were no worker.
* **A new version.** The browser looks at `sw.js` each time the page is opened, and the page asks every six
  hours and when it comes back to the screen after an hour (*About this version* has a button for it). A
  changed `sw.js` is a new worker: it installs (every file checked) and waits. The page asks the workers what
  they know (`describe`) and shows the offer. **Even when the browser makes the new worker the active one**
  (every tab was closed), it goes on answering with the approved version's files, from the approved
  version's list, until the person approves.
* **Approving.** The page names the version to the worker that has it (`approve`). The worker makes sure of
  its files again, writes the record, throws away the caches of other versions, takes over from the old
  worker, and tells every open page (`updated`); each starts again.
* **When the old version can't be had** (the browser cleared its files and the server no longer has them,
  say) the version that this worker has takes its place, and the page says so. A server that can't be
  reached does not do that: the answer is "try again", and the approved version is kept.

The page's side is `web/src/pwa/register.ts` (the `Pwa` class: registering, asking, approving, starting
again) and `web/src/app/app.ts` (the banner, the dialogs, the menu items). The page and the worker talk with
two messages: `describe` → `{ running, files, bytes, replaced, offered: { id, files, bytes, changed } | null }`,
and `approve` → `{ ok }`; the worker sends `{ type: "updated", id }` to the pages.

## What it protects against

* **A file that is not the one that was built**: a partial deploy, a proxy or a content network that changes
  a byte, a poisoned cache on the server's side, a damaged download. Each file is checked against the
  worker's list when it is installed and when it is fetched again; an unchecked file is never served, so
  never run.
* **A page whose files change under it**: the files and the page that uses them stay in step, because they
  come from one version until the whole app is restarted on another.
* **A surprise from an honest server**: a new version is visible (its id, the files that differ), and waits
  for a yes.
* **The network going away.** All of it works offline.

## What it does not protect against

* **A hostile or compromised host.** The worker script is itself fetched from the host, and the browser
  installs a changed one by itself and makes it the active worker once every tab of the app is closed. A
  hostile worker need not honour the approval record: it can serve anything. While a tab is open the old
  worker keeps answering and the page shows the offer, which is a signal; once the tabs are closed the next
  visit runs whatever the new worker says, and the id it shows is its own word. **The pin keeps an honest
  server honest and a tampered file out; it does not make a hostile server harmless.** What helps against one:
  check what a server serves without the page in the way (`node scripts/pwa.mjs --remote ADDRESS`, below),
  compare the id with a published one, host the app yourself, and, strongest, code that does not come from a
  server at all (the packaged desktop build, planned).
* **The first visit.** The first version is trusted as it comes.
* **A host that wipes the device.** A server can send `Clear-Site-Data: "storage"`, and the browser then
  deletes the saved app **and the notebooks** with it. That is not specific to this feature; it is why a copy
  exported now and then (the zip) is worth having.
* **A script that runs in the page** (a cross-site scripting hole, a malicious extension): it can send the
  worker `approve` as the page can. The app's Content-Security-Policy (`scripts/serve.mjs`) is what keeps
  scripts out; a worker can't defend a page against its own page.
* **Another browser or device.** Each has its own copy and its own first visit.

## Checking a version

```bash
cd web
npm run build                          # prints "service worker: version <id>, <n> files"
npm run pwa:check                      # is dist/ what its sw.js was made for? (exit 1 and the files if not)
node scripts/pwa.mjs --remote https://notes.example.org/    # what a server serves: the worker and every file
                                       #   it lists are fetched and compared; prints the id and the worker's SHA-256
```

`--remote` fetches the worker and the files the way `curl` would: no browser, no service worker, no cache.
Run it from somewhere you trust and compare the id (and, to be thorough, the worker's SHA-256) with the
one of a build you made from the sources or one that was published. The same sources and tools gave the same
id twice on the machine this was built on; across machines it was not tried (the engine's wasm, from
`npm run core`, may differ with the toolchain's paths), so for a released copy compare against the release.

## Serving it

* `sw.js` must not be cached for long (the browser's update check is only as prompt as that): `scripts/serve.mjs`
  sends `no-cache` for everything outside `assets/`, and a static host should be set the same.
  `manifest.webmanifest` is served as `application/manifest+json` (a type `serve.mjs` knows).
* **A secure origin**: `https://`, or `localhost` (the SSH tunnel of `docs/zim-editor-plan.md` is one).
  Chromium does not allow a worker for a page whose certificate it does not trust, **even after the person
  clicked through the warning**. That was seen twice: in a real Chromium that was made to proceed past the
  certificate error as the warning's button does (the page was secure, an encrypted notebook was made, and
  the worker was refused with "An SSL certificate error occurred when fetching the script"), and in the log
  of a server that a visitor reached that way (the worker's script was fetched, and nothing was installed
  after it). So `serve.sh --tls` alone gives an app and encrypted notebooks that work after the warning,
  and no saved app: *About this version* says what the browser answered. Two ways to a saved app: a
  certificate that an authority the browser already knows signed (a domain name and Let's Encrypt, then
  `serve.mjs --cert FILE --key FILE`), or the certificate this server makes, **once each computer has been
  asked to trust it**, below.
* The app can sit in a folder of a site: the worker's scope is the folder it is in.
* A server on the Internet is found by scanners within hours (the log of a server on a public address has a
  line from a stranger about every hour, and a few that try it as a proxy). It serves only the app's files, but a password is cheap
  (`ZIM_WEB_AUTH=name:password`, which is safe over `--tls`), and the firewall can let in only your own
  address (`sudo ufw allow from YOUR.IP to any port 8443 proto tcp`).
* iOS: Safari may delete a site's script-writable storage after a week of not visiting it unless the app has
  been added to the home screen. (The saved copy and the notebooks are in that storage.)

## Trusting the certificate that `--tls` makes

```bash
scripts/serve.sh restart --host :: --port 8443 --tls --name 130.180.221.123 --name 192.168.10.10
#                                                      ^ every address or host name that visitors type
```

The certificate is for those names and `localhost`, and no other (without any `--name` it names every address
of the machine, which is for a try-out: the machine's addresses change, and the public address of a router is
not one of them). The server says when it starts which authority signed it, where that authority's file is
(`~/.local/state/zim-web/tls/ca.pem`), and its SHA-256; the same file is served at `https://ADDRESS:PORT/ca.pem`.

**Why it is safe to trust.** The certificate the server holds can sign nothing (`CA:FALSE`). The authority
that signed it exists for this one certificate: it is limited to these names (name constraints), can sign no
authority below it, and **its key was deleted as soon as it had signed**, so it cannot vouch for anything else
for anybody, whatever happens to the server later. What a taken-over server could do is what any server's
key does: be the server (for these names). A computer that trusts the authority is trusting that server, not
a site-signing key. (The certificate the server made before this was itself an authority, with its key on the
server; it was never meant to be imported, and is not made any more.) It is valid for a year, and a new one
(a new authority, to trust again) is made when the names change or a year is nearly up.

**The apps of a computer or a phone do not need this.** The program for a computer and the Android app (`docs/zim-desktop-shell.md`, `docs/zim-mobile-shell.md`) can talk to such a server without any
authority being trusted: they show the person the SHA-256 fingerprint of **the server's own certificate** and ask whether to trust it, and the server prints that fingerprint when it starts (*The server's own
certificate, SHA-256 fingerprint: …*, which is not the authority's: an app compares that one). From then on an app takes that certificate for that address and no other, and asks again when the
certificate is made again. A *browser* still needs the authority below (or the warning's *Proceed*, which gives no offline app).

**On each computer that visits:**

1. Get the authority's file: `https://ADDRESS:PORT/ca.pem` (it is sent as a certificate to install, and a
   browser saves it as `zim-web-authority.crt`; it will warn once, which is why the next step is there) or
   `scp you@server:.local/state/zim-web/tls/ca.pem .`.
2. **Check that it is the right file**, by whatever way does not depend on the channel it came by: its SHA-256
   (`openssl x509 -in ca.pem -noout -fingerprint -sha256`, or the certificate viewer of the system) must be the one
   the server printed (`scripts/serve.sh status`, or `scripts/serve.sh log`).
3. Import it as a trusted authority for identifying websites. The menus differ between versions of each
   system, but this is the usual way:
   * **Windows** (Chrome, Edge): double-click the `.crt` (a `.pem` has to be renamed `.crt` first), *Install Certificate*, *Current User*,
     *Place all certificates in the following store*, *Trusted Root Certification Authorities*.
   * **macOS** (Chrome, Safari): double-click it (Keychain Access opens), add it to the *login* keychain, open
     it there, *Trust*, *When using this certificate: Always Trust*.
   * **Linux, Chrome or Chromium**: Settings, Privacy and security, Security, Manage certificates, *Authorities*,
     *Import*, tick *Trust this certificate for identifying websites*. **Firefox** (on any system): Settings,
     Privacy & Security, *View Certificates*, *Authorities*, *Import*, tick *Trust this CA to identify websites*.
   * **Android** (Chrome): Settings, Security, Encryption & credentials, *Install a certificate*, *CA certificate*.
   * **iOS** (Safari): open the file, allow the profile, install it in Settings, then Settings, General, About,
     *Certificate Trust Settings*, switch it on.
4. Restart the browser and open the address again: there is no warning, and *About this version* says that the
   app is saved on this device.

Taking it back: remove the authority from the same list. When the names change a new authority is made;
trust it, and remove the old one.

The importing is what this document could not do for you on every system; what it checked is the part
that decides whether it works: the certificate verifies for exactly its names and for no other (`openssl
verify`), and a Chromium that knows the authority (here by its key, as an imported one is) saves the app and
starts it with the server shut (a scenario of `web/test/browser.mjs`).

## Limits

* The first visit downloads the whole app (4.4 MB; about 1.7 MB compressed) before it is saved.
* The check for a new version is a request to the server for `sw.js`; no other request is made by the app
  after it is saved, and none carries anything about a notebook.
* There is no background sync, push, or periodic update: a version is looked for when the page is open.
* Removing the saved app is done in the browser's site settings (the registration, the caches and the
  notebooks are all site data).
* What a person can do to the app's own files after it is installed (a script in the page can write to the
  caches) is out of scope, as above.

## What verifies what

| Claim | Checked by |
|---|---|
| The worker keeps every file of a version, each checked, and refuses any that is not the listed one (a byte, a size, a redirect, an error, a server that can't be reached) and keeps nothing of it | `web/test/pwa-worker.test.ts`: the real `sw.js` run in a pretend browser (`helpers/sw-sim.ts`: a Cache API, a server that can be changed and switched off, the worker's lifecycle) |
| It answers from its cache, with the server off, for the folder it is in; leaves everything else to the network; gets cleared files again only if they are the listed ones, and never serves a changed one | same |
| A new version installs and waits; the approved version goes on being served, also by the new worker once active; approving switches, tidies, tells the pages; it takes the old one's place only when the files can't be had | same |
| Mutations (hash not checked, a redirect accepted, every version approving itself, approved version thrown away, any version approvable, pages not told, offline replacing the approved version, ...): 22, each caught but one that is equivalent (the size check is also covered by the hash) | `mutate` runs, see the commit message |
| The list is every file with its size and SHA-256 (as `sha256sum` says), its id changes with a byte, a name, a file, or the worker's code; the worker is written with it and checks out; a server can be checked from outside | `web/test/pwa-build.test.ts` |
| The page registers next to itself, learns the version, offers a waiting one (also one that is active already), approves it by name, starts again once and only when the version changed under it, can be asked again after a postponed restart, says why the app isn't saved | `web/test/pwa-page.test.ts` (against a pretend service-worker container; 16 mutations, all caught) |
| The certificate `--tls` makes: the names that are asked for, a server certificate that can sign nothing, an authority that is limited to those names and has no key left, a fingerprint to check, the file given out at `/ca.pem` and never a key | `web/test/serve.test.ts` (checked with `openssl verify`; 14 mutations, all caught) |
| In Chromium, a certificate the browser does not know and the warning clicked through: the app and an encrypted notebook work, the worker is refused and the app says why; with the authority known: the app is saved and starts with the server shut | `web/test/browser.mjs`, "The certificate that `serve.sh --tls` makes" (2 scenarios) |
| In Chromium: the app is saved, the manifest and icons are what the browser looks for (it is asked, with DevTools, whether anything is in the way of installing it), the page comes from the worker, the server is asked for nothing but `sw.js`; with the server shut it starts and an open and an encrypted notebook are made, written in, locked and unlocked | `web/test/browser.mjs`, "The app on the device" (10 scenarios) |
| In Chromium: a new version waits (also after a reload, and with the new worker made active as the browser does when the last tab closes) and is approved from the banner; the other tabs, also one opened before the app was saved, start again; a new version whose file is as long as it should be but is not the file is refused; a cleared file is never run if it is not the listed one; an update saves what was typed (a slow save is waited for) and locks the encrypted notebooks | same (15 mutations in the real worker and the page, all caught) |
| What the worker keeps is the app and nothing of an encrypted notebook | same: the scan of what the browser keeps reads the cache's files, and finds the app's own text in it (the control) and none of the notebook's |

## Not done

* A way to refuse a new worker script outright (a browser has none), or to see what an updated worker
  does before it takes over.
* The desktop shell (Tauri), whose code comes with the app and not from a server: the strongest answer to
  host-proof hosting.
* Telling the person, with something the worker can't forge, that the worker was changed by the host.
