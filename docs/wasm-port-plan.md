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
["chacha20poly1305"]`), `sealedbox` (curve25519 anonymous encryption), `pwhash` (**scrypt** —
`crypto_pwhash_scryptsalsa208sha256`; sodiumoxide 0.0.16's `pwhash` module contains only that,
not Argon2 as an earlier draft of this audit said; corrected 2026-10-05 from the crate source),
`hash::sha256`/`sha512`, `auth`/HMAC-SHA512256 (defined but never called outside its own unit
tests — dead code), and `randombytes`.

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

**Refinement (2026-10-05): use the *sumo* build.** Native `gen_key()` is scrypt, and the standard
`libsodium-wrappers` omits all password hashing (and the explicit `crypto_hash_sha512`);
`libsodium-wrappers-sumo` has them, with the same API and init. See Step 4b-5a in the Status
section for the verification.

**Refinement (2026-10-05): inject libsodium, don't import it.** The core ships no JS of its own.
The host app loads libsodium.js and hands it in; Rust calls its methods through typed wasm-bindgen
bindings (`core/turtl-core-rs/src/crypto/wasm_sodium.rs`):

```js
import init, { initWasmCrypto, cryptoSelfTest } from 'turtl_core';  // the wasm-pack output
import sodium from 'libsodium-wrappers-sumo';                       // the HOST owns this dependency

await init();                    // load the core's wasm
await initWasmCrypto(sodium);    // awaits sodium.ready, checks it is the sumo build, keeps it
cryptoSelfTest();                // optional startup assertion: known answers from the injected build
```

Why this over a JS bridge file the crate imports itself: (1) there is no CommonJS-vs-ES-module split
per wasm-bindgen target (a bridge file must be written in the module system of the target it is
built for, `require` for `nodejs`/`--node` tests but `import` for `web`/`bundler`), so one wasm
serves `web`, `bundler`, `nodejs` and Deno alike; (2) production builds have no npm dependency of
the crate at all, which also removes the wasm-pack `package.json` trap (Step 4b-1 follow-up d);
(3) the dependency lives in the web app's (or Tauri/Capacitor shell's) own `package.json`, resolved
by the bundler it already uses, so quirks in how libsodium.js packages itself are the host's to
handle rather than the core's; (4) the trust model is unchanged: the host is the app, so which
libsodium build it loads was always the app's responsibility (SRI, pinned service worker: built, see
`docs/zim-pwa.md`, with its limits; open issue #6), and `cryptoSelfTest()` lets it assert at startup that what it injected behaves like
native (it catches a wrong build or a version mismatch, not a malicious host). The alternative
that was weighed, a second ES-module copy of the bridge chosen by a build flag, would have left a
JS file and a per-target duplicate inside the crate.

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

#### 2.2.1 Refinement (2026-10-05, verified against the published crate sources)

Reading the actual crates before wiring them in changed *how* decision 2.2 gets executed (not
the decision itself — it is still real SQLite via `sqlite-wasm-rs`, linked into the one wasm
binary):

- **No hand-written rusqlite shim.** The "thin rusqlite-shaped wrapper" idea above is
  superseded: `rusqlite` **0.39+ integrates `sqlite-wasm-rs` upstream**. Its `ffi-sqlite-wasm-rs`
  feature is on by default and, on `wasm32-unknown-unknown`, swaps `libsqlite3-sys` for
  `sqlite-wasm-rs` (`Connection::open*` then uses an in-memory DB unless a persistent VFS is
  installed). So the plan is to **upgrade `rusqlite` 0.20 → 0.40.x on both targets** and run the
  *same* `dumpy`/`clouseau`/`storage.rs`/`search.rs` source everywhere, instead of keeping
  whole-file `storage_wasm.rs`/`search_wasm.rs` stubs. The API surface to migrate is small
  (inventoried: `Connection::{open_in_memory[_with_flags], open_with_flags, execute, prepare,
  query_row[_and_then], close}`, `Statement::query_map`, `Row::get[_unwrap]`, `ToSql`/
  `ToSqlOutput`, `types::Value`, `OpenFlags`, `NO_PARAMS`, `Error::QueryReturnedNoRows`; no
  PRAGMAs, no ATTACH, no custom SQL functions; the only explicit transaction is the
  `BEGIN`/`COMMIT TRANSACTION` pair in `sync/incoming.rs`).
- **FTS4 is not compiled into the wasm SQLite.** `sqlite-wasm-rs`'s build enables
  `SQLITE_ENABLE_FTS5` but not `FTS3`/`FTS4`, while `clouseau` creates its index with
  `USING fts4` and passes user text straight to `MATCH`. Rewriting to FTS5 would change native
  behaviour too (stricter query syntax, different default tokenizer), which breaks the "same
  semantics on every target" rule. So `fts4` is kept and
  `-DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS3_PARENTHESIS` are added to the
  wasm32 C build via the checked-in `core/turtl-core-rs/.cargo/config.toml` `[env]` entry
  (`CFLAGS_wasm32_unknown_unknown`, read by the `cc` crate). **Verified, with a negative
  control:** `clouseau`'s 3 searches and `turtl_core`'s `search::tests::index_unindex_filter`
  (which uses the enhanced `(a OR "b c")` syntax that needs `FTS3_PARENTHESIS`) pass in real
  wasm; overriding the flag away makes all 3 `clouseau` tests fail with `no such module: fts4`.
  Cargo only discovers that config when run from inside `core/turtl-core-rs`.
- **Persistence layout changed between crate lines.** `rusqlite` 0.40.2 depends on
  `sqlite-wasm-rs ^0.5.1`; the standalone 0.6.x line moved the OPFS `sahpool` VFS out into a
  separate `sqlite-wasm-vfs` crate (default VFS is in-memory in both). Either way it needs a
  secure context and a dedicated Worker, and does not support concurrent connections to the same
  database — consistent with decision 2.4. cargo resolved `sqlite-wasm-rs` **0.5.5** (in-memory
  VFS only). *Chosen when persistence was wired (step 4b-5b):* `sqlite-wasm-vfs` **0.2.x**, the
  line built against `sqlite-wasm-rs` 0.5 (0.3.x pairs with 0.6); it needs a real browser to test,
  since Node has no OPFS.
- **Build requirements (not just Rust).** `sqlite-wasm-rs` compiles SQLite's C source for
  `wasm32-unknown-unknown`, so the machine needs a wasm32-capable `clang` (the `cc` crate
  defaults to clang for wasm32: "Compiling WASM is not currently supported by GCC") plus
  `llvm-ar` (cc-rs looks for it for wasm32 archives; a GNU `ar` archive has no symbol index
  `wasm-ld` can use). On Debian/Ubuntu: `sudo apt-get install -y build-essential clang llvm`.
  `build-essential` is also needed for any native build (proc-macros and build scripts link
  natively), which the first fresh-machine setup discovered was missing from the import script's
  package list.

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

## 3. Net result: one wasm binary, one host-injected crypto module

The chosen architecture is: **core-rs's own Rust code + `sqlite-wasm-rs` (real SQLite) compile
together into one `wasm32-unknown-unknown` binary** (matching core-rs's native "one process,
direct FFI" shape for storage), which **calls out to a second, independent wasm module
(`libsodium.js`, injected by the host app via `initWasmCrypto(sodium)`) only for cryptography**
(the one place where "byte-identical to native" is non-negotiable and only a real-libsodium
approach delivers it structurally).
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
- [x] Step 4a (crypto hot path only) -- *the JS-bridge mechanism described in this entry was
      replaced by host injection in Step 4b-4 (`js/sodium_bridge.js` and the `wasm_bridge` module
      no longer exist); the async-init reasoning and the verification still stand*:
      wired `core/wasm-crypto-poc`'s real-libsodium.js bridge
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
      the crate stays on (implicit) edition 2015. **[Superseded in Step 4b-2a: that diagnosis was
      wrong about the cause and the cost. The ~600 errors were almost all 2015-style absolute
      paths to the crate's own modules, and a mechanical rewrite fixed them; the crate now builds
      as edition 2018 with every test green, so `async fn`/`.await` is available. The hand-written
      `Future`s this entry describes (`InitCryptoFuture`, the tests' `ThenReady`) were then replaced
      with plain `async fn`s, and the wasm tests are ordinary `#[wasm_bindgen_test] async fn`s.]**

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
- [x] Step 4b-1 (storage + search on real SQLite, decision 2.2/2.2.1) -- **done** (2026-10-05,
      on a fresh machine, toolchain pinned to rustc 1.98.1 / Node 24.21.0 / wasm-pack 0.15.0).
      `dumpy`, `clouseau`, `storage.rs`, `search.rs` now compile from the **same source on every
      target**: `rusqlite` went 0.20 → 0.40.2 (its default `ffi-sqlite-wasm-rs` feature swaps in
      `sqlite-wasm-rs` 0.5.5 on wasm32; `libsqlite3-sys` 0.16 → 0.38.2 natively), the only API
      migration being the removed `NO_PARAMS` → `[]`. Deleted `storage_wasm.rs` and
      `search_wasm.rs` (≈215 lines of stubs) and their `#[path]` swaps; un-gated the dumpy/
      clouseau/rusqlite error conversions in `error.rs`; moved the three crates out of the
      native-only dependency table. FTS4 enabled in the wasm SQLite via `.cargo/config.toml`
      (2.2.1). `time` 0.1 has no clock on wasm32 (`get_time()` is `unimplemented!()`), which
      broke model-ID generation, so `util::get_time()` reads `Date.now()` there and calls
      `time::get_time()` natively (used by `models/model.rs` and `sync/sync_model.rs`).

      **Verified (both targets, same tests):**
      - native: `turtl_core` 63/63, `dumpy` 6/6, `clouseau` 3/3, `jedi` 3/3 -- `dumpy`'s tests
        had not compiled since the toolchain drift (plain `cargo test` at the root only runs
        `turtl_core`), so this is their first green run.
      - wasm32 (real wasm in Node): `dumpy` 6/6, `clouseau` 3/3, `turtl_core` 9/9 -- 2 search
        tests (FTS4 incl. `OR`/phrase syntax, intersect/union filters, paging, tag counts),
        4 storage tests including **two end-to-end encrypted-model round trips** (model ID from
        `Date.now()`, key from libsodium.js randomness, libsodium.js encrypt, real SQLite save,
        load, decrypt), and the 3 earlier crypto parity tests.
      - Re-verified unchanged on the new machine before editing: crypto PoC 11/11 byte-exact +
        tamper checks; the earlier wasm32 crypto tests.

      ```bash
      cd core/turtl-core-rs
      cargo test --features sqlite-static -p turtl_core -p dumpy -p clouseau -p jedi
      NODE_PATH="$(pwd)/node_modules" wasm-pack test --node   # turtl_core on wasm32
      wasm-pack test --node dumpy; wasm-pack test --node clouseau
      ```

      **Known limits / follow-ups from this step:** (a) wasm32 uses the default **in-memory**
      VFS -- nothing persists; OPFS-SAHPool needs a Worker + browser tests (see 2.2.1). (b)
      `config::load_config()` reads `config.yaml` from a file, so the non-test
      `storage::db_location()` path can't work on wasm32 until config is injected from JS. (c)
      `util/logger.rs` still calls `time::now()` (panics on wasm32); only matters once logger
      setup runs there. (d) `wasm-pack build` (not `test`) fails if the crate-root
      `package.json` has a `dependencies` object: wasm-bindgen copies it into `pkg/package.json`
      and wasm-pack 0.15.0 parses that file as a flat string map (`invalid type: map, expected a
      string`). `core/wasm-crypto-poc/package.json` is therefore *deliberately* a bare map, so
      `npm ci` installs nothing there -- use `npm install --no-save --no-package-lock
      libsodium-wrappers@0.7.16`. **Resolved for `core/turtl-core-rs` in Step 4b-4:** its production
      build has no JS snippets (libsodium is injected), so wasm-bindgen never reads that
      `package.json` (verified: `wasm-pack build --target web` succeeds with it); only the PoC,
      which does ship a snippet, still needs the bare-map workaround. (e) Every native `cargo test` of `turtl_core` rewrites the tracked
      `core/wasm-crypto-poc/test/golden_vectors.json` (`generate_wasm_golden_vectors`); `git
      checkout` it before committing.
- [x] Step 4b-2: async networking (decision 2.3) -- **done (2026-10-05)**, in three commits. The
      design was chosen the same day, after research (options were put to the user; all three recommended ones taken):
      (1) move `turtl_core` to **edition 2018** and write real `async fn`/`.await`; (2) **native keeps
      its threads**: thread-per-message and the four sync threads stay, each driving its async fn to
      completion with `block_on` on one shared tokio runtime (so futures need not be `Send`), while
      wasm drives the same fns with `spawn_local`; (3) **scope**: the JSON API, user flows, sync
      engine, dispatch and the space/invite APIs; **file attachments stay native-only** (stubbed on
      wasm) because they stream to the filesystem and need a browser file-storage backend, which
      belongs with persistence (4b-5b). (Done after that: the backend is a table of the user's
      database, see "Attachments" under Step 5.)

      Research behind it: the HTTP layer is small (`api.rs` is 298 lines with one blocking choke
      point, `ApiCaller::call`; about 40 call sites in a dozen files, mostly `models/user.rs`); the
      sync engine is four polling loops (`run_sync()`, sleep, repeat) and dispatch is a thread per
      message, both of which map directly onto async tasks. reqwest 0.13.5's wasm backend binds the
      *global* `fetch` (not `window.fetch`) and was verified under Node against a real local server
      (GET with a custom header, POST with an auth header and JSON body, readable error status and
      body, per-request timeout), so networking can be tested on wasm without a browser; native async
      reqwest 0.13 compiles here. Sub-steps, each its own commit:
      - [x] **4b-2a: edition 2018** (done). 339 occurrences in 41 files of a 2015-style path to one of
        the crate's own modules (`::models::..`) became `crate::models::..` (one regex over the 13
        top-level module names); the 16 serde attribute strings (`"::util::ser::.."`) and the 16
        crate-local paths `protected_derive` emits got the same treatment; the derive hands syn 0.11
        its input with `crate ::` respelled `::` (syn 0.11 predates `crate::` paths, and the derive
        never re-emits field types); two anonymous trait parameters got `_:`; one root call became
        `crate::init(..)`. **`cargo fix --edition` does not work on this crate**: it rewrites paths
        inside serde attribute strings into invalid syntax (`crate::"::util::.."`), after which the
        derive chokes and everything cascades (that cascade is the old "~600 errors"). Verified:
        native `turtl_core` 68/68, `dumpy` 6, `clouseau` 3, `jedi` 3; wasm32 36/36, `dumpy` 6,
        `clouseau` 3; the production `--target web` build and its smoke test.
      - [x] **4b-2b: the async `Api`** (done). `api.rs` is one implementation for both targets
        (reqwest 0.13: hyper plus the OS TLS natively, the fetch backend on wasm32); `api_wasm.rs`
        and the wasm-only `http` dependency are gone, and `reqwest::Error` converts into `TError` on
        both targets. The builder API is unchanged apart from three things: the unused `query`/
        `form` were dropped, `header()` records a bad header and reports it when the call is made,
        and `set_auth_headers` became `auth_header()`. Calls are `call_async()`/`call_opt_async()`;
        until their callers are async there is a *temporary* blocking `call()`/`call_opt()` bridge
        (native: `block_on`; wasm32: `NotImplemented`), so every commit still builds. Requests get
        the 30 s default timeout reqwest's old blocking client had, set per request. A new
        `Api::set_endpoint()` lets tests and embedders without a config file bypass `api.endpoint`.
        `util/exec.rs` holds the one place the targets differ: `block_on` on a shared two-worker
        tokio runtime natively, `spawn_local` and a JS-timer `sleep` on wasm32.

        **Verified:** one scenario suite (GET; the Basic auth header on and off; a JSON POST with a
        custom header; a raw body; a failing status keeping its JSON body, and a plain-text one;
        a successful status with a non-JSON body; a per-request timeout, asserted through
        `reqwest::Error::is_timeout()`; a bad header; a refused connection) runs *unchanged*
        against a thread-based mock server natively (`util/mock_server.rs`) and against a Node
        `http` server on wasm32 (`js/test_support.js`). Native `turtl_core` 70/70, wasm32 37/37,
        and the production `--target web` build (now 3.14 MB, about 0.2 MB more with reqwest's
        fetch backend) still passes its smoke test. Note that `TErr!` wraps errors, so callers
        (and tests) `shed()` an error before matching on it.

        Still temporary: native file upload reads the file into memory (the async body wants an
        owned body), and reqwest's `blocking` feature stays enabled for `sync/files/*` until 4b-2c
        converts them. Both reqwest versions are in the native tree until `clippo` and `migrate`
        (native-only, still on 0.10) move.
      - [x] **4b-2c: the callers are async** (done). Everything that touches the network is `async fn`
        all the way up: the user flows (`User::login/login_token/join/change_password/delete_account/
        resend_confirmation/find_by_email`, and on `Turtl`: `login`, `join`, `change_user_password`,
        `delete_account`, `sync_start`, `sync_shutdown`, `wipe_user_data`, `wipe_app_data`), the
        space/invite/member/feedback calls, `Syncer::{init, run_sync, runner}` with the four syncers,
        `sync::start()`, `process_incoming_sync`, and `dispatch::{dispatch, dispatch_event, process}`.
        The blocking `call()` bridge and reqwest's `blocking` feature are gone (`call_async` and
        `call_opt_async` became `call` and `call_opt`). Top-level tasks start with
        `exec::spawn_task` -- natively a thread that `block_on`s the future (so futures still need
        not be `Send`), on wasm32 `spawn_local` -- and hand back a `TaskHandle` whose `join()` is
        async on both targets (a `futures-channel` oneshot), so `sync_shutdown(join = true)` no
        longer parks a thread. `lib.rs` starts each message's `dispatch::process` that way, and
        `exec::catch_panic` (futures-util's `catch_unwind`) keeps `process` answering with a
        `TError::Panic` when a command panics (`exec::panic_message` reads `&str` payloads too, which
        the old code reported as "no information available").

        **The rule this adds: never hold a `std` lock guard across an `.await`** (spelled out in
        `util/exec.rs`). Natively that only ever blocked other threads for a network round trip, but
        every wasm32 task shares one thread, so a second task wanting the lock can never get in, and
        std's wasm locks answer with a panic. Following it changed some structure, not just
        signatures:
        - The `Space` operations (`set_owner`, `edit_member`, `delete_member`, `leave`,
          `send_invite`, `edit_invite`, `delete_invite`) are now static `async fn`s that take the
          space id and follow one pattern: check and prepare under the profile lock, make the request
          with nothing locked, lock again to apply the answer. They used to run with the profile
          write lock held for the whole request (a 30 s timeout froze the profile); `SpaceMember::
          edit`/`Invite::edit` return the saved record instead of writing into a `&mut` into the
          profile, and the `delete`s take ids. Each hands back the space's data for the UI.
        - `User::login` is a loop over auth versions (async recursion needs boxing; this doesn't).
          `User::change_password` is a static function in phases (read the user and keychain under
          read locks, send, then write the result), and its 3 s pause for the outgoing sync happens
          after the locks are released. `Feedback::send` drops the user lock before sending.
        - `Turtl.incoming_sync_lock` used to be held by `sync_start()` across its whole startup to
          keep incoming syncs from being applied before the profile loaded; now that is the
          `incoming_sync_held` flag (`hold_incoming_sync()` returns a guard that clears it), and
          `process_incoming_sync` waits for it to clear, taking the lock only while it applies an item.
        - `Turtl::sync_shutdown` is `sync_stop()` (synchronous: signal, take the task handles, mark
          disconnected; also what `logout` and `Drop` use) plus an async join.
        - `User::mem_update` for a deleted account can't await the wipe (it is synchronous and may
          run under locks), so like its sibling cases it sends an app event, `user:wipe-data`.
        - A long poll that times out is an empty poll again: `sync_from_api` matched
          `TError::Io(TimedOut)`, which a reqwest error never converts to, so every idle minute was
          logged as an error; it now asks `api::is_timeout`.

        With that, the sync engine is the same code on both targets: the `incoming_wasm.rs` stub is
        deleted, and `sync::start()` runs on wasm32 (minus the two file syncers, which stay native
        until 4b-5b).

        **Verified:** eight end-to-end scenarios (`src/flow_tests.rs`) written once and run on both
        targets by `async_test!`: natively against `util/mock_server.rs`, on wasm32 against a stand-in
        Turtl server in Node (`startFlowServer` in `js/test_support.js`; the routes are listed at the
        top of the file and both servers implement them). They cover join and login (including the
        server's 401 and the encrypted user record round-tripping), the dispatcher (sync, API and
        failing commands through `process`), outgoing and incoming sync, `sync_start()` through
        `sync_shutdown(true)` with the real tasks (the outgoing syncer uploads the profile that
        joining queued), the incoming-sync hold, the space/invite operations (including that bad
        requests are refused before the server is asked) and a passphrase change. Also
        `exec`'s task/`join`/`sleep` tests on both targets and its panic tests natively. Native
        `turtl_core` 77/77, `dumpy` 6, `clouseau` 3, `jedi` 3; wasm32 47/47, `dumpy` 6, `clouseau` 3;
        `cargo build --release --features sqlite-static`; the production `--target web` build (3.29 MB)
        and its smoke test.

        **Still open when 4b-2c was done** (4b-3 below resolved most of it, 4b-5b and Step 5 the filesystem item):
        `lib.rs::start()` is still the native thread plus the blocking `carrier::recv` loop, so wasm has no message entry point yet
        (4b-3: push messages in, `spawn_local` the `process` call); `Thredder` is still the
        synchronous-inline placeholder on wasm; `init()` reads a config *file* (the wasm tests set the
        config by hand with `load_config(":null:")` + `merge`); anything that uses the filesystem
        (`wipe_*`, `save_login`/`restore_login`, attachments) is native-only until 4b-5b;
        `util/logger.rs` calls `time::now()`, which panics on wasm32.
- [x] Step 4b-3: the core as a service in a JS host (decision 2.4) -- **done (2026-10-05).** With
      4b-2 the networking, the sync engine and the dispatcher were already tasks that `spawn_local`
      can run, so what was left of "the concurrency rewrite" was the entry point: native's `start()`
      is a thread plus a blocking `carrier::recv` loop, which wasm32 cannot have. New
      `src/wasm_host.rs` is the wasm32 counterpart, with the **same wire protocol** (the
      `["<id>", "<command>", args..]` messages in, the `{id, e, d}` responses and `{e, d}` events out,
      on the same channel names), so the UI above it cannot tell the targets apart. The exports, in the
      order a host calls them (see the module docs for the contract):

      ```text
      await init({ module_or_path })   // wasm-bindgen's own loader
      await initWasmCrypto(sodium)     // libsodium.js injected (decision 2.1)
      initCore(configJson)             // built-in defaults, with the host's runtime config laid over them
      setMessageHandler((channel, message) => ..)
      startCore()                      // the core announces itself with the `messaging:ready` event
      sendMessage('["1","user:login","me@example.com","passphrase"]')
      stopCore()                       // or the `app:shutdown` command
      ```

      * **Transport.** Every message the core sends is handed to the registered handler as
        `(channel, message)` (`messaging::deliver`); every message the host sends becomes a task on
        the host's event loop (`spawn_local` of `dispatch::process`) instead of being read off a
        channel by a loop, and so do the core's own app events (`messaging::inbound`). With no
        handler registered, outgoing messages queue on the same in-process channels native uses and
        `pollMessage(msgId?)` / `pollEvent()` read them without blocking (native's `recv_nb` /
        `recv_event_nb`). Messages sent before `startCore()` are an error for the host, while a
        `Turtl` made directly (tests, embedders) keeps working: its app events just queue, as on native.
      * **Config and logging.** `crate::init` on wasm32 builds the config from a built-in JSON default
        (the config.yaml keys, with `data_folder` `:memory:` until 4b-5b, and the file syncers off)
        plus the host's runtime config, so no file is read; logging goes to the JS console at
        `logging.level` (default `warn`; `time::now()` and stdout don't work on this target). Native-only
        now, and compiled out: `start()`, the blocking `recv()`/`recv_event()`, the C API, the
        data-folder lockfile and the log-file rotation.
      * **`Thredder` stays inline on wasm32, on purpose.** Decision 2.4 puts the whole core in one
        Worker, where nothing runs in parallel anyway: CPU work (decrypting, scrypt) running inline
        costs the page nothing, because the page is not the thread running it. If it ever shows up as
        jank in the Worker's own responsiveness, the lever is a second Worker, not a pool.

      **Verified:** a wasm-bindgen test (`flow_tests::host`) drives the exports like a host would: the
      ready event, a ping answered on `inproc://turtl-req-core-out` with the exact native JSON, a
      `user:join` through crypto, `fetch` to the stand-in server and storage, the poll functions
      with no handler, `app:shutdown` and "not started" errors; and `js/web_smoke_test.mjs` now runs
      the same through the **production `--target web` package** from Node (3.17 MB). The package's
      JS surface is nine functions: `initCore`, `startCore`, `stopCore`, `sendMessage`,
      `setMessageHandler`, `pollMessage`, `pollEvent`, `initWasmCrypto`, `cryptoSelfTest`. The tests
      that make a `Turtl` directly now also run through the real `crate::init` on wasm32. Native
      `turtl_core` 80/80 (`dumpy` 6, `clouseau` 3, `jedi` 3), wasm32 48/48.

      **Left for later:** hosting the module in a dedicated Worker, with a `postMessage` bridge to the
      page, is the host's code (and arrives with OPFS persistence in 4b-5b, which needs the Worker
      anyway); the filesystem-bound features stay native-only until then.
- [x] Step 4b-4 (`wasm-pack build --target web`, with libsodium injected) -- **done**
      (2026-10-05), following the "inject libsodium" refinement under decision 2.1. New
      `src/crypto/wasm_sodium.rs` holds the whole mechanism: typed wasm-bindgen bindings for the ten
      libsodium.js functions the core calls, the injected object in a thread-local, and
      `initWasmCrypto(sodium)`. Init awaits `sodium.ready`, then refuses an object that lacks any of
      those functions with a message naming them and saying to pass the sumo build (so handing in
      the standard `libsodium-wrappers` fails at startup, not inside a login); a failed init leaves
      a previously injected libsodium in place. `low.rs`'s wasm twins now call `with_sodium(..)`;
      `js/sodium_bridge.js` and the `wasm_bridge` module are gone, so the crate has no production
      JS. The AEAD twins also now validate key/nonce lengths like native (they used to surface
      libsodium.js's error as `OperationFailed` where native gives `BadData`).

      `cryptoSelfTest()` is a second export: a fast known-answer check (`crypto/selftest.rs`:
      FIPS 180 SHA, the RFC 8439 ChaCha20-Poly1305 vector, HMAC, scrypt, a sealed box made by the
      original JS client, `secure_compare`, random) that hosts can run at startup to assert the
      injected libsodium is the right build. The same function is a native unit test, which
      independently validates its expected values against sodiumoxide (the RFC vector was recalled
      from the standard, then matched against libsodium in two builds before being embedded).

      **Verified:** native `turtl_core` 68/68; wasm32 36/36 (+2 self-test, +2 init-rejection
      tests, with `js/test_support.js` playing the host) against libsodium.js **0.7.16 (libsodium
      1.0.20) and 0.8.4 (1.0.22)**, so injection is version-agnostic in practice. The production
      `wasm-pack build --target web` takes about 2.5 minutes and gives a 2.9 MB wasm (after
      `wasm-opt`, SQLite included) and 28 KB of glue; the generated `.d.ts` shows the entire JS API
      of the core today is `initWasmCrypto(sodium)`, `cryptoSelfTest()` and the loader. The
      documented smoke test loads it as an ES module in Node and checks that the package has no
      snippets and its glue loads no modules, that crypto before injection fails clearly, that bad
      injections are rejected with named problems, that the real thing passes the self-test, that
      a failed re-init keeps the working libsodium, and that re-init is harmless:

      ```bash
      cd core/turtl-core-rs
      wasm-pack build --target web && node js/web_smoke_test.mjs
      ```

      The same core also works from `--target nodejs` (CommonJS) with the same injection (checked
      ad hoc, 35 s build), which is the module-system independence the design was chosen for.
      **Not verified:** `--target bundler` (needs a bundler) and a real browser (Vite + headless
      Chrome); that comes with the persistence step, which needs a browser anyway.

      **Packaging note for the web app:** `libsodium-wrappers-sumo` **0.7.x** cannot be imported as
      an ES module at all (its `.mjs` entry imports `./libsodium-sumo.mjs`, a file that exists only
      in the sibling `libsodium-sumo` package), so a bundler would need an alias. **0.8.x fixes it**
      (the entry imports the bare `libsodium-sumo` and ships TypeScript types). This crate's npm
      dependency, used only by the tests and the smoke test, is now `^0.8.4`; the CommonJS entry
      works in both.
- [x] Step 4b-5a (the remaining crypto surface) -- **done** (2026-10-05). `sha256`/`sha512`,
      `hmac` (HMAC-SHA512-256 via `crypto_auth`), `secure_compare`, `random_salt`, `gen_key`
      (**scrypt**), and `asym::{keygen,encrypt,decrypt}` (sealed boxes) now run for real on wasm32
      through the same libsodium.js bridge as the AEAD hot path, so no `NotImplemented` crypto
      stub is left. `gen_key` is what turns a user's passphrase into the master key that decrypts
      everything synced from other clients, so byte-identical scrypt output was non-negotiable:
      verified two ways, see below. The bridge moved from `libsodium-wrappers` to
      **`libsodium-wrappers-sumo`** 0.7.16 (libsodium 1.0.20): the standard build has no password
      hashing at all (no scrypt, no Argon2) and no explicit `crypto_hash_sha512`, while sumo is a
      strict superset with the same API and `sodium.ready` init, for about +0.7 MB of wasm (2.0 MB
      vs 1.3 MB on disk). Sumo's scrypt reports the same `INTERACTIVE` limits native uses
      (`OPSLIMIT` 524288 / `MEMLIMIT` 16777216). Lengths (hmac key, scrypt salt, box keys) are
      validated in Rust before the bridge so bad input gives native's `BadData` errors rather than
      libsodium.js's differently-worded exceptions; `secure_compare` is the same double-hmac as
      native with the throwaway key from `rand_bytes()`.

      **Verification -- the crate's own known-answer tests run on both targets.** Rather than
      inventing new vectors, a crate-wide `crypto_test!` macro (crypto/mod.rs) turns an existing
      test into a plain `#[test]` natively and, on wasm32, a `wasm-bindgen-test` that first awaits
      the one-time libsodium.js init. 20 existing tests were converted mechanically (bodies
      unchanged) and 3 added: the FIPS 180 SHA vectors (an anchor from outside this project),
      error-kind parity for bad lengths / a box that won't open, and `random_salt`. The expected
      values are the original Turtl authors', several validated against their JS client: SHA-256/
      512, HMAC, **two scrypt key derivations**, the AEAD envelopes, and a sealed box produced by
      the JS client's libsodium.js. Result: wasm32 **32/32**, native `turtl_core` **66/66**
      (`dumpy` 6, `clouseau` 3, `jedi` 3 unchanged). A Node pre-flight against the bare package
      matched both scrypt answers before any Rust was written, and a mutation check shows the
      assertions bite on wasm: changing the wasm-only `KEYGEN_OPS_DEFAULT` to 1048576 (which
      doubles scrypt's `p`) makes exactly the two scrypt tests fail. (Nudging it to 524289 does
      *not*: scrypt quantizes its cost parameters, so that mutation is equivalent.)
- [x] Step 4b-5b: persistence (OPFS-SAHPool in a dedicated Worker, browser-tested) -- **done
      (2026-10-05)**; note attachments, the part this step left open, followed the same day (below).
      * **The VFS.** `sqlite-wasm-rs` 0.5.x (the line rusqlite 0.40 uses) carries no OPFS VFS; it lives
        in the separate `sqlite-wasm-vfs` crate, and **0.2.x is the line built against `sqlite-wasm-rs`
        0.5 and its `rsqlite-vfs` 0.1** (0.3.x pairs with `sqlite-wasm-rs` 0.6, which would put two
        SQLites in the binary). Adding it brought `tokio` (just `sync`) into the wasm graph, where
        Cargo's old feature resolver then merged in the native-only `tokio/net` and mio refused to
        build; the workspace is now on `resolver = "2"`, which keeps target-specific features apart.
      * **The host API.** `await enablePersistence(directory?)` (src/wasm_host.rs), in the Worker the
        core runs in, after `initWasmCrypto` and before `initCore`, installs the `opfs-sahpool` VFS as
        SQLite's default and keeps the databases in that OPFS directory (default `turtl-core`; the pool
        holds 16 files and does not grow). `data_folder` becomes the folder name inside it (default
        `turtl`) and is what `storage::db_location` already builds paths from, so nothing else in the
        core changed to use it. `startCore()` refuses a `data_folder` with no persistence behind it,
        because that would silently keep the data in memory. The pool is held by one worker at a time:
        a worker that is being replaced (a reload) gets three seconds to let go; a live second tab is
        told "in use by another tab or worker". (The pool never closes handles after a partial
        failure, so only the "handle is busy" error is retried.) Multi-tab sharing would be the
        pool's pause/unpause handshake, not done.
      * **Wipes.** `storage::delete_db` / `delete_all_dbs` replace the `fs` calls in
        `Turtl::wipe_user_data` / `wipe_app_data` (native: the same `fs` calls; wasm32: the pool), and
        `FileData::file_finder_all` is empty on wasm32.
      * **Browser tests.** Node has no OPFS, so `js/browser_test.mjs` runs the production package in a
        dedicated Worker in headless Chromium (js/browser/: `core_worker.js` is the reference Worker,
        `core_client.js` the page's side). Setup needs no root: `scripts/setup-browser-tests.sh`
        installs Playwright's headless shell and the few system libraries it lacks (fetched with
        `apt-get download`, unpacked under `~/.cache/turtlzim-browser-libs`). Scenarios: the basics
        (join, logout, bad login, login, profile) in a Worker; **persistence** (join, sync, reload
        the Worker, log in, and the same three spaces and boards come back from OPFS) with an
        in-memory **control** (the same flow, nothing comes back, so the first would notice if
        persistence did nothing); a `data_folder` with no persistence is refused; a second worker on
        the same directory is refused until the first is gone; and wiping a user's and then all
        data. Native `turtl_core` 80/80, wasm32 (Node) 48/48, browser 6/6, the production smoke test.
      * **Not this step's:** the Worker bridge for the page is the app's: `core_worker.js` /
        `core_client.js` are the reference for it. (Attachments: see Step 5.)
- [x] Step 5: full parity pass -- **done (2026-10-05)**, attachments included (below). "Parity" is
      checked layer by layer, each by the *same* test code on both targets:

      | Layer | Evidence |
      |---|---|
      | Crypto primitives | known-answer tests, and golden vectors made by native that wasm32 reproduces byte for byte in both directions (step 4b-5a) |
      | **Whole accounts** | `src/interop_tests.rs` + `test-fixtures/`: an account made by the native build and one made by the wasm32 build (user record, auth token, keychain, spaces, boards, a note: what a server would store), each read by native, by wasm32 under Node and by the production package in a Chromium Worker: passphrase to key (the auth token must come out equal), user record, the key-unwrapping chain down to the note, the sync-record ingestion, and full-text search over the decrypted note |
      | Storage and search | `dumpy`, `clouseau`, `storage`, `search` tests, unchanged, on both |
      | Networking | the `Api` scenarios, one suite, both servers (step 4b-2b) |
      | Flows | join, login, dispatcher, outgoing and incoming sync, the sync engine, the incoming hold, space operations, passphrase change, saved login, attachments (one device uploads a note's file, another downloads and decrypts it): `src/flow_tests.rs` |
      | Persistence | OPFS in a real browser (step 4b-5b): survives a reload, the in-memory control doesn't, wipes, a second tab is refused |

      The fixtures are made once and checked in; `TURTL_WRITE_FIXTURES=1` on either target
      regenerates its own file (the commands are in the module docs). Final counts: native
      `turtl_core` 84, `dumpy` 6, `clouseau` 3, `jedi` 3; wasm32 under Node 52, `dumpy` 6, `clouseau`
      3; browser 8 scenarios; the production smoke test; the native release build.

      **The deliberate differences** (the wire protocol and every command that exists on both are the
      same; these are where the platforms differ, each with the reason):

      | | Native | wasm32 |
      |---|---|---|
      | Entry points | `start()`, `send()`, `recv*()`, the C API / JNI | `initCore`, `startCore`, `sendMessage`, `setMessageHandler`, `pollMessage`, `pollEvent`, `stopCore`, `enablePersistence` (no thread to block on) |
      | Config | `config.yaml` plus runtime JSON | built-in defaults plus runtime JSON (no file) |
      | Logging | stdout and a rotated log file, readable with `app:get-log` | the JS console; `app:get-log` answers with an error |
      | Concurrency | a thread per message and per sync loop, `Thredder` on a thread pool | tasks on one thread in a Worker, `Thredder` inline (decision 2.4) |
      | Databases | SQLite files in `data_folder` | in memory, or OPFS after `enablePersistence` |
      | Saved login (`user:save-login`) | `<data_folder>/<user_id>.login` | the kv store, `login:<user_id>` |
      | `api.proxy`, `api.allow_invalid_ssl` | honoured | the browser decides; ignored |
      | Data-folder lockfile | `fs2` lock | none: one core per Worker, and the OPFS pool has one holder |
      | Web clipper (`clip`) | `clippo` | `NotImplemented` |
      | Import from Turtl 0.6 (`user:can-migrate`, `user:join-migrate`, `user:migrate-auth-debug`) | `migrate` crate | `can-migrate` says no, the others `NotImplemented` |
      | Note attachments (`file` on a note, `profile:note:get-file`, the two file sync loops) | one encrypted file per note in the files folder | one row per note in a table of the user's database (so they persist and are wiped with it); the sync loops run unchanged on top, and a download is held in memory until it is whole |

      **Attachments** (added after the rest of this step): all file I/O of `FileData` and the two file
      sync loops goes through `FileData::store_put/get/delete`, which are the same filesystem calls as
      before natively and `Storage::attachment_*` (a lazily created `attachments` table: `user_id`,
      `note_id`, `data` BLOB) on wasm32. The loops now run on both targets (the proxy setting is the one
      native-only line, and a download takes the whole body with `bytes()` because reqwest's wasm
      `Response` has no `chunk()`, which also means a download that fails halfway leaves nothing
      behind). The stand-in servers learned `PUT /notes/<id>/attachment`, `GET /notes/<id>/attachment`
      (the URL to fetch) and `GET /notes/<id>/file` (binary-safe in both). **Verified** by one flow, run
      natively and on wasm32: a note with a (non-text) file is saved, read back, uploaded by the file
      loop, forgotten by the first device, and a second device that learns of it from the server
      downloads it and decrypts it to the original bytes; plus the same save, read and upload in the
      browser Worker, and a storage test of the blob helpers. Now: native `turtl_core` 86, wasm32 under
      Node 54, browser 9 scenarios.

- [x] **The core in the web app, with no server** (`local_only`): the app runs this core in a module
      Worker (`web/src/vault`) to keep encrypted notebooks, with libsodium.js injected exactly as
      step 4b prescribes and the databases in OPFS. What that needed of the core: accounts that live on
      one device (`models/user.rs`: `join_local`, `login_local`, the account's record in the kv
      store, a key made at 128 MiB because there is no server to slow guessing down), a user id that
      is a number JavaScript reads exactly, no sync and no queue, **atomic writes** (every dumpy
      write is a savepoint: one commit, and nested inside a caller's transaction) and **batches**
      (`profile:batch:begin|commit|rollback`, whose rollback rebuilds the in-memory profile and
      search index), a private `props` field on notes. Verified by `flow_tests::local_only_flow`,
      `local_only_on_disk_flow` (native: every file the core writes is read for plaintext) and
      `local_batches_flow`, native and wasm32, and in Chromium by `web/test/vault-browser.mjs`
      (persistence across reloads, a write cut off by killing the Worker at five different moments,
      one tab at a time, a Worker that was cut off from the network, the browser's own log of the
      requests the engine makes). What an independent review of this work found, and what was done
      about it (the core refuses everything but a short list of commands and the network itself,
      the engine has a heartbeat and a watchdog, locking works whatever else fails), is in
      `docs/zim-encrypted-notebooks.md`. Now: native `turtl_core` 95, wasm32 under Node 61.
