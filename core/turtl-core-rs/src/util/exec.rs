//! Driving async code. The core's `async fn`s are the same on every target; what differs is who
//! polls them (docs/wasm-port-plan.md decisions 2.3 and 2.4).
//!
//! * **native:** the core keeps its threads (one per message, one per sync loop). Each such thread
//!   `block_on`s its top-level future, so a future is only ever polled by the thread that owns it
//!   and never has to be `Send`. A small shared multi-threaded tokio runtime supplies the I/O and
//!   timer drivers that reqwest needs. `block_on` panics if it is called from inside a future that
//!   is itself being driven by `block_on` (tokio forbids nested runtimes): top-level tasks are
//!   started with `spawn_task`, everything below them is `async` and `.await`s.
//! * **wasm32:** there are no threads to block. Top-level tasks are handed to the host's event loop
//!   with `spawn_local`, and `sleep` is a JS timer.
//!
//! Either way `sleep` is `async`: it yields instead of parking a thread.
//!
//! # The one rule for async code in the core
//!
//! **Never hold a `std` lock guard (`lock!`, `lockr!`, `lockw!`) across an `.await`.** Natively it
//! would merely block other threads for the length of a network round trip, but on wasm32 every
//! task shares one thread: a second task that wants the lock while the first is parked at its
//! `.await` can never be let in, and std's wasm locks answer that with a panic. So async code locks,
//! does its synchronous work, drops the guard, and only then awaits (see `Space::send_invite` for the
//! usual shape: check under the lock, make the request without it, apply the response under the lock).

use ::std::any::Any;
use ::std::future::Future;
use ::std::panic::AssertUnwindSafe;
use ::futures_channel::oneshot;
use ::futures_util::FutureExt;
use crate::error::{TResult, TError};

#[cfg(not(target_arch = "wasm32"))]
pub use self::native::*;
#[cfg(target_arch = "wasm32")]
pub use self::wasm::*;

/// Run a future to completion, turning a panic inside it into an `Err` carrying the panic payload:
/// the async twin of `std::panic::catch_unwind`. (On wasm32 panics abort the module, so there it
/// never returns an `Err`.)
pub fn catch_panic<F: Future>(future: F) -> impl Future<Output = Result<F::Output, Box<dyn Any + Send>>> {
    AssertUnwindSafe(future).catch_unwind()
}

/// The message a panic carried (`panic!("literal")` carries a `&str`, a formatted one a `String`).
pub fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(msg) = payload.downcast_ref::<&str>() {
        String::from(*msg)
    } else if let Some(msg) = payload.downcast_ref::<String>() {
        msg.clone()
    } else {
        String::from("no information available")
    }
}

/// A handle on a task started with `spawn_task`. Dropping it detaches the task.
pub struct TaskHandle {
    name: String,
    /// Fires when the task's future has run to completion; closed without a value if it never did
    /// (it panicked, or was dropped by the host).
    done: oneshot::Receiver<()>,
    #[cfg(not(target_arch = "wasm32"))]
    thread: ::std::thread::JoinHandle<()>,
}

impl TaskHandle {
    /// Wait for the task to finish. This yields instead of blocking, so it is safe to await from
    /// any task on either target.
    pub async fn join(self) -> TResult<()> {
        let finished = self.done.await.is_ok();
        // the thread has finished, or is just about to: this only reaps it (and recovers the panic
        // message, if there was one)
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Err(panic) = self.thread.join() {
                return TErr!(TError::Msg(format!("task `{}` panicked: {}", self.name, panic_message(&*panic))));
            }
        }
        if finished {
            Ok(())
        } else {
            TErr!(TError::Msg(format!("task `{}` ended without finishing", self.name)))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use ::std::future::Future;
    use ::std::thread;
    use ::std::time::Duration;
    use ::futures_channel::oneshot;
    use ::tokio::runtime::{Builder, Runtime};
    use crate::error::TResult;
    use super::TaskHandle;

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
    /// once. Do not call this from inside a future that is already being driven by `block_on`.
    pub fn block_on<F: Future>(future: F) -> F::Output {
        RUNTIME.block_on(future)
    }

    /// Start a top-level task on a thread of its own, which `block_on`s the future that `make`
    /// builds. (`make` runs on the new thread, so the future it returns does not have to be `Send`.)
    pub fn spawn_task<F, Fut>(name: &str, make: F) -> TResult<TaskHandle>
        where F: FnOnce() -> Fut + Send + 'static,
              Fut: Future<Output = ()> + 'static
    {
        let (done_tx, done_rx) = oneshot::channel();
        let thread = thread::Builder::new().name(String::from(name)).spawn(move || {
            block_on(make());
            let _ = done_tx.send(());
        })?;
        Ok(TaskHandle { name: String::from(name), done: done_rx, thread: thread })
    }

    /// Wait `millis` milliseconds without blocking the thread.
    pub async fn sleep(millis: u64) {
        ::tokio::time::sleep(Duration::from_millis(millis)).await
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use ::std::future::Future;
    use ::futures_channel::oneshot;
    use ::js_sys::{Function, Promise, Reflect};
    use ::wasm_bindgen::{JsCast, JsValue};
    use ::wasm_bindgen_futures::JsFuture;
    use crate::error::TResult;
    use super::TaskHandle;

    /// Start a top-level task: hand the future that `make` builds to the host's event loop. (The
    /// bounds are the same as on native so that code compiles identically on both targets.)
    pub fn spawn_task<F, Fut>(name: &str, make: F) -> TResult<TaskHandle>
        where F: FnOnce() -> Fut + Send + 'static,
              Fut: Future<Output = ()> + 'static
    {
        let (done_tx, done_rx) = oneshot::channel();
        ::wasm_bindgen_futures::spawn_local(async move {
            make().await;
            let _ = done_tx.send(());
        });
        Ok(TaskHandle { name: String::from(name), done: done_rx })
    }

    /// Wait `millis` milliseconds on a JS timer (`setTimeout` exists in browsers, workers and Node).
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

#[cfg(test)]
mod tests {
    use super::*;
    use ::std::sync::Arc;
    use ::std::sync::atomic::{AtomicUsize, Ordering};

    /// Tasks run on their own, `sleep` really waits, and `join` returns once a task is done.
    async fn tasks_run_and_join() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..3 {
            let counter = counter.clone();
            handles.push(spawn_task("test-task", move || async move {
                sleep(20).await;
                counter.fetch_add(1, Ordering::SeqCst);
            }).unwrap());
        }
        for handle in handles {
            handle.join().await.unwrap();
        }
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }
    async_test!(tasks_run_and_join_test, tasks_run_and_join());

    /// A panic inside a future comes out as an `Err` carrying the panic message (wasm32 aborts on
    /// panics, so this can only be seen natively).
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn catch_panic_turns_panics_into_errors() {
        block_on(async {
            assert_eq!(catch_panic(async { 5 }).await.unwrap(), 5);
            let caught = catch_panic(async {
                if true { panic!("boom {}", 7); }
                5
            }).await;
            assert_eq!(panic_message(&*caught.unwrap_err()), "boom 7");
        });
    }

    /// A task that panicked is reported by `join`.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn join_reports_a_panicked_task() {
        block_on(async {
            let handle = spawn_task("doomed-task", || async { panic!("task down"); }).unwrap();
            let err = handle.join().await.unwrap_err();
            assert!(format!("{}", err).contains("doomed-task"), "{}", err);
        });
    }
}
