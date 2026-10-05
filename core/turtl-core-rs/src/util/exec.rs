//! Driving async code. The core's `async fn`s are the same on every target; what differs is who
//! polls them (docs/wasm-port-plan.md decisions 2.3 and 2.4).
//!
//! * **native:** the core keeps its threads (one per message, one per sync loop). Each such thread
//!   `block_on`s its top-level future, so a future is only ever polled by the thread that owns it
//!   and never has to be `Send`. A small shared multi-threaded tokio runtime supplies the I/O and
//!   timer drivers that reqwest needs. `block_on` panics if it is called from inside a future that
//!   is itself being driven by `block_on` (tokio forbids nested runtimes): convert such a caller to
//!   async instead of nesting.
//! * **wasm32:** there are no threads to block. Top-level tasks are handed to the host's event loop
//!   with `spawn_local`, and `sleep` is a JS timer.
//!
//! Either way `sleep` is `async`: it yields instead of parking a thread. The older, blocking
//! `util::sleep` stays for code that has not been converted yet.

// (`sleep` and, on wasm32, everything here gets its first callers with the async sync loops and
// dispatch, which is why these items are allowed to be unused for now.)
#[cfg(not(target_arch = "wasm32"))]
pub use self::native::*;
#[cfg(target_arch = "wasm32")]
#[allow(unused_imports)]
pub use self::wasm::*;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use ::std::future::Future;
    use ::std::time::Duration;
    use ::tokio::runtime::{Builder, Runtime};

    lazy_static! {
        /// The one runtime every `block_on` shares. It does no work of its own here, apart from
        /// running reqwest's connection tasks and timers while the calling threads wait.
        static ref RUNTIME: Runtime = Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("turtl-io")
            .enable_all()
            .build()
            .expect("util::exec -- failed to start the async runtime");
    }

    /// Run `future` to completion on the calling thread, blocking it. Many threads may do this at
    /// once.
    pub fn block_on<F: Future>(future: F) -> F::Output {
        RUNTIME.block_on(future)
    }

    /// Wait `millis` milliseconds without blocking the thread.
    #[allow(dead_code)]
    pub async fn sleep(millis: u64) {
        ::tokio::time::sleep(Duration::from_millis(millis)).await
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use ::std::future::Future;
    use ::js_sys::{Function, Promise, Reflect};
    use ::wasm_bindgen::{JsCast, JsValue};
    use ::wasm_bindgen_futures::JsFuture;

    /// Hand a top-level task to the host's event loop.
    #[allow(dead_code)]
    pub fn spawn_local<F: Future<Output = ()> + 'static>(future: F) {
        ::wasm_bindgen_futures::spawn_local(future)
    }

    /// Wait `millis` milliseconds on a JS timer (`setTimeout` exists in browsers, workers and Node).
    #[allow(dead_code)]
    pub async fn sleep(millis: u64) {
        let promise = Promise::new(&mut |resolve, _reject| {
            let set_timeout: Function = Reflect::get(&::js_sys::global(), &JsValue::from_str("setTimeout"))
                .expect("util::exec::sleep() -- no global setTimeout")
                .unchecked_into();
            set_timeout
                .call2(&JsValue::NULL, &resolve, &JsValue::from_f64(millis as f64))
                .expect("util::exec::sleep() -- setTimeout failed");
        });
        let _ = JsFuture::from(promise).await;
    }
}
