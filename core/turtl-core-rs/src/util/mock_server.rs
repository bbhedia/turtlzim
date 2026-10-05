//! A tiny HTTP/1.1 server for native tests: each connection gets a thread, every response closes
//! the connection, and a closure decides what to answer. On wasm32 the equivalent is the Node
//! `http` server in `js/test_support.js`; the routes in `api.rs`'s tests must match both.
//!
//! It is deliberately not a real HTTP implementation (no chunked bodies, no keep-alive): just
//! enough for the JSON requests the core makes.

use ::std::io::{BufRead, BufReader, Read, Write};
use ::std::net::{SocketAddr, TcpListener, TcpStream};
use ::std::sync::atomic::{AtomicBool, Ordering};
use ::std::sync::Arc;
use ::std::thread;
use ::std::time::Duration;

/// What the client sent.
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    /// The body as text (invalid UTF-8 replaced), for the JSON routes...
    pub body: String,
    /// ...and as it came, for the ones that take binary data.
    pub body_bytes: Vec<u8>,
}

impl Request {
    /// A header's value, looked up case-insensitively.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter()
            .find(|&&(ref k, _)| k.eq_ignore_ascii_case(name))
            .map(|&(_, ref v)| v.as_str())
    }
}

/// What to answer.
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    /// Wait this long before answering (to exercise client timeouts).
    pub delay_ms: u64,
}

impl Response {
    pub fn json(status: u16, body: &str) -> Response {
        Response { status: status, content_type: "application/json", body: Vec::from(body.as_bytes()), delay_ms: 0 }
    }

    pub fn text(status: u16, body: &str) -> Response {
        Response { status: status, content_type: "text/plain", body: Vec::from(body.as_bytes()), delay_ms: 0 }
    }

    /// Binary data
    pub fn bytes(status: u16, content_type: &'static str, body: Vec<u8>) -> Response {
        Response { status: status, content_type: content_type, body: body, delay_ms: 0 }
    }

    pub fn delayed(mut self, delay_ms: u64) -> Response {
        self.delay_ms = delay_ms;
        self
    }
}

/// A running server; it stops accepting connections when dropped.
pub struct MockServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
}

impl MockServer {
    /// Start a server on an ephemeral localhost port, answering every request with `route`.
    pub fn start<F>(route: F) -> MockServer
        where F: Fn(&Request) -> Response + Send + Sync + 'static
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("MockServer::start() -- bind failed");
        let addr = listener.local_addr().expect("MockServer::start() -- no local addr");
        listener.set_nonblocking(true).expect("MockServer::start() -- set_nonblocking failed");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_c = stop.clone();
        let route = Arc::new(route);
        thread::spawn(move || {
            while !stop_c.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let route = route.clone();
                        thread::spawn(move || { let _ = handle(stream, &*route); });
                    }
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        MockServer { addr: addr, stop: stop }
    }

    /// `http://127.0.0.1:<port>`, with no trailing slash.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn handle<F: Fn(&Request) -> Response>(stream: TcpStream, route: &F) -> ::std::io::Result<()> {
    // the accepted socket inherits the listener's non-blocking mode on some platforms
    stream.set_nonblocking(false)?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 { break; }
        let line = line.trim_end();
        if line.is_empty() { break; }
        if let Some(idx) = line.find(':') {
            let (name, value) = (line[..idx].trim().to_owned(), line[idx + 1..].trim().to_owned());
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            }
            headers.push((name, value));
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;

    let res = route(&Request {
        method: method,
        path: path,
        headers: headers,
        body: String::from_utf8_lossy(&body).into_owned(),
        body_bytes: body,
    });
    if res.delay_ms > 0 {
        thread::sleep(Duration::from_millis(res.delay_ms));
    }
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        res.status, reason(res.status), res.content_type, res.body.len()
    )?;
    out.write_all(&res.body)?;
    out.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    }
}
