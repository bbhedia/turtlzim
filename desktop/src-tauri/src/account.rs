// The account server, reached by the program and not by the page: the page's content policy lets it ask nowhere but its own address, and a WebView's request has the browser's cookies and
// cross-site rules that an app's token neither needs nor wants. The page asks (`window.__zimShell.account.request`, shell.js) and this makes the request, to an `/api/` address of an https
// server (or of a server on this computer's own address, which is how one is tried out), with the few headers that an app's request has, and follows no redirect: the token is for the server
// that was typed, and goes to no other. The system's own list of trusted certificate authorities is used (OpenSSL on Linux, SChannel on Windows): a server whose certificate this computer
// does not trust is refused, with the reason in words.
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

/// The headers of the page's request that go on: the others (a cookie, an origin, a referrer, and everything the page's engine adds) are the page's, and not an app's.
const FORWARDED: [&str; 4] = ["authorization", "content-type", "x-requested-with", "accept"];

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

    /// Make a request, and say what came of it. A failure is told in words that a person can act on (the certificate is not trusted, the server is not there).
    pub async fn send(&self, request: NetRequest) -> Result<NetResponse, String> {
        let url = check_url(&request.url)?;
        let method = match request.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("That is not a request that this app makes.".into()),
        };
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

/// A failure of a request, with its causes in order (the certificate is not trusted: that is deep in the chain, and is what the person needs to read).
fn describe(error: reqwest::Error) -> String {
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
    explain(&parts.join(": "))
}

/// What the system said, in words for a person. A failure about the server's certificate is told as that (the system's own words for it are long, and a person can do
/// something about this one: trust the authority that made it, or use a server whose certificate is from one that the system knows); the reason that the system gave is kept.
fn explain(said: &str) -> String {
    let lower = said.to_ascii_lowercase();
    if lower.contains("connection refused") {
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
            "not an address",
            "",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
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
        let answer = net.send(sent).await.unwrap();
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
    async fn makes_every_kind_of_request_that_the_app_makes() {
        let net = Net::new().unwrap();
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "patch"] {
            let (port, mut seen) = serves(ok("{}")).await;
            let answer = net.send(request(port, method, "/api/sync/notebooks/x", &[], if method == "GET" || method == "DELETE" { None } else { Some("{}") })).await.unwrap();
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
        let answer = net.send(request(port, "GET", "/api/me", &[], None)).await.unwrap();
        assert_eq!(answer.status, 200);
    }

    #[tokio::test]
    async fn gives_the_status_that_the_server_gave_and_follows_no_redirect() {
        let (port, _) = serves("HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:1/api/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()).await;
        let net = Net::new().unwrap();
        let answer = net.send(request(port, "GET", "/api/me", &[("authorization", "Bearer t0ken")], None)).await.unwrap();
        assert_eq!(answer.status, 302, "the redirect is the answer");
        assert_eq!(answer.headers.get("location").map(String::as_str), Some("http://127.0.0.1:1/api/elsewhere"));
        let body = "{\"code\":\"browser-only\"}";
        let (port, _) = serves(format!("HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())).await;
        let answer = net.send(request(port, "GET", "/api/me", &[], None)).await.unwrap();
        assert_eq!((answer.status, answer.body.as_str()), (403, "{\"code\":\"browser-only\"}"));
    }

    #[tokio::test]
    async fn refuses_what_is_not_a_request_of_the_app_before_it_connects() {
        let net = Net::new().unwrap();
        // (nothing listens at these: the refusal is the program's, not the network's)
        let outside = net.send(NetRequest { url: "http://192.0.2.1/api/me".into(), method: "GET".into(), headers: HashMap::new(), body: None }).await.unwrap_err();
        assert!(outside.contains("https"), "{outside}");
        let wrong_method = net.send(request(1, "TRACE", "/api/me", &[], None)).await.unwrap_err();
        assert!(wrong_method.contains("not a request that this app makes"), "{wrong_method}");
        let wrong_path = net.send(request(1, "GET", "/other", &[], None)).await.unwrap_err();
        assert!(wrong_path.contains("account server"), "{wrong_path}");
        let big = net.send(request(1, "POST", "/api/x", &[], Some(&"x".repeat(MAX_BODY + 1)))).await.unwrap_err();
        assert!(big.contains("too big"), "{big}");
    }

    #[tokio::test]
    async fn says_that_the_server_is_not_there() {
        // a port that nobody listens on
        let port = { TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port() };
        let net = Net::new().unwrap();
        let failure = net.send(request(port, "GET", "/api/me", &[], None)).await.unwrap_err();
        assert!(!failure.is_empty());
        assert!(!failure.contains(&port.to_string()), "an address does not come back with a failure: {failure}");
    }

    /// By hand, against a real TLS server (`ZIM_TLS_URL=https://127.0.0.1:PORT/api/health [ZIM_TLS_EXPECT=refused] cargo test --bin zim-notebook-desktop tls -- --ignored --nocapture`):
    /// what the system's trusted authorities decide. A server whose certificate they do not vouch for is refused, with the reason in words (`ZIM_TLS_EXPECT=refused`); name the
    /// authority that made it in `SSL_CERT_FILE` (OpenSSL's own list of authorities, which is what Linux uses) and the same request goes through.
    #[tokio::test]
    #[ignore = "needs a TLS server: see the comment"]
    async fn a_server_with_a_certificate_that_the_system_does_not_trust_is_refused_and_one_it_trusts_is_not() {
        let url = std::env::var("ZIM_TLS_URL").expect("ZIM_TLS_URL names the server to ask");
        let net = Net::new().unwrap();
        let result = net.send(NetRequest { url, method: "GET".into(), headers: HashMap::new(), body: None }).await;
        if std::env::var("ZIM_TLS_EXPECT").as_deref() == Ok("refused") {
            let reason = result.unwrap_err();
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
        let failure = net.send(request(port, "GET", "/api/big", &[], None)).await.unwrap_err();
        assert!(failure.contains("too big"), "{failure}");
    }
}
