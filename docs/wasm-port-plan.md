# WASM port plan for `core-rs`

CLAUDE.md open issue #2. This is the central, highest-risk effort of the whole project: get
`core/turtl-core-rs` running in the browser, compiled to WebAssembly, with **byte-identical
ciphertext** versus the native build. This doc records the decisions and the research behind
them, produced by auditing what the crate actually depends on (not just what it could depend
on) and researching current (2026) best practice for each dimension. It supersedes the
generic "libsodium-wasm / IndexedDB / fetch" placeholder in the original stack table.

---

## 1. What core-rs actually depends on (audit findings)

Before picking a WASM strategy, the crate's *actual* usage of each subsystem was audited —
not just "it uses SQLite," but exactly which SQL features, which crypto primitives, which
networking patterns.

### Crypto
Uses `sodiumoxide` (native libsodium bindings), confined entirely to `src/crypto/low.rs` +
`src/crypto/mod.rs` — nothing in `carrier`/`dumpy`/`clouseau` touches crypto. Primitives:
`aead::chacha20poly1305_ietf` (seal/open — the *only* symmetric cipher, `SYM_ALGORITHM =
["chacha20poly1305"]`), `sealedbox` (curve25519 anonymous encryption), `pwhash` (Argon2-family
key stretching), `hash::sha256`/`sha512`, `auth`/HMAC-SHA512256 (defined but never called
outside its own unit tests — dead code), and `randombytes`.

**Hot path for "encrypt/decrypt a note" — the one that matters most for the WASM port — is
narrow: only `chacha20poly1305_ietf` seal/open plus `randombytes` for the nonce.** Every
note/board/space/file body and every keychain key-wrap goes through one function
(`crypto::encrypt`/`decrypt` in `mod.rs`). Everything else (pwhash/Argon2, sealedbox, sha256/
sha512, HMAC) is incidental — account creation/login, invites, or dead code — and can be
ported later, off the critical path.

**Custom envelope on top of raw libsodium (must be bit-reproduced, not just "the same AEAD
primitive"):** a hand-rolled versioned binary header —
`[2B version][1B desc-len][desc=1B algo-index][1B nonce-len][nonce][ciphertext]` — built/parsed
manually, where the *entire serialized header* (everything except ciphertext) is fed to
`seal`/`open` as the AEAD's additional-authenticated-data (metadata integrity is bound via AD,
not a separate HMAC-then-encrypt layer). A "key encryption" (e.g. wrapping a note's key under
a keychain key) isn't a KDF/wrap primitive — it's just `Key::random()` (raw bytes) run through
the same generic `encrypt()`. The login-auth flow separately derives its nonce
*deterministically* from `sha512(username)` (intentional nonce reuse per-user, not random) and
uses a hardcoded `TOKEN_KEY` constant — this exact derivation would need bit-exact
reproduction too, but it's outside the note-encryption hot path.

Separately, the sibling `migrate` crate has its own, entirely different legacy crypto stack
(the abandoned `rust-crypto` crate: AES-CBC/AES-GCM, PBKDF2-HMAC-SHA1/SHA256) for importing
old Turtl v1 profiles. Unrelated to the sodiumoxide/WASM question; triage separately later.

### Storage
Two SQLite-backed subsystems with very different SQL dependency:
- **`dumpy`** (wrapped by `src/storage.rs`, the model/notes store): schema-less JSON-blob
  storage with a hand-rolled secondary-index table — 3 fixed tables, no `JOIN`, no
  `ALTER TABLE`, one `LIKE`-prefix index scan. Its own README already calls this "a crude
  IndexedDB." Low-risk for any backend.
- **`clouseau` + `src/search.rs`** (full-text/tag search): a *real* relational+FTS component —
  SQLite FTS4 `MATCH`, `INTERSECT`/`UNION` set algebra across sub-selects, `GROUP BY ... HAVING
  COUNT(*)`, count-over-subquery pagination, dynamic `ORDER BY`/`LIMIT`/`OFFSET`. This is not
  representable in IndexedDB without hand-building a full-text search engine from scratch.
- `sync/incoming.rs` wraps a whole incoming-sync batch in an explicit SQL
  `BEGIN TRANSACTION`/`COMMIT TRANSACTION` — dumpy itself has no internal transactions, so
  atomicity is supplied by the caller. Any storage backend must reproduce this same
  all-or-nothing guarantee.
- The `migrate` crate is a red herring for this work: despite its name, it's a one-time
  legacy-account HTTP importer, unrelated to local SQL/schema.

### Networking + concurrency
- All HTTP goes through one place (`src/api.rs`), using **blocking** `reqwest 0.10.4` — which
  does not compile at all for `wasm32-unknown-unknown` (no real sockets on that target; the
  `blocking` feature needs a tokio runtime + real OS threads). Every call site (the generic
  JSON path, the sync engine's long-poll, both file up/download streaming paths) is
  synchronous today; porting to `fetch` means making all of it `async`.
- The sync engine's "realtime" is long-polling (a plain HTTP GET with a long server-side
  timeout) — not a raw socket or websocket. `fetch` + `AbortController` reproduces this fine.
  The only websocket/raw-socket code in the repo (`sock/`) is dev-only tooling, already
  excluded from the workspace — it does not need a WASM equivalent.
- `Turtl.work` (a `Thredder` over `futures_cpupool::CpuPool`, sized `num_cpus - 1`) and
  `sync::start()` (4 permanent OS threads) assume real OS-level parallelism throughout. None
  of that exists in a default `wasm32-unknown-unknown` build without opting into the wasm
  threads proposal (`SharedArrayBuffer` + `Atomics` + a nightly, atomics-enabled toolchain +
  `COOP`/`COEP` deployment headers) — a much bigger toolchain/deployment commitment than a
  plain `wasm-pack` build.

---

## 2. Decisions

### 2.1 Crypto: real `libsodium.js` via a wasm-bindgen JS bridge

**Decision:** keep native `sodiumoxide`/libsodium on native targets unchanged. For the web
build, load `libsodium.js` (jedisct1's actual libsodium C source, Emscripten-built, npm:
`libsodium-wrappers`) as its own wasm module, and call into it from the core's
`wasm32-unknown-unknown` build through wasm-bindgen's JS-import mechanism
(`#[wasm_bindgen(module = "...")]` / a small hand-written JS glue snippet, since wasm-bindgen
JS snippets can't themselves contain `import` statements).

**Why:** this is the only approach where byte-identical ciphertext is a structural guarantee
rather than something to test for and hope holds — it's literally the same C implementation,
just running under Emscripten's runtime instead of native. It matches the CLAUDE.md locked
decision ("use libsodium primitives... byte-identical ciphertext") without revising it, and
it's production-proven for exactly this kind of app: Standard Notes' `@standardnotes/sncrypto-web`
uses libsodium.js in-browser for Argon2id + XChaCha20-Poly1305 in a real E2EE product.

**Rejected alternatives:**
- *Compiling libsodium's C source bare to `wasm32-unknown-unknown`* (no OS layer at all): a
  confirmed dead end. libsodium's own maintainer states plainly that standalone WebAssembly
  has no RNG/syscall surface, so libsodium's build system only targets Emscripten or
  `wasm32-wasi`, never bare `wasm32-unknown-unknown`. The one prior-art attempt
  (`alexcrichton/wasm-sodium`) needed a Docker + nightly-Rust hack and has been archived
  (read-only) by its own author since mid-2022.
- *`libsodium-sys-stable`'s WASI build*: also real libsodium C code (so byte-identical), but
  targets `wasm32-wasip1`/`wasip2`, a different target triple than `wasm-pack`/wasm-bindgen's
  browser pipeline uses — getting a WASI binary into an actual browser tab needs an extra,
  non-standard WASI-in-browser polyfill layer with no established recipe for this combination.
- *`dryoc`* (pure-Rust, libsodium-API/wire-format-compatible, `wasm32-unknown-unknown` native):
  a strong option and the *simplest* path to a single-wasm-binary architecture with no JS
  bridge for crypto at all — but it is a **different implementation**, not literally libsodium,
  so "byte-identical" becomes a claim to verify (via a golden-vector test suite) rather than a
  structural guarantee. Its own compatibility notes claim no byte-level divergence on
  secretbox/box/pwhash specifically, and adopting it on *both* native and web (Bitwarden's SDK
  ships exactly this pattern) would remove the native-vs-wasm parity question entirely —
  logged here as a real option if the JS-bridge approach proves too costly in practice, but
  it revises the locked "use libsodium" decision and wasn't the pick made this round.
- *Hand-picked RustCrypto crates per primitive*: real footguns found in research (libsodium's
  `secretbox` default is XSalsa20-Poly1305, not the more modern-sounding XChaCha20-Poly1305;
  `ed25519-dalek`'s permissive vs. strict verification modes accept different signatures than
  libsodium in edge cases; libsodium's `crypto_auth` is HMAC-SHA-512 truncated to 256 bits, NOT
  the same as hashing with SHA-512/256). Not adopted — too much bespoke compatibility work with
  no upstream guarantee, and `dryoc` already did this work.

**Known integration costs:** libsodium.js requires an async `await sodium.ready` init before
any call (native init is currently synchronous); two wasm modules load instead of one; every
crypto call crosses a JS↔wasm boundary. **Non-negotiable regardless of approach:** a
golden-vector test suite feeding fixed `(key, nonce, plaintext, salt)` tuples through both the
native path and the wasm path, diffing raw output bytes — the same discipline CLAUDE.md
already mandates for Zim `.txt` round-trips.

### 2.2 Storage: real SQLite linked into the same wasm binary (`sqlite-wasm-rs`)

**Decision:** use `sqlite-wasm-rs` (crates.io, by Spxg) — a Rust crate providing real
`libsqlite3` compiled directly to `wasm32-unknown-unknown`, linked into the *same* wasm binary
as the rest of core-rs (no separate JS-bridged SQLite module), with its `sahpool` feature
(OPFS-SAHPool VFS) for persistence.

**Why:** the storage audit (§1) ruled out a bare IndexedDB rewrite early — `search.rs`/
`clouseau`'s real FTS4 + set-algebra + aggregate SQL has no IndexedDB equivalent, and
reimplementing full-text search from scratch in Rust would be by far the largest new-code item
of any option, with no guarantee of matching native search behavior (working against CLAUDE.md's
"identical public interface across native and WASM" convention at the semantic level even if
function signatures matched). Given SQL must be kept, `sqlite-wasm-rs` needs at most an
FTS4→FTS5 rename plus a thin rusqlite-shaped wrapper over its C FFI for the small API surface
`storage.rs`/`dumpy`/`search.rs`/`clouseau` actually use — not a query rewrite — and keeps
core-rs's "one process, direct FFI" architecture instead of introducing a second Emscripten
wasm module. A comparable security-sensitive product (Wire) has already forked this crate for
production use.

**Rejected alternatives:**
- *Official `@sqlite.org/sqlite-wasm` or `wa-sqlite`*: both are more mature, more
  battle-tested, real-SQLite, OPFS-backed options — logged here as the fallback if
  `sqlite-wasm-rs`'s pre-1.0 Rust API proves too rough in practice. Cost: a second,
  independent Emscripten-built wasm module bridged over JS (same shape as the crypto
  JS-bridge option), and some VFS variants need `COOP`/`COEP` cross-origin-isolation headers
  (`sqlite-wasm-rs`'s SAHPool port needs none).
- *Plain IndexedDB* (rexie/idb/indexed_db_futures): the only option that is a genuine rewrite
  rather than a port — forces hand-building a full-text search engine (tokenizer, inverted
  index, ranking) from scratch, the single largest net-new subsystem surveyed, with no
  behavioral-parity guarantee versus native. This was CLAUDE.md's original stack-table
  placeholder; superseded by this decision.
- *Turso (formerly Limbo)*: a clean-room pure-Rust SQLite rewrite, appealing long-term (zero
  C/Emscripten dependency at all) but explicitly pre-1.0/beta as of Sept 2026, and its
  documented browser story targets a different WASI-threads/napi-rs path, not a plain
  `wasm32-unknown-unknown` Cargo dependency. Worth re-evaluating in 6–12 months as a possible
  v2 storage-engine swap; not for this first port.

**Known integration costs:** OPFS synchronous access handles only exist inside a dedicated Web
Worker (never the main/DOM thread, never a `SharedWorker`) — storage must be moved into a
Worker regardless of which SQL-on-wasm option is used. Single-connection/multi-tab access
needs an explicit pause/resume handshake under SAHPool-style VFSes.

### 2.3 Networking: upgrade `reqwest` in place, make it async everywhere

**Decision:** upgrade the existing `reqwest` dependency (0.10.4 → current 0.13.x) and use its
async API on *both* native and `wasm32-unknown-unknown`, rather than adding a second HTTP crate
for the web target. Current `reqwest` already auto-switches to a `web-sys`/`fetch`-backed
`Client` when compiled for `wasm32` — same crate, same call-site shape, on both targets, which
is what "keep the core's public interface identical across native and WASM" (an existing
CLAUDE.md convention) requires in practice once one target must be async.

**Cost accepted:** every blocking call site (`api.rs`'s generic JSON path, the sync long-poll,
both file streaming paths) becomes `async fn` + `.await`, cascading up through `dispatch.rs`
and all four `Syncer::run_sync()` implementations — a real, crate-wide refactor, not a
mechanical swap — plus absorbing the 0.10.4→0.13.x version jump's unrelated breaking changes.
Custom-TLS config (`danger_accept_invalid_certs`) and HTTP proxy support have no fetch
equivalent and must be dropped/no-op'd for the web build specifically (a real capability loss
for that target, not just a code change).

**Rejected alternatives:** `gloo-net` (wasm-only, would mean two different HTTP crates behind
a `cfg`, more divergence to maintain) and raw `web-sys` fetch bindings (reimplements what
reqwest/gloo-net already give for free) — reach for either only if a concrete reqwest-on-wasm
limitation blocks a real feature later.

### 2.4 Concurrency: single-threaded async + one dedicated Web Worker

**Decision:** replace the native `Thredder`'s "spawn an OS thread, block it, message the
result back" pattern with cooperative `async`/`await` tasks scheduled via
`wasm_bindgen_futures::spawn_local`, with the whole wasm+JS core instance hosted inside one
dedicated Web Worker (never the DOM/UI thread) so the interface never blocks even though
nothing runs in literal parallel. Native's thredder can stay OS-thread-based, or be modernized
onto an async runtime (tokio) in the same pass as the reqwest upgrade — either way, the core's
public "submit job / get result" shape must stay the same across targets.

**Why:** this needs no `SharedArrayBuffer`, no `COOP`/`COEP` deployment headers, no nightly
toolchain — it works today on any static host, inside a plain Tauri or Capacitor webview shell,
with zero deployment preconditions (relevant to open issue #6, the web-crypto trust model,
since simpler hosting requirements make a locked-down PWA deployment easier). It's also the
same Future-based concurrency style that the async-`reqwest` migration (§2.3) and any
IndexedDB/OPFS storage access already require, so it's one concurrency model for the whole web
build rather than three.

**Rejected/deferred:** real multithreading via the wasm threads proposal
(`wasm-bindgen-rayon` for data-parallel work, or `wasm_thread`/`wasm-bindgen-spawn` for a
closer `std::thread::spawn` feel) is real, shipping technology in 2026 (`wasm-bindgen-rayon`
is stewarded by GoogleChromeLabs) — but its `COOP`/`COEP` requirement constrains every
cross-origin subresource the page loads (and must be configured in the Tauri/Capacitor webview
hosts too), needs a nightly Rust toolchain rebuilding libstd with atomics, and buys nothing
without a *specific, measured* CPU-bound hotspot (bulk notebook re-encryption, large-notebook
reindexing). Logged as a later, narrowly-scoped optimization, not part of "get the port
building."

---

## 3. Net result: one wasm binary, one JS-bridged crypto module

The chosen architecture is: **core-rs's own Rust code + `sqlite-wasm-rs` (real SQLite) compile
together into one `wasm32-unknown-unknown` binary** (matching core-rs's native "one process,
direct FFI" shape for storage), which **calls out over a JS bridge to a second, independent
wasm module (`libsodium.js`) only for cryptography** (the one place where "byte-identical to
native" is non-negotiable and only a real-libsodium approach delivers it structurally).
Networking and concurrency are unified on async/await across both native and web targets.

---

## 4. Suggested build order for the port itself

1. Toolchain: `wasm32-unknown-unknown` target + `wasm-pack` (already in CLAUDE.md's setup
   steps); Node/npm for pulling `libsodium-wrappers`.
2. **Crypto PoC first, in isolation** — don't attempt to get the whole `turtl_core` crate
   compiling for wasm yet. Prove the libsodium.js JS-bridge mechanism works and passes a
   golden-vector parity suite against native `sodiumoxide`, for the primitives actually used
   on the "encrypt/decrypt a note" hot path. This is the single riskiest, most novel piece —
   de-risk it before the larger crate-wide surgery below.
3. Feature-gate the rest of `turtl_core` for a `wasm32` target: cfg out the OS-thread sync
   engine and `Thredder`/`CpuPool`, swap blocking `reqwest` call sites to async, swap
   `rusqlite` for `sqlite-wasm-rs` behind the storage abstraction.
4. Get `wasm-pack build --target web` producing a loadable module end to end (even a
   minimal one), then reintroduce real sync/storage/crypto behind that scaffold.
5. Full golden-vector + integration parity pass (crypto ciphertext, storage/search query
   results) between native and wasm builds before calling the port done.

## Status

- [x] Toolchain: `wasm32-unknown-unknown` target + `wasm-pack` 0.15.0 installed.
- [x] Step 2: crypto PoC (libsodium.js JS bridge, `chacha20poly1305_ietf` seal/open +
      randombytes, golden-vector parity vs. native `sodiumoxide`) — **done**. New crate
      `core/wasm-crypto-poc` (`wasm-pack build --target nodejs`) reproduces `turtl_core`'s
      exact envelope format (`[version][desc_len][desc][nonce_len][nonce][ciphertext]`,
      header-as-AAD) via a wasm-bindgen JS bridge to real `libsodium-wrappers`. 11 golden
      vectors generated from the real native `crypto::encrypt()` path (empty/short/long-KB/
      binary/non-ASCII plaintexts) all pass byte-exact parity in both directions
      (`wasm_encrypt` output == native envelope bytes; `wasm_decrypt(native envelope)` ==
      original plaintext), confirmed on a from-scratch rebuild. See
      `core/wasm-crypto-poc/{src/lib.rs,js/sodium_bridge.js,test/run_test.js}`.
- [x] Step 3: feature-gate `turtl_core` for wasm32 (threads, blocking reqwest, rusqlite) —
      **done**. `cargo check --target wasm32-unknown-unknown` (no extra features needed; the
      native-only `sqlite-static` feature is simply irrelevant on this target since `rusqlite`
      isn't a wasm32 dependency at all) succeeds for the whole `turtl_core` workspace. Native
      `cargo test --features sqlite-static` still passes all 63 tests, unchanged.

      **Approach:** target-specific Cargo dependency tables
      (`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`) gate out every dependency with
      no real wasm32 story — `rusqlite`/`sqlite-static` (native SQLite), `sodiumoxide` (native
      libsodium C bindings), `reqwest` (blocking client only), `regex` 0.1.x + `clippo` (pulls in
      `thread-id`/`memchr` 0.1, neither of which has a wasm32 branch), `migrate` (its `rust-crypto`
      path dependency has the same native-C-build problem as rusqlite), `num_cpus`,
      `futures-cpupool`, `fs2` (advisory file locking — no filesystem to lock on this target). A
      wasm32-only `http = "0.2.12"` dependency was added: reqwest 0.10.x re-exports
      `http::{Method, StatusCode}` directly, so depending on `http` lets the wasm32 stub reuse the
      *exact same types* `TError::Api`/`Http` and match arms like `StatusCode::UNAUTHORIZED`
      already use natively, not a look-alike duplicate.

      For the Rust side, two patterns were used depending on how narrow the surface was:
      - **Whole-file swap** (via `#[path = "..."]` on the `mod` declaration in lib.rs/sync/mod.rs)
        for subsystems that are *entirely* native-only-dependency-shaped: `api.rs` →
        `api_wasm.rs`, `storage.rs` → `storage_wasm.rs`, `search.rs` → `search_wasm.rs`,
        `sync/incoming.rs` → `sync/incoming_wasm.rs`. Each stub preserves the real file's public
        struct/function signatures exactly, with every body that would touch the network/a real
        DB returning `TError::NotImplemented`/`CryptoError::NotImplemented`. `sync/outgoing.rs`
        and `sync/files/{incoming,outgoing}.rs` have no consumers outside `sync::start()` (itself
        native-only below), so they're simply excluded from the wasm32 build entirely rather than
        stubbed.
      - **In-file `#[cfg]` twins** (same name, mutually-exclusive `#[cfg(not(target_arch =
        "wasm32"))]` / `#[cfg(target_arch = "wasm32")]`, one item each) for individual
        functions/consts inside files that are otherwise shared: every direct-`sodiumoxide` call
        in `crypto/low.rs` (`sha256`, `sha512`, `hmac`, `secure_compare`, `rand_bytes`,
        `random_salt`, `gen_key`, `chacha20poly1305::{encrypt,decrypt}`, `asym::{keygen,encrypt,
        decrypt}`); `sync::start()`; `turtl.rs`'s `join_migrate()`/`get_user_db_location()`;
        `dispatch.rs`'s `"clip"`/`"user:can-migrate"`/`"user:migrate-auth-debug"` command arms;
        `util/thredder.rs`'s `Thredder` (see below).

      **Two deliberate exceptions to "stub returns NotImplemented":**
      - `Thredder` (`util/thredder.rs`) runs its closure **synchronously, inline** on wasm32
        instead of erroring — it's genuinely correct (not a lie or a no-op), just not
        backgrounded, which is an honest placeholder for decision 2.4's real single-threaded-async
        rewrite. This keeps every real caller (`sync_model::save_model`, `models/file.rs`,
        `models/protected.rs`) working unchanged since they only care about the result.
      - `turtl.rs`'s `get_user_db_location()` does plain non-regex ASCII-alphanumeric filtering
        instead of erroring, since it's pure string logic with no crypto/network/storage
        involved (and feeds into `storage::db_location()`, which is itself not-yet-ported).
      - `chacha20poly1305::{keylen, noncelen}` return hardcoded literals (32, 12) matching
        sodiumoxide's real constants — public algorithm-dimension numbers, not secrets, so
        mirroring them directly is safe and lets `Key::random()`/nonce generation keep their
        real shapes even though the actual RNG/AEAD calls beneath them are stubbed.
      - `sync/incoming_wasm.rs`'s `process_incoming_sync()`/`ignore_syncs_maybe()` are copied
        **verbatim** (not stubbed) from the real file: they only ever drain an in-process
        `MsQueue` that nothing on wasm32 currently populates (since `sync::start()` is stubbed),
        so the real logic is both correct and side-effect-free today, and will "just work" the
        moment a wasm32 sync producer exists.

      **Every stub is marked** with a `// TODO(wasm): ... see docs/wasm-port-plan.md` comment,
      grep with `grep -rn "TODO(wasm)" core/turtl-core-rs/src`.

      **New files:** `src/api_wasm.rs`, `src/storage_wasm.rs`, `src/search_wasm.rs`,
      `src/sync/incoming_wasm.rs`.
      **Changed:** `Cargo.toml`, `src/lib.rs`, `src/error.rs`, `src/crypto/low.rs`,
      `src/dispatch.rs`, `src/turtl.rs`, `src/models/user.rs`, `src/sync/mod.rs`,
      `src/util/thredder.rs`.
- [x] Step 4a (crypto hot path only): wired `core/wasm-crypto-poc`'s real-libsodium.js bridge
      into the ACTUAL `turtl_core::crypto` module -- **done**. `crypto/low.rs`'s wasm32 stubs for
      `rand_bytes()` and `chacha20poly1305::{encrypt, decrypt}` (the only primitives
      `crypto::encrypt`/`crypto::decrypt` in `mod.rs` -- the crate's real note/board/keychain
      encryption API -- actually calls) are now real, calling through a wasm-bindgen JS bridge
      (`crypto/low.rs`'s private `wasm_bridge` module, module path `/js/sodium_bridge.js`) to real
      `libsodium-wrappers`, reproducing `core/wasm-crypto-poc`'s exact bridge mechanism and
      envelope/AAD handling (which needed no changes -- it already lived in `mod.rs`).
      `sha256`/`sha512`/`hmac`/`secure_compare`/`gen_key`(pwhash)/`random_salt`/`asym::*`
      (sealedbox) remain untouched `NotImplemented` stubs (incidental to note encryption; each
      needs its own future milestone per the crypto audit in §1).

      **The async-init problem, and why it's solved without bumping the crate's edition:**
      `libsodium-wrappers` needs an async `sodium.ready` before any `crypto_*`/`randombytes_*`
      call works, but `wasm32-unknown-unknown` in a browser is single-threaded (a sync fn can't
      block on a JS Promise without deadlocking). The natural fix -- one new `async fn
      init_wasm_crypto()` that callers await once, leaving `rand_bytes()`/`chacha20poly1305::
      {encrypt,decrypt}` themselves synchronous -- ran into a real, previously-unknown-to-this-
      plan constraint: **`turtl_core` is an (implicit, unspecified) Rust 2015-edition crate, and
      `async fn`/`.await` syntax is rejected outright there** (`error[E0670]: async fn is not
      permitted in Rust 2015`). Bumping `edition = "2018"` was tried and reverted: it broke
      ~600 unrelated call sites crate-wide (this crate leans on 2015-specific macro/path
      resolution pervasively -- e.g. glob-imported `macro_rules!` names colliding with module
      items, was one concrete failure seen). That is very much *not* a safe, narrow change, so
      the crate stays on (implicit) edition 2015.

      Instead, `crypto::init_wasm_crypto()` is a **plain synchronous fn returning `js_sys::
      Promise`**, built from a hand-written `Future` impl (`low.rs`'s `InitCryptoFuture` --
      implementing the `Future` *trait* has no edition restriction; only the `async`/`.await`
      *syntax* does) wrapping `wasm_bindgen_futures::JsFuture`, driven to a `Promise` via
      `wasm_bindgen_futures::future_to_promise`. A JS embedder calls `await
      wasm.initWasmCrypto()` exactly as originally planned -- the edition constraint is invisible
      from JS. A `static AtomicBool` (`CRYPTO_READY`) marks readiness; `rand_bytes()`/
      `chacha20poly1305::{encrypt,decrypt}` check it up front and fail with
      `CryptoError::OperationFailed` (a clear, honest error, not a silent no-op) if called first.

      **New files:** `core/turtl-core-rs/js/sodium_bridge.js` (adapted from
      `core/wasm-crypto-poc/js/sodium_bridge.js`, plus a `randomBytes` export for
      `rand_bytes()`), `core/turtl-core-rs/package.json` (`libsodium-wrappers` dependency, `npm
      install`ed locally in that directory).
      **Changed:** `Cargo.toml` (wasm32-only `wasm-bindgen`/`wasm-bindgen-futures`/`js-sys`
      deps, wasm32-only `wasm-bindgen-test` dev-dependency; `[lib]`/edition left untouched),
      `src/lib.rs` (matching `extern crate` declarations), `src/crypto/low.rs` (the bridge +
      `init_wasm_crypto`/`InitCryptoFuture`/`CRYPTO_READY`/`require_wasm_crypto_ready`, and the
      real `rand_bytes`/`chacha20poly1305::{encrypt,decrypt}` bodies), `src/crypto/mod.rs`
      (wasm32-gated `pub use` of `init_wasm_crypto`, plus a `wasm_parity_tests` module -- see
      below).

      **Verification -- real wasm32 execution, not just `cargo check`:** `wasm-pack test --node`
      (needs `NODE_PATH="$(pwd)/node_modules"` set first -- `wasm-bindgen-test-runner` copies JS
      snippets to an OS temp dir, which breaks plain Node module resolution of the locally
      `npm install`ed `libsodium-wrappers`; `NODE_PATH` fixes that without touching the snippet
      mechanism) runs three `#[wasm_bindgen_test(async)]` tests in `crypto/mod.rs`'s
      `wasm_parity_tests` module, all passing:
      - `wasm_matches_native_golden_vectors`: for three real native-generated golden vectors
        (hardcoded `(key_hex, plaintext_hex, envelope_hex)` triples, captured from a real run of
        `crypto::tests::generate_wasm_golden_vectors`, covering empty plaintext, plain ASCII, and
        embedded-NUL/0xFF-byte plaintext), forces wasm32 `crypto::encrypt()` to reuse the exact
        nonce native picked at random (extracted via the real `crypto::deserialize()`) and
        asserts the resulting envelope is **byte-for-byte identical** to the real native
        envelope, then asserts real wasm32 `crypto::decrypt()` recovers the exact original
        plaintext bytes from that real native envelope.
      - `wasm_round_trip_with_random_nonce`: a full encrypt-then-decrypt cycle using wasm32's
        own `rand_bytes()` (i.e. real libsodium.js randomness, not an extracted/forced nonce).
      - `wasm_rejects_tampered_envelope`: flipping a byte in the AAD-covered header, or the
        last ciphertext/tag byte, of a real envelope makes real wasm32 `crypto::decrypt()` fail
        with `CryptoError::Authentication` -- both directly (mirrors the tamper check in
        `core/wasm-crypto-poc/test/run_test.js`).

      Because `async fn`/`.await` are unavailable (see above), these are written as plain `fn`s
      returning a small hand-written `Future` (`wasm_parity_tests::ThenReady`, wrapping a
      `JsFuture` over the real `crypto::init_wasm_crypto()` Promise plus a synchronous assertion
      closure) and annotated `#[wasm_bindgen_test(async)]` (the explicit meta-attribute form,
      which `wasm-bindgen-test`'s macro accepts without requiring literal `async fn` syntax on
      the attributed item -- confirmed by reading `wasm-bindgen-test-macro`'s source, since this
      isn't documented prominently).

      **Native regression check:** `cargo test --features sqlite-static` -- still 63/63,
      unchanged (same count as the step-3 milestone). `cargo check --target wasm32-unknown-unknown`
      still succeeds, now compiling real crypto for the hot path instead of stubs.
- [ ] Step 4b: `sqlite-wasm-rs` into `storage.rs`/`search.rs`, and async `reqwest`/`fetch` into
      `api.rs` (decisions 2.2/2.3), plus the real single-threaded-async concurrency rewrite
      (2.4) to replace `Thredder`'s current synchronous-inline placeholder. Also still open:
      `wasm-pack build --target web` producing a loadable module end to end (this milestone only
      ran `wasm-pack test --node`, a `--target nodejs`-style build for tests; a real
      `--target web` build/load hasn't been attempted yet), and the remaining incidental crypto
      stubs (`sha256`/`sha512`/`hmac`/`secure_compare`/`gen_key`(pwhash)/`asym::*`).
- [ ] Step 5: full parity pass before calling the port done.
