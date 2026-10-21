// The account server, reached by the program and not by the page: the page's content policy lets it ask nowhere but its own address, and a WebView's request has the browser's cookies and
// cross-site rules that an app's token neither needs nor wants. The page asks (`window.__zimShell.account.request`, shell.js) and this makes the request, to an `/api/` address of an https
// server (or of a server on this computer's own address, which is how one is tried out), with the few headers that an app's request has, and follows no redirect: the token is for the server
// that was typed, and goes to no other. The system's own list of trusted certificate authorities is used (OpenSSL on Linux, SChannel on Windows): a server whose certificate this computer
// does not trust is refused, with the reason in words.
use crate::tls::{self, CERTIFICATE_UNTRUSTED};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;
use url::{Host, Url};

/// The most that a request may carry, and that an answer may be: a notebook's files are sent as base64 in JSON, and the server's own limits are well under these.
pub const MAX_BODY: usize = 16 * 1024 * 1024;
pub const MAX_ANSWER: usize = 32 * 1024 * 1024;

/// A request as the page describes it: the address, the method, headers and a text body (every body of the account server's is JSON).
#[derive(Debug, Deserialize)]
pub struct NetRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// What the server answered: the status, the headers (names in lower case) and the body as text.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct NetResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// A request that could not be made: the words for a person and, for the two ways that a certificate is refused (`tls.rs`), the code that the page acts on.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct NetFailure {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl NetFailure {
    pub fn coded(code: &'static str, message: &str) -> NetFailure {
        NetFailure { message: message.to_string(), code: Some(code) }
    }
}

impl From<String> for NetFailure {
    fn from(message: String) -> NetFailure {
        NetFailure { message, code: None }
    }
}

impl From<&str> for NetFailure {
    fn from(message: &str) -> NetFailure {
        NetFailure { message: message.to_string(), code: None }
    }
}

/// The headers of the page's request that go on: the others (a cookie, an origin, a referrer, and everything the page's engine adds) are the page's, and not an app's.
pub(crate) const FORWARDED: [&str; 4] = ["authorization", "content-type", "x-requested-with", "accept"];

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

/// The address of a request that may be made: `https`, or `http` to this computer's own address; no name or password in it; an `/api/` path of the server.
pub fn check_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "That is not an address.".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => return Err("A server that is not on this computer has to be reached over https.".into()),
        _ => return Err("That is not an address of a server.".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("There is no name or password in the address of the server.".into());
    }
    if url.fragment().is_some() || !url.path().starts_with("/api/") {
        return Err("That is not a request to the account server.".into());
    }
    Ok(url)
}

/// The address that the person's browser may be sent to (`https`, or `http` to this computer's own address; no name or password in it): what the page may ask the program to open.
pub fn check_browser_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "That is not an address.".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        _ => return Err("A browser is only sent to an https address (or to one on this computer).".into()),
    }
    if !url.username().is_empty() || url.password().is_some() || url.host().is_none() {
        return Err("There is no name or password in the address of the server.".into());
    }
    Ok(url)
}

/// The clients that make the requests: one for servers out there (which respects the proxy settings of the system) and one for this computer's own address (which never uses a proxy).
pub struct Net {
    remote: reqwest::Client,
    local: reqwest::Client,
}

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // (the token is for the server that was typed: an answer that sends the program elsewhere is an answer, not a journey)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("ZimNotebook/", env!("CARGO_PKG_VERSION")))
}

impl Net {
    pub fn new() -> Result<Net, String> {
        let remote = builder().build().map_err(|error| format!("the network could not be set up: {error}"))?;
        let local = builder().no_proxy().build().map_err(|error| format!("the network could not be set up: {error}"))?;
        Ok(Net { remote, local })
    }

    /// Make a request, and say what came of it. A failure is told in words that a person can act on (the certificate is not trusted, the server is not there). `pin` is the fingerprint of
    /// the certificate that the person trusted for this server, if they did (the program keeps it, `pins.rs`): the request then goes over a connection whose certificate is checked against it
    /// before anything is sent (`tls::send_pinned`), and the system's own trust is not asked about that server at all.
    pub async fn send(&self, request: NetRequest, pin: Option<&str>) -> Result<NetResponse, NetFailure> {
        let url = check_url(&request.url)?;
        let method = match request.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("That is not a request that this app makes.".into()),
        };
        // (a trust that can't be read is no trust: the server is then one that the system does not know, and the person is asked again)
        if let Some(pin) = pin.and_then(tls::parse_fingerprint).filter(|_| url.scheme() == "https") {
            return tls::send_pinned(&url, &pin, method, &request.headers, request.body).await;
        }
        let client = if is_loopback(&url) { &self.local } else { &self.remote };
        let mut builder = client.request(method, url);
        for (name, value) in &request.headers {
            if FORWARDED.contains(&name.to_ascii_lowercase().as_str()) {
                builder = builder.header(name.as_str(), value.as_str());
            }
        }
        if let Some(body) = request.body {
            if body.len() > MAX_BODY {
                return Err("That request is too big.".into());
            }
            builder = builder.body(body);
        }
        let mut response = builder.send().await.map_err(describe)?;
        let status = response.status().as_u16();
        let headers = response.headers().iter().filter_map(|(name, value)| value.to_str().ok().map(|v| (name.as_str().to_string(), v.to_string()))).collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(describe)? {
            if body.len() + chunk.len() > MAX_ANSWER {
                return Err("The server's answer is too big.".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(NetResponse { status, headers, body: String::from_utf8_lossy(&body).into_owned() })
    }
}

/// A failure of a request, with its causes in order (the certificate is not trusted: that is deep in the chain, and is what the person needs to read). One about the certificate carries the code
/// that the page acts on.
fn describe(error: reqwest::Error) -> NetFailure {
    let error = error.without_url();
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        source = cause.source();
    }
    let said = parts.join(": ");
    NetFailure { code: refused_certificate(&said).then_some(CERTIFICATE_UNTRUSTED), message: explain(&said) }
}

/// Whether the system said what it said for the sake of the server's certificate (and not for one of the failures that `explain` tells otherwise).
fn refused_certificate(said: &str) -> bool {
    let lower = said.to_ascii_lowercase();
    lower.contains("certificate") && !is_connection_failure(&lower)
}

/// The failures that are about getting to the server and not about what it showed, written in the system's words (lower case).
fn is_connection_failure(lower: &str) -> bool {
    lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("dns error")
        || lower.contains("failed to lookup")
        || lower.contains("name or service not known")
        || lower.contains("no such host")
        || lower.contains("nodename nor servname")
        || lower.contains("timed out")
        || lower.contains("deadline has elapsed")
}

/// What the system said, in words for a person. A failure about the server's certificate is told as that (the system's own words for it are long, and a person can do
/// something about this one: trust the authority that made it, or use a server whose certificate is from one that the system knows); the reason that the system gave is kept.
pub(crate) fn explain(said: &str) -> String {
    let lower = said.to_ascii_lowercase();
    if lower.contains("connection refused") || lower.contains("actively refused") {
        return "The server did not answer: check the address, and that it is running.".to_string();
    }
    if lower.contains("dns error") || lower.contains("failed to lookup") || lower.contains("name or service not known") || lower.contains("no such host") || lower.contains("nodename nor servname") {
        return "The server's name was not found: check the address, and that this computer is online.".to_string();
    }
    if lower.contains("timed out") || lower.contains("deadline has elapsed") {
        return "The server took too long to answer.".to_string();
    }
    if !lower.contains("certificate") {
        return said.to_string();
    }
    let reason = said.rsplit_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(reason, _)| reason.trim()).filter(|reason| !reason.is_empty() && reason.len() < 120 && !reason.contains(':'));
    match reason {
        Some(reason) => format!("The server's certificate is not one that this computer trusts ({reason})."),
        None => "The server's certificate is not one that this computer trusts.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn only_a_server_that_can_be_trusted_with_a_token_is_asked() {
        for good in ["https://notes.example.org/api/me", "https://notes.example.org:8443/api/sync/notebooks?x=1", "http://127.0.0.1:8080/api/me", "http://localhost:3000/api/me", "http://[::1]:8080/api/me", "http://127.0.0.2:80/api/me"] {
            assert!(check_url(good).is_ok(), "{good}");
        }
        for bad in [
            "http://notes.example.org/api/me",
            "http://192.168.1.10/api/me",
            "http://127.0.0.1.example.org/api/me",
            "ftp://notes.example.org/api/me",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://ada:secret@notes.example.org/api/me",
            "https://ada@notes.example.org/api/me",
            "https://notes.example.org/other",
            "https://notes.example.org/api",
            "https://notes.example.org/apix/me",
            "https://notes.example.org/api/me#x",
            "https://notes.example.org/../etc/passwd",
            // a dot segment is resolved by the parser that makes the request, however it is written: what counts is the path that is left
            "https://notes.example.org/api/../etc/passwd",
            "https://notes.example.org/api/%2e%2e/etc/passwd",
            "https://notes.example.org/api/%2E%2E/etc/passwd",
            "https://notes.example.org/api/.%2e/etc/passwd",
            "https://notes.example.org/api/x/%2e%2e/%2e%2e/y",
            "not an address",
            "",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        // (and a dot segment that leaves the path under /api/ is only a longer way to write it)
        assert_eq!(check_url("https://notes.example.org/api/./x/../me").unwrap().path(), "/api/me");
    }

    #[test]
    fn the_browser_is_sent_only_where_a_person_would_go() {
        for good in ["https://notes.example.org/?app=authorize&state=x", "http://127.0.0.1:8080/?app=authorize", "http://localhost:3000/"] {
            assert!(check_browser_url(good).is_ok(), "{good}");
        }
        for bad in ["http://notes.example.org/", "file:///etc/passwd", "javascript:alert(1)", "ftp://notes.example.org/", "https://ada:secret@notes.example.org/", "mailto:a@b.c", "zim://x", "calc.exe", "https://", ""] {
            assert!(check_browser_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tells_a_certificate_that_is_not_trusted_as_that() {
        let openssl = "error sending request: client error (Connect): error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed:../ssl/statem/statem_clnt.c:2124: (self-signed certificate in certificate chain): error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed:../ssl/statem/statem_clnt.c:2124:";
        assert_eq!(explain(openssl), "The server's certificate is not one that this computer trusts (self-signed certificate in certificate chain).");
        let schannel = "error sending request: client error (Connect): The certificate chain was issued by an authority that is not trusted. (os error -2146762487)";
        assert_eq!(explain(schannel), "The server's certificate is not one that this computer trusts (os error -2146762487).");
        // (no reason to give: none is made up)
        assert_eq!(explain("error sending request: the certificate is wrong"), "The server's certificate is not one that this computer trusts.");
        // the failures that a person meets most are told as what to check
        assert_eq!(explain("error sending request: client error (Connect): tcp connect error: Connection refused (os error 111)"), "The server did not answer: check the address, and that it is running.");
        assert_eq!(explain("error sending request: client error (Connect): dns error: failed to lookup address information: Name or service not known"), "The server's name was not found: check the address, and that this computer is online.");
        assert_eq!(explain("error sending request: operation timed out"), "The server took too long to answer.");
        // what is not one of these is said as the system said it
        assert_eq!(explain("error sending request: something else broke"), "error sending request: something else broke");
        // (and Windows says a refused connection in its own words)
        assert_eq!(explain("error sending request: client error (Connect): No connection could be made because the target machine actively refused it. (os error 10061)"), "The server did not answer: check the address, and that it is running.");
    }

    #[test]
    fn calls_a_refusal_for_the_certificate_that_and_nothing_else_by_that_code() {
        let openssl = "error sending request: client error (Connect): error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed:../ssl/statem/statem_clnt.c:2124: (self-signed certificate in certificate chain)";
        let schannel = "error sending request: client error (Connect): The certificate chain was issued by an authority that is not trusted. (os error -2146762487)";
        for said in [openssl, schannel, "error sending request: the certificate has expired", "error sending request: Hostname mismatch, certificate is not valid for '192.168.1.1'"] {
            assert!(refused_certificate(said), "{said}");
        }
        for said in [
            "error sending request: client error (Connect): tcp connect error: Connection refused (os error 111)",
            "error sending request: client error (Connect): dns error: failed to lookup address information: Name or service not known",
            "error sending request: operation timed out",
            "error sending request: something else broke",
            // (a failure that mentions a certificate in passing, on the way to a server that is not there, is the server not being there)
            "error sending request: certificate lookup: Connection refused (os error 111)",
            "error sending request: certificate lookup: No connection could be made because the target machine actively refused it. (os error 10061)",
        ] {
            assert!(!refused_certificate(said), "{said}");
        }
    }

    /// A server on this computer that answers every request with `answer` (its text is sent as it is), and tells what it was sent.
    async fn serves(answer: String) -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let (tx, answer) = (tx.clone(), answer.clone());
                tokio::spawn(async move {
                    let mut seen = Vec::new();
                    let mut buffer = [0u8; 4096];
                    // (up to the end of the head and the body that it says follows)
                    loop {
                        let n = stream.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        seen.extend_from_slice(&buffer[..n]);
                        let text = String::from_utf8_lossy(&seen).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                            if seen.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let _ = tx.send(String::from_utf8_lossy(&seen).to_string());
                    let _ = stream.write_all(answer.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (port, rx)
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-answer: yes\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> NetRequest {
        NetRequest { url: format!("http://127.0.0.1:{port}{path}"), method: method.into(), headers: headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(), body: body.map(str::to_string) }
    }

    #[tokio::test]
    async fn asks_with_the_headers_of_an_app_and_gives_back_the_status_headers_and_body() {
        let (port, mut seen) = serves(ok("{\"user\":null}")).await;
        let net = Net::new().unwrap();
        let sent = request(port, "POST", "/api/sync/x", &[("Authorization", "Bearer t0ken"), ("content-type", "application/json"), ("X-Requested-With", "zim"), ("cookie", "zim=stolen"), ("Origin", "https://evil.example"), ("referer", "https://evil.example/"), ("x-made-up", "1")], Some("{\"a\":1}"));
        let answer = net.send(sent, None).await.unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, "{\"user\":null}");
        assert_eq!(answer.headers.get("x-answer").map(String::as_str), Some("yes"));
        assert_eq!(answer.headers.get("content-type").map(String::as_str), Some("application/json"));
        let head = seen.recv().await.unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /api/sync/x http/1.1"), "{head}");
        assert!(head.contains("authorization: bearer t0ken"), "{head}");
        assert!(head.contains("x-requested-with: zim"), "{head}");
        assert!(head.contains("content-type: application/json"), "{head}");
        assert!(head.ends_with("{\"a\":1}"), "{head}");
        assert!(head.contains("user-agent: zimnotebook/"), "{head}");
        for left_out in ["cookie", "origin", "referer", "x-made-up"] {
            assert!(!head.contains(&format!("{left_out}:")), "{left_out} went on: {head}");
        }
    }

    #[tokio::test]
    async fn knows_nothing_of_a_trusted_certificate_for_an_address_that_is_not_https() {
        // (a fingerprint that is given with a plain http address is not a reason to talk TLS to it)
        let (port, mut seen) = serves(ok("{\"user\":null}")).await;
        let net = Net::new().unwrap();
        let fingerprint = "93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55";
        let answer = net.send(request(port, "GET", "/api/me", &[("authorization", "Bearer t0ken")], None), Some(fingerprint)).await.unwrap();
        assert_eq!((answer.status, answer.body.as_str()), (200, "{\"user\":null}"));
        assert!(seen.recv().await.unwrap().to_ascii_lowercase().starts_with("get /api/me http/1.1"), "it was asked in plain http");
    }

    #[tokio::test]
    async fn makes_every_kind_of_request_that_the_app_makes() {
        let net = Net::new().unwrap();
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "patch"] {
            let (port, mut seen) = serves(ok("{}")).await;
            let answer = net.send(request(port, method, "/api/sync/notebooks/x", &[], if method == "GET" || method == "DELETE" { None } else { Some("{}") }), None).await.unwrap();
            assert_eq!(answer.status, 200, "{method}");
            let head = seen.recv().await.unwrap();
            assert!(head.starts_with(&format!("{} /api/sync/notebooks/x ", method.to_ascii_uppercase())), "{method}: {head}");
        }
    }

    #[tokio::test]
    async fn never_goes_through_a_proxy_to_reach_this_computer() {
        // (a proxy set for the system: a server on this computer's own address is not reached through it)
        for name in ["HTTP_PROXY", "http_proxy"] {
            std::env::set_var(name, "http://127.0.0.1:9");
        }
        let (port, _) = serves(ok("{}")).await;
        let net = Net::new().unwrap();
        for name in ["HTTP_PROXY", "http_proxy"] {
            std::env::remove_var(name);
        }
        let answer = net.send(request(port, "GET", "/api/me", &[], None), None).await.unwrap();
        assert_eq!(answer.status, 200);
    }

    #[tokio::test]
    async fn gives_the_status_that_the_server_gave_and_follows_no_redirect() {
        let (port, _) = serves("HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:1/api/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()).await;
        let net = Net::new().unwrap();
        let answer = net.send(request(port, "GET", "/api/me", &[("authorization", "Bearer t0ken")], None), None).await.unwrap();
        assert_eq!(answer.status, 302, "the redirect is the answer");
        assert_eq!(answer.headers.get("location").map(String::as_str), Some("http://127.0.0.1:1/api/elsewhere"));
        let body = "{\"code\":\"browser-only\"}";
        let (port, _) = serves(format!("HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())).await;
        let answer = net.send(request(port, "GET", "/api/me", &[], None), None).await.unwrap();
        assert_eq!((answer.status, answer.body.as_str()), (403, "{\"code\":\"browser-only\"}"));
    }

    #[tokio::test]
    async fn refuses_what_is_not_a_request_of_the_app_before_it_connects() {
        let net = Net::new().unwrap();
        // (nothing listens at these: the refusal is the program's, not the network's)
        let outside = net.send(NetRequest { url: "http://192.0.2.1/api/me".into(), method: "GET".into(), headers: HashMap::new(), body: None }, None).await.unwrap_err().message;
        assert!(outside.contains("https"), "{outside}");
        let wrong_method = net.send(request(1, "TRACE", "/api/me", &[], None), None).await.unwrap_err().message;
        assert!(wrong_method.contains("not a request that this app makes"), "{wrong_method}");
        let wrong_path = net.send(request(1, "GET", "/other", &[], None), None).await.unwrap_err().message;
        assert!(wrong_path.contains("account server"), "{wrong_path}");
        let big = net.send(request(1, "POST", "/api/x", &[], Some(&"x".repeat(MAX_BODY + 1))), None).await.unwrap_err().message;
        assert!(big.contains("too big"), "{big}");
    }

    #[tokio::test]
    async fn says_that_the_server_is_not_there() {
        // a port that nobody listens on
        let port = { TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port() };
        let net = Net::new().unwrap();
        let failure = net.send(request(port, "GET", "/api/me", &[], None), None).await.unwrap_err();
        assert!(!failure.message.is_empty());
        assert!(!failure.message.contains(&port.to_string()), "an address does not come back with a failure: {}", failure.message);
        assert_eq!(failure.code, None, "a server that is not there is not a certificate");
    }

    /// By hand, against a real TLS server (`ZIM_TLS_URL=https://127.0.0.1:PORT/api/health [ZIM_TLS_EXPECT=refused] cargo test --bin zim-notebook-desktop tls -- --ignored --nocapture`):
    /// what the system's trusted authorities decide. A server whose certificate they do not vouch for is refused, with the reason in words (`ZIM_TLS_EXPECT=refused`); name the
    /// authority that made it in `SSL_CERT_FILE` (OpenSSL's own list of authorities, which is what Linux uses) and the same request goes through.
    #[tokio::test]
    #[ignore = "needs a TLS server: see the comment"]
    async fn a_server_with_a_certificate_that_the_system_does_not_trust_is_refused_and_one_it_trusts_is_not() {
        let url = std::env::var("ZIM_TLS_URL").expect("ZIM_TLS_URL names the server to ask");
        let net = Net::new().unwrap();
        let result = net.send(NetRequest { url, method: "GET".into(), headers: HashMap::new(), body: None }, None).await;
        if std::env::var("ZIM_TLS_EXPECT").as_deref() == Ok("refused") {
            let failure = result.unwrap_err();
            assert_eq!(failure.code, Some(CERTIFICATE_UNTRUSTED), "a server that the system does not trust is refused with the code that the page acts on");
            let reason = failure.message;
            println!("refused, as it should be: {reason}");
            assert!(reason.to_lowercase().contains("certificate") || reason.to_lowercase().contains("tls") || reason.to_lowercase().contains("ssl"), "{reason}");
        } else {
            let answer = result.unwrap();
            println!("answered: {} {}", answer.status, answer.body);
            assert_eq!(answer.status, 200);
        }
    }

    #[tokio::test]
    async fn does_not_take_an_answer_that_is_too_big() {
        let body = "x".repeat(MAX_ANSWER + 1);
        let (port, _) = serves(ok(&body)).await;
        let net = Net::new().unwrap();
        let failure = net.send(request(port, "GET", "/api/big", &[], None), None).await.unwrap_err();
        assert!(failure.message.contains("too big"), "{}", failure.message);
    }
}
