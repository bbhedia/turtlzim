//! TODO(wasm): wasm32 stand-in for api.rs.
//!
//! The real `Api`/`ApiCaller` wrap reqwest's *blocking* client (`reqwest::blocking`), which
//! needs a tokio runtime + real OS threads -- neither exists on `wasm32-unknown-unknown` (see
//! docs/wasm-port-plan.md §1). The real fix is porting every call site to async `reqwest`
//! (which already resolves to a `fetch`-backed client on wasm32) -- decision 2.3, a separate
//! future milestone, not attempted here.
//!
//! `Method`/`StatusCode` are re-exported from the `http` crate directly here, which is the exact
//! same type reqwest's own `Method`/`StatusCode` re-export on native (`pub use
//! http::{Method, StatusCode}` in reqwest 0.10.x) -- so `TError::Api(StatusCode, ..)` and match
//! arms like `StatusCode::UNAUTHORIZED` in src/models/user.rs work unchanged on both targets,
//! not a look-alike duplicate type.
//!
//! Every `Api`/`ApiCaller` method that would make a real network call returns
//! `TError::NotImplemented`.

use ::std::sync::RwLock;
use ::std::time::Duration;
use ::jedi::{DeserializeOwned, Serialize};
use ::error::{TResult, TError};

pub use ::http::Method;
pub use ::http::StatusCode;

/// Holds our Api configuration. This consists of any mutable fields the Api
/// needs to build URLs or make decisions.
struct ApiConfig {
    auth: Option<String>,
}

impl ApiConfig {
    /// Create a new, blank config
    fn new() -> ApiConfig {
        ApiConfig {
            auth: None,
        }
    }
}

/// A struct used for building API requests
pub struct ApiReq {
    #[allow(dead_code)]
    timeout: Duration,
}

impl ApiReq {
    /// Create a new builder
    pub fn new() -> Self {
        ApiReq {
            timeout: Duration::new(10, 0),
        }
    }

    /// Set (override) the timeout for this request
    pub fn timeout<'a>(mut self, secs: u64) -> Self {
        self.timeout = Duration::new(secs, 0);
        self
    }
}

/// Wraps calling the Turtl API in an object
///
/// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md. Every builder method below is
/// a no-op that just returns `self` -- there's no real request underneath it on wasm32 yet --
/// and `call()`/`call_opt()` (the only methods that would actually hit the network) always
/// error.
pub struct ApiCaller;

impl ApiCaller {
    pub fn header<T: Into<String>>(self, _name: &str, _val: T) -> Self {
        self
    }

    pub fn body<T>(self, _body: T) -> Self {
        self
    }

    pub fn json<T: Serialize + ?Sized>(self, _json: &T) -> Self {
        self
    }

    #[allow(dead_code)]
    pub fn query<T: Serialize + ?Sized>(self, _query: &T) -> Self {
        self
    }

    #[allow(dead_code)]
    pub fn form<T: Serialize + ?Sized>(self, _form: &T) -> Self {
        self
    }

    pub fn call<T: DeserializeOwned>(self) -> TResult<T> {
        self.call_opt_impl(None)
    }

    pub fn call_opt<T: DeserializeOwned>(self, apireq: ApiReq) -> TResult<T> {
        self.call_opt_impl(Some(apireq))
    }

    pub fn call_opt_impl<T: DeserializeOwned>(self, _builder_maybe: Option<ApiReq>) -> TResult<T> {
        TErr!(TError::NotImplemented)
    }
}

/// Our Api object. Responsible for making outbound calls to our Turtl server.
///
/// TODO(wasm): not yet ported to wasm, see docs/wasm-port-plan.md
pub struct Api {
    config: RwLock<ApiConfig>,
}

impl Api {
    /// Create an Api
    pub fn new() -> Api {
        Api {
            config: RwLock::new(ApiConfig::new()),
        }
    }

    /// Set the API's authentication
    pub fn set_auth(&self, _username: String, _auth: String) -> TResult<()> {
        let ref mut config_guard = lockw!(self.config);
        // TODO(wasm): real auth-header building goes through crypto::to_base64() on native,
        // which currently errors on wasm32 too (see crypto/low.rs) -- just record that auth was
        // set, no working request will ever use it yet.
        config_guard.auth = Some(String::from("Basic <not yet ported to wasm>"));
        Ok(())
    }

    /// Clear out the API auth
    pub fn clear_auth(&self) {
        let ref mut config_guard = lockw!(self.config);
        config_guard.auth = None;
    }

    /// Given a method an url, return an ApiCaller
    pub fn req(&self, _method: Method, _resource: &str) -> TResult<ApiCaller> {
        TErr!(TError::NotImplemented)
    }

    /// Convenience function for api.call(GET)
    pub fn get(&self, resource: &str) -> TResult<ApiCaller> {
        self.req(Method::GET, resource)
    }

    /// Convenience function for api.call(POST)
    pub fn post(&self, resource: &str) -> TResult<ApiCaller> {
        self.req(Method::POST, resource)
    }

    /// Convenience function for api.call(PUT)
    pub fn put(&self, resource: &str) -> TResult<ApiCaller> {
        self.req(Method::PUT, resource)
    }

    /// Convenience function for api.call(DELETE)
    pub fn delete(&self, resource: &str) -> TResult<ApiCaller> {
        self.req(Method::DELETE, resource)
    }
}
