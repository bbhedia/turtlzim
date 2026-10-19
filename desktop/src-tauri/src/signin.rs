// Signing in to an account through the person's own browser (RFC 8252, "loopback interface redirection"). The program opens a port on this computer's own address, the page sends the
// person's browser to the server (web/src/account/native.ts), and when the person has signed in there and allowed the app, the server sends the browser to
// `http://127.0.0.1:<port>/callback?code=…&state=…`, which this port receives, once. Only that one request is answered as the answer: it must be a GET of `/callback`, with this computer's
// address as its Host (a page on the web can't make the person's browser ask this port by a name that it controls), and with the state that the page gave when it began (a request made by
// anything else that can reach this port can't be taken for the answer, and does not end the wait). The code is worth nothing without the secret that only the page knows.
use serde::Serialize;
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// How long the browser is waited for: long enough to sign in, read the page and perhaps make an account (a code is mailed), not so long that a port stays open all day.
pub const WAIT: Duration = Duration::from_secs(5 * 60);
/// How long a connection has to say what it wants: a browser that only opened a connection in advance (they do) does not hold up the one that has the answer.
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HEAD: usize = 8 * 1024;

/// What the browser came back with.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct Callback {
    pub code: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

/// An answer to a request on the port, before it is written.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub reason: &'static str,
    pub body: String,
}

fn page(status: u16, reason: &'static str, title: &str, text: &str, strip_address: bool) -> Answer {
    // (the page that says "you can close this" also takes the code out of the address bar, where it would stay in the browser's history)
    let script = if strip_address { "<script>history.replaceState(null,'','/')</script>" } else { "" };
    Answer { status, reason, body: format!("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font:16px system-ui,sans-serif;margin:3rem auto;max-width:30rem;padding:0 1rem}}</style><h1>{title}</h1><p>{text}</p>{script}") }
}

/// Whether `value` is something the page could have given as a state (what the server puts back in the address is only what was asked to be).
pub fn valid_state(value: &str) -> bool {
    (16..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What to answer to the head of a request that came to the port `port` while `state` is being waited for, and, if it is the answer that is being waited for, what it says.
pub fn answer(head: &str, port: u16, state: &str) -> (Answer, Option<Callback>) {
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target, version) = (first.next().unwrap_or(""), first.next().unwrap_or(""), first.next().unwrap_or(""));
    if !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        return (page(400, "Bad Request", "Not a request", "That is not a request that this app can answer.", false), None);
    }
    let host = lines.take_while(|line| !line.is_empty()).find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("host")).map(|(_, value)| value.trim().to_string())).unwrap_or_default();
    // (the address that the browser was sent to, and no other name for it)
    if host != format!("127.0.0.1:{port}") {
        return (page(400, "Bad Request", "Not for this app", "That request was not made to this app's own address.", false), None);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return (page(404, "Not Found", "Nothing here", "There is nothing at this address.", false), None);
    }
    if method != "GET" {
        return (page(405, "Method Not Allowed", "Not that way", "Use the link that the account's page gave.", false), None);
    }
    let (mut code, mut got_state, mut error) = (None, None, None);
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match name.as_ref() {
            "code" if value.len() <= 256 => code = Some(value.into_owned()),
            "state" if value.len() <= 256 => got_state = Some(value.into_owned()),
            "error" if value.len() <= 128 => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if got_state.as_deref() != Some(state) {
        return (page(400, "Bad Request", "Not this sign-in", "That is not the answer to the sign-in that was started in this app. Start it again from the app.", false), None);
    }
    if code.is_none() && error.is_none() {
        return (page(400, "Bad Request", "Nothing to take", "The answer has no code in it. Start the sign-in again from the app.", false), None);
    }
    let failed = error.is_some();
    let done = if failed { page(200, "OK", "Not allowed", "The app was not allowed. You can close this page and go back to the app.", true) } else { page(200, "OK", "Allowed", "You can close this page and go back to the app: it is signed in.", true) };
    (done, Some(Callback { code, state: state.to_string(), error }))
}

fn render(answer: &Answer) -> Vec<u8> {
    format!(
        "HTTP/1.1 {} {}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nreferrer-policy: no-referrer\r\ncontent-security-policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\r\nconnection: close\r\n\r\n{}",
        answer.status,
        answer.reason,
        answer.body.len(),
        answer.body
    )
    .into_bytes()
}

/// Read the head of a request (up to the empty line, at most `MAX_HEAD`), or nothing if the connection says nothing in time or says too much.
async fn read_head(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let reading = async {
        let mut seen = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let n = stream.read(&mut buffer).await.ok()?;
            if n == 0 {
                return None;
            }
            seen.extend_from_slice(&buffer[..n]);
            if let Some(end) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                return Some(String::from_utf8_lossy(&seen[..end]).into_owned());
            }
            if seen.len() > MAX_HEAD {
                return None;
            }
        }
    };
    tokio::time::timeout(HEAD_TIMEOUT, reading).await.ok().flatten()
}

struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

struct Attempt {
    listener: Option<TcpListener>,
    state: String,
    port: u16,
    cancel: Arc<Cancel>,
}

/// The sign-in that is going on, if any: one at a time (beginning another ends the first).
#[derive(Default)]
pub struct SignIn {
    attempt: Mutex<Option<Attempt>>,
}

impl SignIn {
    /// Open a port for the answer to a request that carries `state`; the port, and so the return address, is what comes back. A sign-in that was going on is ended.
    pub async fn begin(&self, state: &str) -> Result<u16, String> {
        if !valid_state(state) {
            return Err("That is not a state that a sign-in can have.".into());
        }
        self.cancel();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| format!("this computer would not open a port for the answer: {error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        *self.attempt.lock().map_err(|_| "the sign-in is in use".to_string())? = Some(Attempt { listener: Some(listener), state: state.to_string(), port, cancel: Arc::new(Cancel { flag: AtomicBool::new(false), notify: Notify::new() }) });
        Ok(port)
    }

    /// Stop waiting, and stop answering: the port is closed.
    pub fn cancel(&self) {
        if let Ok(mut attempt) = self.attempt.lock() {
            if let Some(attempt) = attempt.take() {
                attempt.cancel.flag.store(true, Ordering::SeqCst);
                attempt.cancel.notify.notify_waiters();
            }
        }
    }

    /// Wait for the browser to come back to the port: `opened` is called once, when the port is ready to be reached (the browser is sent for then, and not before, so that its answer
    /// can't arrive at nobody). Fails when cancelled or when `timeout` is over.
    pub async fn wait(&self, opened: impl FnOnce(), timeout: Duration) -> Result<Callback, String> {
        let (listener, state, port, cancel) = {
            let mut guard = self.attempt.lock().map_err(|_| "the sign-in is in use".to_string())?;
            let attempt = guard.as_mut().ok_or("No sign-in was begun, or it was cancelled.")?;
            (attempt.listener.take().ok_or("This sign-in is already being waited for.")?, attempt.state.clone(), attempt.port, attempt.cancel.clone())
        };
        let (found_tx, mut found) = tokio::sync::mpsc::unbounded_channel::<Callback>();
        let cancelled = cancel.notify.notified();
        tokio::pin!(cancelled);
        // (cancelled while this was being set up)
        if cancel.flag.load(Ordering::SeqCst) {
            return Err("The sign-in was cancelled.".into());
        }
        opened();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let result = loop {
            tokio::select! {
                _ = &mut cancelled => break Err("The sign-in was cancelled.".to_string()),
                _ = &mut deadline => break Err("The browser did not come back in time.".to_string()),
                Some(callback) = found.recv() => break Ok(callback),
                accepted = listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { continue };
                    let (state, found_tx) = (state.clone(), found_tx.clone());
                    // (each connection on its own, so that one that says nothing does not hold up the one that has the answer)
                    tokio::spawn(async move {
                        let Some(head) = read_head(&mut stream).await else { return };
                        let (said, callback) = answer(&head, port, &state);
                        let _ = stream.write_all(&render(&said)).await;
                        let _ = stream.shutdown().await;
                        if let Some(callback) = callback {
                            let _ = found_tx.send(callback);
                        }
                    });
                }
            }
        };
        // (the port is closed whatever came of it, and the attempt is over)
        drop(listener);
        if let Ok(mut guard) = self.attempt.lock() {
            if guard.as_ref().is_some_and(|a| Arc::ptr_eq(&a.cancel, &cancel)) {
                *guard = None;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpStream;

    const STATE: &str = "abcdefghijklmnopqrstuv";

    fn get(path: &str, host: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: test\r\n")
    }

    #[test]
    fn takes_only_the_answer_to_its_own_request() {
        let ok = answer(&get(&format!("/callback?code=C0DE&state={STATE}"), "127.0.0.1:49152"), 49152, STATE);
        assert_eq!(ok.0.status, 200);
        assert!(ok.0.body.contains("Allowed"));
        assert!(ok.0.body.contains("history.replaceState"), "the code leaves the address bar");
        assert_eq!(ok.1, Some(Callback { code: Some("C0DE".into()), state: STATE.into(), error: None }));
        // refused: it is answered, and the wait goes on
        let refused: [(&str, String); 11] = [
            ("another state", get("/callback?code=C0DE&state=somebody-elses-state", "127.0.0.1:49152")),
            ("no state", get("/callback?code=C0DE", "127.0.0.1:49152")),
            ("no code", get(&format!("/callback?state={STATE}"), "127.0.0.1:49152")),
            ("another path", get(&format!("/other?code=C0DE&state={STATE}"), "127.0.0.1:49152")),
            ("the favicon", get("/favicon.ico", "127.0.0.1:49152")),
            ("a name for this computer", get(&format!("/callback?code=C0DE&state={STATE}"), "localhost:49152")),
            ("a name that is not this computer's", get(&format!("/callback?code=C0DE&state={STATE}"), "evil.example:49152")),
            ("another port", get(&format!("/callback?code=C0DE&state={STATE}"), "127.0.0.1:49153")),
            ("no host", format!("GET /callback?code=C0DE&state={STATE} HTTP/1.1\r\nUser-Agent: test\r\n")),
            ("another method", format!("POST /callback?code=C0DE&state={STATE} HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n")),
            ("not a request", "hello".to_string()),
        ];
        for (what, head) in refused {
            let (said, callback) = answer(&head, 49152, STATE);
            assert!(callback.is_none(), "{what}");
            assert!(said.status >= 400, "{what}: {}", said.status);
        }
        // a refusal says nothing of what it was given
        let (said, _) = answer(&get("/callback?code=<script>alert(1)</script>&state=<b>x</b>", "127.0.0.1:49152"), 49152, STATE);
        assert!(!said.body.contains("alert") && !said.body.contains("<b>"), "{}", said.body);
        // an error with the right state is an answer too (the person was not allowed to, or said no)
        let (said, callback) = answer(&get(&format!("/callback?error=access_denied&state={STATE}"), "127.0.0.1:49152"), 49152, STATE);
        assert_eq!(said.status, 200);
        assert!(said.body.contains("Not allowed") && !said.body.contains("access_denied"));
        assert_eq!(callback.unwrap().error.as_deref(), Some("access_denied"));
        // what is percent-encoded is decoded, and what is too long is not taken
        let (_, callback) = answer(&get(&format!("/callback?code=a%2Bb%3D&state={STATE}"), "127.0.0.1:49152"), 49152, STATE);
        assert_eq!(callback.unwrap().code.as_deref(), Some("a+b="));
        let (_, callback) = answer(&get(&format!("/callback?code={}&state={STATE}", "x".repeat(300)), "127.0.0.1:49152"), 49152, STATE);
        assert!(callback.is_none());
    }

    #[test]
    fn a_state_is_what_the_page_can_have_made() {
        assert!(valid_state(STATE));
        assert!(valid_state(&"a".repeat(128)));
        for bad in ["", "short", &"a".repeat(129), "abcdefghijklmnop&code=1", "abcdefghijklmnop qrstuvwx", "abcdefghijklmnop\r\nxxxx"] {
            assert!(!valid_state(bad), "{bad:?}");
        }
    }

    async fn ask(port: u16, text: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(text.as_bytes()).await.unwrap();
        let mut said = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut said)).await;
        said
    }

    #[tokio::test]
    async fn waits_through_what_is_not_the_answer_and_ends_with_the_answer() {
        let signin = Arc::new(SignIn::default());
        let port = signin.begin(STATE).await.unwrap();
        let opened = Arc::new(AtomicBool::new(false));
        let waiting = {
            let (signin, opened) = (signin.clone(), opened.clone());
            tokio::spawn(async move { signin.wait(move || opened.store(true, Ordering::SeqCst), Duration::from_secs(20)).await })
        };
        while !opened.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // a connection that says nothing (a browser opening one in advance) does not hold up the others
        let idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        for (head, wanted) in [(get("/favicon.ico", &format!("127.0.0.1:{port}")), "404"), (get("/callback?code=X&state=not-the-state-at-all", &format!("127.0.0.1:{port}")), "400"), (get(&format!("/callback?code=X&state={STATE}"), "evil.example"), "400")] {
            let said = ask(port, &format!("{head}\r\n")).await;
            assert!(said.starts_with(&format!("HTTP/1.1 {wanted}")), "{said}");
        }
        assert!(!waiting.is_finished(), "none of that was the answer");
        let said = ask(port, &format!("{}\r\n", get(&format!("/callback?code=C0DE&state={STATE}"), &format!("127.0.0.1:{port}")))).await;
        assert!(said.starts_with("HTTP/1.1 200"), "{said}");
        assert!(said.contains("content-security-policy: default-src 'none'"), "{said}");
        assert!(said.contains("referrer-policy: no-referrer"));
        let back = waiting.await.unwrap().unwrap();
        assert_eq!(back, Callback { code: Some("C0DE".into()), state: STATE.into(), error: None });
        drop(idle);
        // the port is closed now, and there is nothing to wait for
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the port was closed");
        assert!(signin.wait(|| {}, Duration::from_secs(1)).await.is_err());
    }

    #[tokio::test]
    async fn stops_when_cancelled_when_time_is_up_and_when_another_is_begun() {
        // cancelled while waiting
        let signin = Arc::new(SignIn::default());
        let port = signin.begin(STATE).await.unwrap();
        let waiting = {
            let signin = signin.clone();
            tokio::spawn(async move { signin.wait(|| {}, Duration::from_secs(20)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        signin.cancel();
        assert!(waiting.await.unwrap().unwrap_err().contains("cancelled"));
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the port is closed");
        // cancelled before the wait began: the wait is over as it begins, and the browser is not sent for
        let port = signin.begin(STATE).await.unwrap();
        signin.cancel();
        let opened = Arc::new(AtomicBool::new(false));
        let flag = opened.clone();
        let failure = signin.wait(move || flag.store(true, Ordering::SeqCst), Duration::from_secs(20)).await.unwrap_err();
        assert!(failure.contains("No sign-in") || failure.contains("cancelled"), "{failure}");
        assert!(!opened.load(Ordering::SeqCst));
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        // time is up
        signin.begin(STATE).await.unwrap();
        let failure = signin.wait(|| {}, Duration::from_millis(100)).await.unwrap_err();
        assert!(failure.contains("did not come back in time"), "{failure}");
        // another begun while one is being waited for: the first ends, and the second is the one that counts
        let first = signin.begin(STATE).await.unwrap();
        let waiting = {
            let signin = signin.clone();
            tokio::spawn(async move { signin.wait(|| {}, Duration::from_secs(20)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = signin.begin("zyxwvutsrqponmlkjihgfedcba").await.unwrap();
        assert!(waiting.await.unwrap().unwrap_err().contains("cancelled"), "the first was ended by the second, not by the time running out");
        assert!(TcpStream::connect(("127.0.0.1", first)).await.is_err() || first == second);
        // a state that can't be one is not begun
        assert!(signin.begin("short").await.is_err());
        assert!(signin.begin("a&b=c-and-more-more-more").await.is_err());
    }

    #[tokio::test]
    async fn does_not_listen_beyond_this_computer() {
        let signin = SignIn::default();
        let port = signin.begin(STATE).await.unwrap();
        let guard = signin.attempt.lock().unwrap();
        let address = guard.as_ref().unwrap().listener.as_ref().unwrap().local_addr().unwrap();
        assert!(address.ip().is_loopback(), "{address}");
        assert_eq!(address.port(), port);
        assert!(port >= 1024, "a port that the server accepts");
    }

    #[tokio::test]
    async fn drops_a_head_that_is_too_long_without_answering_it() {
        let signin = Arc::new(SignIn::default());
        let port = signin.begin(STATE).await.unwrap();
        let waiting = {
            let signin = signin.clone();
            tokio::spawn(async move { signin.wait(|| {}, Duration::from_secs(20)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let began = std::time::Instant::now();
        let said = ask(port, &format!("GET /callback HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Long: {}", "a".repeat(MAX_HEAD + 100))).await;
        assert_eq!(said, "", "no answer to a head that has no end");
        // (dropped at once for being too long, not after the time that a connection that says nothing is given)
        assert!(began.elapsed() < HEAD_TIMEOUT / 2, "the connection was dropped at once, not after {:?}", began.elapsed());
        assert!(!waiting.is_finished());
        signin.cancel();
        let _ = waiting.await;
    }
}
