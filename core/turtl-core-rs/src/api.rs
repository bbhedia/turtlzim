//! The Api system is responsible for talking to our Turtl server, and manages
//! our user authentication.
//!
//! The client is async and the same on every target: reqwest's hyper-backed client natively and its
//! `fetch` backend on wasm32 (docs/wasm-port-plan.md decision 2.3). Callers `.await` `call()` /
//! `call_opt()`, and are themselves async all the way up to the task that `util::exec` runs.

use ::std::sync::{RwLock, Mutex};
use ::std::time::Duration;
use ::std::collections::HashMap;
use ::config;
use ::jedi::{self, Value, DeserializeOwned, Serialize};
use crate::error::{TResult, TError};
use crate::crypto;
use ::reqwest::{Body, Client, Url};
use ::reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
pub use ::reqwest::Method;
pub use ::reqwest::StatusCode;

/// Pull out our crate version to send to the api
const CORE_VERSION: &'static str = env!("CARGO_PKG_VERSION");

/// How long a request may take unless the caller says otherwise with `ApiReq`. (This is what
/// reqwest's old blocking client defaulted to.)
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

lazy_static! {
    /// A hash table that holds HTTP clients. we used to just create/destroy
    /// clients on each request, but that exhausts connections so it's better to
    /// cache the clients and let them use their internal connection pool.
    static ref CLIENTS: Mutex<HashMap<String, Client>> = Mutex::new(HashMap::new());
}

/// Holds our Api configuration. This consists of any mutable fields the Api
/// needs to build URLs or make decisions.
struct ApiConfig {
    auth: Option<String>,
    /// Overrides the `api.endpoint` config value when set (see `Api::set_endpoint`).
    endpoint: Option<String>,
}

impl ApiConfig {
    /// Create a new, blank config
    fn new() -> ApiConfig {
        ApiConfig {
            auth: None,
            endpoint: None,
        }
    }
}

/// A struct used for building API requests
pub struct ApiReq {
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

/// Whether `err` is a request that ran out of time (see `ApiReq::timeout`). Pass it an error that
/// has been `shed()`: that is how the wrapped reqwest error shows up.
pub fn is_timeout(err: &TError) -> bool {
    match err {
        TError::Boxed(inner) => inner.downcast_ref::<::reqwest::Error>()
            .map(|e| e.is_timeout())
            .unwrap_or(false),
        _ => false,
    }
}

/// Get the HTTP client for the current config, creating (and caching) it the first time. Native
/// clients can be configured with a proxy and with invalid-certificate acceptance; the browser's
/// fetch has neither knob, so there is just the one client on wasm32.
fn get_client() -> TResult<Client> {
    // (`mut` is only needed by the native-only proxy/ssl settings below)
    #[allow(unused_mut)]
    let mut cachekey: Vec<String> = Vec::with_capacity(2);
    #[allow(unused_mut)]
    let mut client_builder = Client::builder();
    #[cfg(not(target_arch = "wasm32"))]
    {
        match config::get::<Option<String>>(&["api", "proxy"]) {
            Ok(Some(proxy_cfg)) => {
                debug!("api::call() -- req: using proxy: {}", proxy_cfg);
                cachekey.push(format!("proxy-{}", proxy_cfg));
                client_builder = client_builder.proxy(::reqwest::Proxy::all(proxy_cfg.as_str())?);
            }
            _ => {}
        }
        match config::get::<Option<bool>>(&["api", "allow_invalid_ssl"]) {
            Ok(Some(true)) => {
                debug!("api::call() -- req: allow invalid ssl");
                cachekey.push(String::from("allow-invalid-ssl"));
                client_builder = client_builder.danger_accept_invalid_certs(true);
            }
            _ => {}
        }
    }
    let cachekey_string: String = cachekey.join("///");
    let mut client_guard = lock!((*CLIENTS));
    if !client_guard.contains_key(&cachekey_string) {
        let client = client_builder.build()?;
        debug!("api::call() -- creating new client with cachekey {}", cachekey_string);
        client_guard.insert(cachekey_string.clone(), client);
    }
    // notice we clone here...the client lets us clone without messing
    // up the pooling. very nice!
    Ok(client_guard.get(&cachekey_string).unwrap().clone())
}

/// Wraps calling the Turtl API in an object
pub struct ApiCaller {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Body>,
    /// A problem found while building the request (a bad header, an unserializable body); `call`
    /// reports it instead of sending anything.
    error: Option<TError>,
}

impl ApiCaller {
    fn new(method: Method, url: Url) -> ApiCaller {
        ApiCaller {
            method: method,
            url: url,
            headers: HeaderMap::new(),
            body: None,
            error: None,
        }
    }

    fn fail(&mut self, err: TError) {
        if self.error.is_none() {
            self.error = Some(err);
        }
    }

    pub fn header<T: Into<String>>(mut self, name: &str, val: T) -> Self {
        let val: String = val.into();
        match (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(val.as_str())) {
            (Ok(hname), Ok(hval)) => { self.headers.append(hname, hval); }
            _ => self.fail(TError::Msg(format!("api::header() -- invalid header `{}`", name))),
        }
        self
    }

    pub fn body<T: Into<Body>>(mut self, body: T) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn json<T: Serialize + ?Sized>(mut self, json: &T) -> Self {
        match ::serde_json::to_vec(json) {
            Ok(bytes) => {
                if !self.headers.contains_key(CONTENT_TYPE) {
                    self.headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                }
                self.body = Some(Body::from(bytes));
            }
            Err(e) => self.fail(TError::Msg(format!("api::json() -- could not serialize the request body: {}", e))),
        }
        self
    }

    /// Make the call and parse the (JSON) response.
    pub async fn call<T: DeserializeOwned>(self) -> TResult<T> {
        self.call_impl(None).await
    }

    /// Make the call with per-request options (a timeout) and parse the (JSON) response.
    pub async fn call_opt<T: DeserializeOwned>(self, apireq: ApiReq) -> TResult<T> {
        self.call_impl(Some(apireq)).await
    }

    async fn call_impl<T: DeserializeOwned>(self, builder_maybe: Option<ApiReq>) -> TResult<T> {
        let ApiCaller { method, url, headers, body, error } = self;
        if let Some(err) = error {
            return Err(err);
        }
        let timeout = match builder_maybe {
            Some(ApiReq { timeout }) => timeout,
            None => DEFAULT_TIMEOUT,
        };
        let client = get_client()?;
        let callinfo = CallInfo::new(method.clone(), String::from(url.as_str()));
        debug!("api::call() -- req: {} {}", method, url);
        let mut req = client.request(method, url).headers(headers).timeout(timeout);
        if let Some(body) = body {
            req = req.body(body);
        }
        let res = req.send().await.map_err(|e| {
            debug!("api::call() -- call error: {}", e);
            toterr!(e)
        })?;
        let status = res.status();
        let text_res = res.text().await.map_err(|e| toterr!(e));
        if !status.is_success() {
            let errstr = match text_res {
                Ok(x) => x,
                Err(e) => {
                    error!("api::call() -- problem grabbing error message: {}", e);
                    String::from("<unknown>")
                }
            };
            let val = match jedi::parse(&errstr) {
                Ok(x) => x,
                Err(_) => Value::String(errstr),
            };
            debug!("api::call() -- call error: {} {}", status.as_u16(), val);
            return TErr!(TError::Api(status, val));
        }
        let out = text_res?;
        info!("api::call() -- res({}): {:?} {} {}", out.len(), status.as_u16(), &callinfo.method, &callinfo.resource);
        trace!("  api::call() -- body: {}", out);
        jedi::parse(&out).map_err(|e| {
            warn!("api::call() -- JSON parse error: {}", out);
            toterr!(e)
        })
    }
}

/// Used to store some info we want when we send a response to call_end()
pub struct CallInfo {
    method: Method,
    resource: String,
}

impl CallInfo {
    /// Create a new call info object
    fn new(method: Method, resource: String) -> Self {
        Self {
            method: method,
            resource: resource,
        }
    }
}

/// Our Api object. Responsible for making outbound calls to our Turtl server.
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

    /// Use `endpoint` instead of the `api.endpoint` config value (`None` goes back to the config).
    /// For tests and for embedders that have no config file to read the endpoint from.
    #[allow(dead_code)]
    pub fn set_endpoint(&self, endpoint: Option<String>) {
        let ref mut config_guard = lockw!(self.config);
        config_guard.endpoint = endpoint;
    }

    /// Set the API's authentication
    pub fn set_auth(&self, username: String, auth: String) -> TResult<()> {
        let auth_str = format!("{}:{}", username, auth);
        let base_auth = crypto::to_base64(&Vec::from(auth_str.as_bytes()))?;
        let ref mut config_guard = lockw!(self.config);
        config_guard.auth = Some(String::from("Basic ") + &base_auth);
        Ok(())
    }

    /// Clear out the API auth
    pub fn clear_auth(&self) {
        let ref mut config_guard = lockw!(self.config);
        config_guard.auth = None;
    }

    /// The `Authorization` header value for the current auth, if there is any.
    pub fn auth_header(&self) -> Option<String> {
        let ref guard = lockr!(self.config);
        guard.auth.clone()
    }

    /// Set our standard auth header into a request
    fn set_standard_headers(&self, caller: ApiCaller) -> ApiCaller {
        let caller = match self.auth_header() {
            Some(x) => caller.header("Authorization", x),
            None => caller,
        };
        match config::get::<String>(&["api", "client_version_string"]) {
            Ok(version) => {
                let header_val = format!("{}/{}", version, CORE_VERSION);
                caller.header("X-Turtl-Client", header_val)
            }
            Err(_) => caller,
        }
    }

    /// Build a full URL given a resource
    fn build_url(&self, resource: &str) -> TResult<String> {
        let overridden = {
            let ref guard = lockr!(self.config);
            guard.endpoint.clone()
        };
        let endpoint = match overridden {
            Some(x) => x,
            None => config::get::<String>(&["api", "endpoint"])?,
        };
        let mut url = String::with_capacity(endpoint.len() + resource.len());
        url.push_str(endpoint.trim_end_matches('/'));
        url.push_str(resource);
        Ok(url)
    }

    /// Given a method and a resource, return an ApiCaller to finish building and send
    pub fn req(&self, method: Method, resource: &str) -> TResult<ApiCaller> {
        debug!("api::req() -- begin: {} {}", method, resource);
        let url = self.build_url(resource)?;
        let caller = ApiCaller::new(method, Url::parse(url.as_str())?);
        Ok(self.set_standard_headers(caller))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_arch = "wasm32"))]
    use crate::util::exec;
    #[cfg(not(target_arch = "wasm32"))]
    use crate::util::mock_server::{MockServer, Request, Response};
    #[cfg(target_arch = "wasm32")]
    use ::wasm_bindgen::prelude::*;
    #[cfg(target_arch = "wasm32")]
    use ::wasm_bindgen_futures::JsFuture;

    // The test server on wasm32 is a Node `http` server (js/test_support.js); the native one is
    // util/mock_server.rs. Their routes must stay identical:
    //
    //   /hello       -> 200 {"hello":"world","client":<X-Turtl-Client|null>,"auth":<Authorization|null>}
    //   /echo        -> 200 {"method":..,"auth":..,"content_type":..,"custom":<X-Custom|null>,"body":<parsed JSON|null>}
    //   /missing     -> 404 {"error":"nope"}
    //   /plain-error -> 500 text/plain "server on fire"
    //   /not-json    -> 200 text/plain "definitely not json"
    //   /slow        -> 200 {"slow":true} after 3 seconds
    #[cfg(not(target_arch = "wasm32"))]
    fn route(req: &Request) -> Response {
        let json_or_null = |v: Option<&str>| match v {
            Some(x) => json!(x),
            None => Value::Null,
        };
        match req.path.as_str() {
            "/hello" => Response::json(200, &json!({
                "hello": "world",
                "client": json_or_null(req.header("x-turtl-client")),
                "auth": json_or_null(req.header("authorization")),
            }).to_string()),
            "/echo" => Response::json(200, &json!({
                "method": req.method,
                "auth": json_or_null(req.header("authorization")),
                "content_type": json_or_null(req.header("content-type")),
                "custom": json_or_null(req.header("x-custom")),
                "body": jedi::parse::<Value>(&req.body).unwrap_or(Value::Null),
            }).to_string()),
            "/missing" => Response::json(404, r#"{"error":"nope"}"#),
            "/plain-error" => Response::text(500, "server on fire"),
            "/not-json" => Response::text(200, "definitely not json"),
            "/slow" => Response::json(200, r#"{"slow":true}"#).delayed(3000),
            _ => Response::json(404, r#"{"error":"unknown route"}"#),
        }
    }

    /// Everything the Api layer promises, run against whichever server the target provides.
    /// One sequential test on purpose: it never touches global state (the endpoint is set on the
    /// `Api` itself), but a single test keeps the scenario order obvious.
    async fn scenarios(base: String) {
        let api = Api::new();
        api.set_endpoint(Some(base.clone()));

        // a plain GET, JSON in the response
        let v: Value = api.get("/hello").unwrap().call().await.unwrap();
        assert_eq!(jedi::get::<String>(&["hello"], &v).unwrap(), "world");
        assert_eq!(v["auth"], Value::Null);

        // set_auth puts a Basic Authorization header on every request until it is cleared
        api.set_auth(String::from("user"), String::from("pass")).unwrap();
        let v: Value = api.get("/hello").unwrap().call().await.unwrap();
        assert_eq!(v["auth"], json!("Basic dXNlcjpwYXNz"));
        assert_eq!(api.auth_header(), Some(String::from("Basic dXNlcjpwYXNz")));
        api.clear_auth();
        let v: Value = api.get("/hello").unwrap().call().await.unwrap();
        assert_eq!(v["auth"], Value::Null);
        assert_eq!(api.auth_header(), None);

        // a POST with a JSON body and a custom header
        let v: Value = api.post("/echo").unwrap()
            .header("X-Custom", "yes")
            .json(&json!({"a": 1, "b": ["x", "y"]}))
            .call().await.unwrap();
        assert_eq!(v["method"], json!("POST"));
        assert_eq!(v["content_type"], json!("application/json"));
        assert_eq!(v["custom"], json!("yes"));
        assert_eq!(v["body"], json!({"a": 1, "b": ["x", "y"]}));

        // a raw body
        let v: Value = api.put("/echo").unwrap().body(String::from(r#"{"raw":true}"#)).call().await.unwrap();
        assert_eq!(v["method"], json!("PUT"));
        assert_eq!(v["body"], json!({"raw": true}));

        // a failing status keeps the status and the (JSON) error body (callers `shed()` the wrapper
        // `TErr!` puts around errors before matching on them)
        match api.get("/missing").unwrap().call::<Value>().await.map_err(|e| e.shed()) {
            Err(TError::Api(status, val)) => {
                assert_eq!(status, StatusCode::NOT_FOUND);
                assert_eq!(val, json!({"error": "nope"}));
            }
            other => panic!("expected TError::Api(404, ..), got {:?}", other),
        }

        // ...and a body that isn't JSON comes through as a string
        match api.get("/plain-error").unwrap().call::<Value>().await.map_err(|e| e.shed()) {
            Err(TError::Api(status, val)) => {
                assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(val, json!("server on fire"));
            }
            other => panic!("expected TError::Api(500, ..), got {:?}", other),
        }

        // a successful status with a body that isn't JSON is an error, not a panic
        assert!(api.get("/not-json").unwrap().call::<Value>().await.is_err());

        // a per-request timeout fires
        let err = api.get("/slow").unwrap()
            .call_opt::<Value>(ApiReq::new().timeout(1)).await
            .unwrap_err()
            .shed();
        match err {
            TError::Boxed(ref inner) => match inner.downcast_ref::<::reqwest::Error>() {
                Some(re) => assert!(re.is_timeout(), "expected a timeout, got: {:?}", re),
                None => panic!("expected a reqwest error, got: {}", inner),
            },
            other => panic!("expected a boxed reqwest error, got {:?}", other),
        }

        // an unusable header is reported when the call is made, without sending anything
        assert!(api.get("/hello").unwrap().header("bad header name", "x").call::<Value>().await.is_err());

        // a server that isn't there is an error, not a panic or a hang
        api.set_endpoint(Some(String::from("http://127.0.0.1:1")));
        assert!(api.get("/hello").unwrap().call::<Value>().await.is_err());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn api_scenarios() {
        let server = MockServer::start(route);
        exec::block_on(scenarios(server.url()));
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(module = "/js/test_support.js")]
    extern "C" {
        /// Starts the Node test server and resolves to its port.
        #[wasm_bindgen(js_name = startServer)]
        fn start_server() -> ::js_sys::Promise;
    }

    #[cfg(target_arch = "wasm32")]
    #[::wasm_bindgen_test::wasm_bindgen_test]
    async fn api_scenarios() {
        let port = JsFuture::from(start_server()).await.unwrap().as_f64().unwrap() as u16;
        scenarios(format!("http://127.0.0.1:{}", port)).await;
    }

}
