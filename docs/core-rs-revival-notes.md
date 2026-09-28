# Reviving `core-rs` — notes

Turtl's Rust core, vendored at `core/turtl-core-rs` via `git subtree add --squash`
from `https://github.com/turtl/core-rs` (`master`, last upstream commit 2020-11-20).
GPL-3.0, same as this product (see CLAUDE.md's locked decisions).

CLAUDE.md's open issue #3 flagged this as a real risk ("Turtl is dormant... budget
time just to get everything building"). In practice the gap turned out to be much
smaller than feared: the crate's original, unmodified dependency versions still
compile against current Rust — the blockers were a handful of narrow, concrete
things, all now fixed. `cargo build --release --features sqlite-static` and
`cargo test --features sqlite-static` are both clean (62/62 tests passing,
including the crypto encrypt/decrypt round-trip and local SQLite storage tests
this revival needed to confirm).

## What was actually needed

1. **System packages** (not vendored, install locally): `pkg-config`,
   `libssl-dev`, `libsodium-dev`. `libsqlite3-dev` is *not* needed — build with
   the crate's own `sqlite-static` feature, which bundles/compiles SQLite from
   source instead of linking the system library.

2. **`cargo update`** (no manual version pins edited). The frozen `Cargo.lock`
   pinned an `openssl-sys` version predating OpenSSL 3.x header support; this
   system only has OpenSSL 3.5.5, and the crate's own build script couldn't
   parse its headers. Every direct dependency in `core/turtl-core-rs/Cargo.toml`
   already uses a caret range (e.g. `reqwest = "0.10.4"`), so `cargo update`
   re-resolves everything to the newest version still satisfying those existing
   ranges — no `Cargo.toml` edits, no major-version bumps. This alone fixed the
   OpenSSL incompatibility.

3. **One macro-ordering fix** in `src/models/protected.rs`: the `protected!`
   macro_rules expanded `$(#[$struct_meta])*` (carrying the user's
   `#[protected_modeltype(...)]` helper attribute) *before* the
   `#[derive(Protected)]` that introduces that helper attribute. This exact
   ordering was tolerated by old rustc but is now a hard error
   (`legacy_derive_helpers`). Fix: emit `#[derive(Protected)]` first. See the
   comment at the fix site.

4. **Two `rusqlite` API-drift fixes**, both in `src/storage.rs`'s own
   `#[cfg(test)]` module (not production code): `Row::get_checked` was renamed
   to `get`, and an untyped empty `&[]` param list no longer type-infers —
   replaced with `rusqlite::NO_PARAMS`. See the comment at the fix site.

5. **`config.yaml`**: copy `config.yaml.default` → `config.yaml` before running
   (gitignored by the vendored crate's own `.gitignore`, matching upstream's own
   CI setup in `.circleci/prepare-config.sh`). Several unit tests
   (`turtl::tests::*`, `models::file::tests::*`, `models::keychain::tests::*`)
   call `config::load_config()` and fail with a missing-file error without it —
   this is config, not a code bug.

## Building it

```bash
cd core/turtl-core-rs
cp config.yaml.default config.yaml   # first time only; gitignored
cargo build --release --features sqlite-static
cargo test --features sqlite-static
```

This crate is its own Cargo workspace (it has several path-dependency member
crates: `carrier`, `clippo`, `clouseau`, `dumpy`, `jedi`, `migrate`), so it's
excluded from — not a member of — the repo's root workspace (root `Cargo.toml`).
Build/test it from inside `core/turtl-core-rs`, not from the repo root.

## Known gaps / not yet done

- **19 lint warnings** remain (dead code, deprecated bare `extern fn` without an
  explicit ABI, a couple of no-op `.clone()` calls, unused imports). None are
  correctness issues; left as-is for now rather than churning a vendored tree
  beyond what's needed.
- `html5ever v0.24.1` (a transitive dependency) triggers a `future-incompatible`
  notice — worth watching, not urgent.
- **`integration-tests/`** (the sub-project that exercises real client↔server
  sync against a live Turtl `server` instance) was not run — that needs the
  sync server up first, which is a separate roadmap step.
- **WASM port** (CLAUDE.md open issue #2: swapping native libsodium → wasm,
  `rusqlite` → IndexedDB, blocking `reqwest` → `fetch`) has not been started.
  This revival only proves the *native* build and its crypto/storage round-trip;
  the WASM port is materially harder and is its own future task.
- No changes were made to bring the crate onto newer major dependency versions
  (e.g. `futures 0.1`, `reqwest 0.10`) — it still builds against its original
  dependency *majors*, just re-resolved to their newest compatible patch/minor
  releases. A deeper modernization (async/await, `reqwest` 0.11+, etc.) is
  possible later but wasn't needed just to get it building and passing tests.
