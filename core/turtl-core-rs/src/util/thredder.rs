//! Thredder is a wrapper around a cpu thread pooling implementation. It works
//! using promises.
//!
//! TODO(wasm): on `wasm32`, there's no OS-thread pool (`futures_cpupool::CpuPool` doesn't
//! support this target, and real multithreading needs the wasm threads proposal --
//! `SharedArrayBuffer`/`COOP`/`COEP`/a nightly atomics toolchain -- explicitly deferred, see
//! docs/wasm-port-plan.md decision 2.4). Until that's built (single-threaded async via
//! `wasm_bindgen_futures::spawn_local` inside one dedicated Web Worker, per the plan), this just
//! runs the closure synchronously, inline, on whatever thread calls it. That's a real behavior
//! difference from native (no backgrounding), but it's honest and correct -- not a silent no-op
//! or a fabricated result -- for every call site (models/file.rs, sync_model.rs, protected.rs)
//! that only cares about the *result*, not about it running off-thread.

use ::std::marker::Send;

use ::futures::Future;
#[cfg(not(target_arch = "wasm32"))]
use ::futures_cpupool::CpuPool;

use ::error::{TResult, TFutureResult};

/// Stores state information for a thread we've spawned.
pub struct Thredder {
    /// Our Thredder's name
    pub name: String,
    /// Stores the thread pooler for this Thredder
    #[cfg(not(target_arch = "wasm32"))]
    pool: CpuPool,
}

impl Thredder {
    /// Create a new thredder
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(name: &str, mut workers: u32) -> Thredder {
        if workers <= 0 {
            workers = 1;
        }
        Thredder {
            name: String::from(name),
            pool: CpuPool::new(workers as usize),
        }
    }
    /// Create a new thredder
    #[cfg(target_arch = "wasm32")]
    pub fn new(name: &str, _workers: u32) -> Thredder {
        Thredder {
            name: String::from(name),
        }
    }

    /// Run an operation on this pool, returning the Future to be waited on at
    /// a later time.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn run_async<F, T>(&self, run: F) -> TFutureResult<T>
        where T: Sync + Send + 'static,
              F: FnOnce() -> TResult<T> + Send + 'static
    {
        Box::new(self.pool.spawn_fn(run))
    }
    /// Run an operation on this pool, returning the Future to be waited on at
    /// a later time.
    #[cfg(target_arch = "wasm32")]
    pub fn run_async<F, T>(&self, run: F) -> TFutureResult<T>
        where T: Sync + Send + 'static,
              F: FnOnce() -> TResult<T> + Send + 'static
    {
        match run() {
            Ok(x) => Box::new(::futures::finished(x)),
            Err(e) => Box::new(::futures::failed(e)),
        }
    }

    /// Run an operation on this pool
    #[cfg(not(target_arch = "wasm32"))]
    pub fn run<F, T>(&self, run: F) -> TResult<T>
        where T: Sync + Send + 'static,
              F: FnOnce() -> TResult<T> + Send + 'static
    {
        self.pool.spawn_fn(run).wait()
    }
    /// Run an operation on this pool
    #[cfg(target_arch = "wasm32")]
    pub fn run<F, T>(&self, run: F) -> TResult<T>
        where T: Sync + Send + 'static,
              F: FnOnce() -> TResult<T> + Send + 'static
    {
        run()
    }
}

