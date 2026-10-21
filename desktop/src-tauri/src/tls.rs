// A server whose certificate the system does not know: a self-signed one, or one made by an authority of the person's own. The person is shown its fingerprint (SHA-256), compares it with
// the one that the server's own console shows, and says whether to trust it; what they trusted is kept by `pins.rs`, for that server's address only.
//
// What this file does is make the check where it can't be got around: in the handshake. A request to a server that has a certificate trusted for it goes over a connection that is made
// here, with whatever certificate the server shows taken as it comes (the system's own checks are what is refused to a server like this, and what makes `request` fail with
// `certificate-untrusted` for it), and **before a byte of the request is sent** the certificate that the server showed is compared with the one that was trusted: if it is another, nothing
// is sent, and the failure is `certificate-changed`. There is no fallback to what the system trusts for such an address (a certificate made by an authority that the system knows
// is a certificate of someone else's to this address, not the one that was trusted). The handshake itself proves that the server has the key of the certificate it showed.
//
// Looking at what a server shows (`present`) is a handshake and nothing more: no request is made, so nothing that the person has is sent to a server that they have not yet trusted.
use crate::account::{explain, NetFailure, NetResponse, FORWARDED, MAX_ANSWER, MAX_BODY};
use crate::pins::Pins;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use url::Url;

/// The codes of a refusal for the sake of a certificate (the page acts on these two: `web/src/app/shell.ts` has them too, and a test makes sure that they agree).
pub const CERTIFICATE_UNTRUSTED: &str = "certificate-untrusted";
pub const CERTIFICATE_CHANGED: &str = "certificate-changed";

/// How long to wait for a server to be reached and to answer the handshake, and for a whole request.
const CONNECT: Duration = Duration::from_secs(15);
const WHOLE: Duration = Duration::from_secs(120);

/// What the person is shown of a certificate: its fingerprint, which is what is compared and what is kept.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CertificateInfo {
    pub fingerprint: String,
}

/// The SHA-256 of a certificate (as the server sent it: DER) as 32 pairs of capital hexadecimal digits with a colon between them, which is what `openssl x509 -noout -fingerprint -sha256` says.
pub fn fingerprint(der: &[u8]) -> String {
    format_fingerprint(&Sha256::digest(der))
}

fn format_fingerprint(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":")
}

/// The 32 bytes of a fingerprint written any of the usual ways (capitals or not, a colon or a space between the pairs, or nothing); nothing if it is not exactly 32 bytes of hexadecimal.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    let digits: Vec<u8> = text.bytes().filter(|byte| !matches!(byte, b':' | b' ')).collect();
    if digits.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in digits.chunks(2).enumerate() {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        bytes[index] = (high * 16 + low) as u8;
    }
    Some(bytes)
}

/// The address of a server that a certificate can be trusted for: https, a host, and at most a port. (A certificate is trusted for a server, not for a page of it.)
pub fn check_origin(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "That is not an address.".to_string())?;
    if url.scheme() != "https" {
        return Err("A certificate can be trusted only for an https address.".into());
    }
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("There is no name or password in the address of the server.".into());
    }
    if (url.path() != "/" && !url.path().is_empty()) || url.query().is_some() || url.fragment().is_some() {
        return Err("A certificate is trusted for a server, not for a page of it.".into());
    }
    Ok(url)
}

/// The key that what is trusted for a server is kept under: `https://host:port`, the port always there (the default one written out) and the host as the address parser writes it. Nothing
/// for an address that is not https: no certificate is trusted for it.
pub fn origin_key(url: &Url) -> Option<String> {
    if url.scheme() != "https" {
        return None;
    }
    Some(format!("https://{}:{}", url.host_str()?, url.port_or_known_default()?))
}

/// `origin_key` of an address as it is written (the address of a request, or an origin).
pub fn origin_of(raw: &str) -> Option<String> {
    origin_key(&Url::parse(raw).ok()?)
}

type Stream = tokio_native_tls::TlsStream<TcpStream>;

/// Reach a server and make the handshake, taking whatever certificate it shows. Nothing is sent but the handshake: what to make of the certificate is for the caller to say before it sends
/// anything else. (The system's checks of the certificate and of its name are off here and only here, because the caller makes the one that counts.)
async fn connect(url: &Url) -> Result<Stream, NetFailure> {
    let host = url.host_str().ok_or_else(|| NetFailure::from("That is not an address."))?;
    let bare = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port_or_known_default().ok_or_else(|| NetFailure::from("That is not an address."))?;
    let reach = async {
        let tcp = TcpStream::connect((bare.as_str(), port)).await.map_err(|error| error.to_string())?;
        let connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
            .build()
            .map_err(|error| error.to_string())?;
        tokio_native_tls::TlsConnector::from(connector).connect(&bare, tcp).await.map_err(|error| error.to_string())
    };
    match timeout(CONNECT, reach).await {
        Err(_) => Err("The server took too long to answer.".to_string().into()),
        Ok(Err(said)) => Err(explain(&said).into()),
        Ok(Ok(stream)) => Ok(stream),
    }
}

/// The certificate that the server showed (its own, the first of the chain), as the bytes it sent.
fn shown(stream: &Stream) -> Result<Vec<u8>, NetFailure> {
    let certificate = stream.get_ref().peer_certificate().map_err(|error| NetFailure::from(error.to_string()))?.ok_or_else(|| NetFailure::from("The server showed no certificate."))?;
    certificate.to_der().map_err(|error| NetFailure::from(error.to_string()))
}

/// What a server shows as its certificate, found out by a handshake and nothing else: no request is made, and the connection is closed as soon as the certificate is read.
pub async fn present(url: &Url) -> Result<Vec<u8>, NetFailure> {
    let stream = connect(url).await?;
    shown(&stream)
}

/// What the server at `origin` shows, for the person to look at.
pub async fn inspect(origin: &str) -> Result<CertificateInfo, NetFailure> {
    let url = check_origin(origin)?;
    Ok(CertificateInfo { fingerprint: fingerprint(&present(&url).await?) })
}

/// Trust, for the server at `origin`, the certificate that has this fingerprint. The server is looked at again now, and nothing is kept unless it shows that certificate: what the person was
/// shown is not taken for what the server shows now.
pub async fn trust(pins: &Pins, origin: &str, wanted: &str) -> Result<(), NetFailure> {
    let url = check_origin(origin)?;
    let wanted = parse_fingerprint(wanted).ok_or_else(|| NetFailure::from("That is not a fingerprint."))?;
    let key = origin_key(&url).ok_or_else(|| NetFailure::from("A certificate can be trusted only for an https address."))?;
    let der = present(&url).await?;
    if Sha256::digest(&der).as_slice() != wanted.as_slice() {
        return Err(NetFailure::coded(CERTIFICATE_CHANGED, "The server shows another certificate now, so nothing was trusted."));
    }
    pins.set(&key, &format_fingerprint(&wanted))?;
    Ok(())
}

/// A request to a server that a certificate was trusted for, with the fingerprint of that certificate: made over a connection whose certificate is checked before anything is sent on it,
/// and over no other. (The server is reached directly, not through a proxy: a proxy that could be asked to tunnel to it is one more thing between the person and a server that they
/// trusted by a fingerprint.)
pub async fn send_pinned(url: &Url, pin: &[u8; 32], method: reqwest::Method, headers: &HashMap<String, String>, body: Option<String>) -> Result<NetResponse, NetFailure> {
    if body.as_ref().is_some_and(|text| text.len() > MAX_BODY) {
        return Err("That request is too big.".to_string().into());
    }
    let stream = connect(url).await?;
    // (the check that counts: what the server showed against what was trusted, with nothing sent yet; a stream that is dropped here has sent nothing but the handshake)
    if Sha256::digest(shown(&stream)?).as_slice() != pin {
        return Err(NetFailure::coded(CERTIFICATE_CHANGED, "The server's certificate is not the one that you trusted for it."));
    }
    let host = url.host_str().unwrap_or_default();
    let host_header = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let target = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let mut builder = hyper::Request::builder().method(method).uri(target).header("host", host_header).header("user-agent", concat!("ZimNotebook/", env!("CARGO_PKG_VERSION"))).header("connection", "close");
    for (name, value) in headers {
        if FORWARDED.contains(&name.to_ascii_lowercase().as_str()) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    let request = builder.body(Full::new(Bytes::from(body.unwrap_or_default().into_bytes()))).map_err(|error| NetFailure::from(format!("That request can't be made: {error}")))?;
    let whole = async {
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|error| error.to_string())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let response = sender.send_request(request).await.map_err(|error| error.to_string())?;
        let (parts, mut incoming) = response.into_parts();
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(frame) = incoming.frame().await {
            let frame = frame.map_err(|error| error.to_string())?;
            if let Some(data) = frame.data_ref() {
                if bytes.len() + data.len() > MAX_ANSWER {
                    return Err("The server's answer is too big.".to_string());
                }
                bytes.extend_from_slice(data);
            }
        }
        let headers = parts.headers.iter().filter_map(|(name, value)| value.to_str().ok().map(|v| (name.as_str().to_string(), v.to_string()))).collect();
        Ok(NetResponse { status: parts.status.as_u16(), headers, body: String::from_utf8_lossy(&bytes).into_owned() })
    };
    match timeout(WHOLE, whole).await {
        Err(_) => Err("The server took too long to answer.".to_string().into()),
        Ok(Err(said)) => Err(explain(&said).into()),
        Ok(Ok(response)) => Ok(response),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{Net, NetRequest};
    use std::fs;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    // two certificates that nothing trusts (testdata/README.md), each with the key that goes with it, in a PKCS#12 file with a password, and what `openssl x509 -fingerprint -sha256` says of each:
    // a known answer that does not come from this file's own code
    const CERT_A: &str = include_str!("../testdata/pin-a.pem");
    const IDENTITY_A: &[u8] = include_bytes!("../testdata/pin-a.p12");
    const CERT_B: &str = include_str!("../testdata/pin-b.pem");
    const IDENTITY_B: &[u8] = include_bytes!("../testdata/pin-b.p12");
    const PASSWORD: &str = "zim-test";
    const FP_A: &str = "93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55";
    const FP_B: &str = "AA:5A:95:F1:7D:5A:44:04:6D:FD:8C:04:E4:F0:16:21:5C:57:E6:13:B6:D0:71:5E:EC:CA:65:ED:8E:DD:12:92";

    fn der_of(pem: &str) -> Vec<u8> {
        let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
        // (a minimal base64 decoder: this file's tests ask for nothing else of base64)
        let mut bits = 0u32;
        let mut count = 0;
        let mut out = Vec::new();
        for byte in body.bytes().filter(|b| *b != b'=') {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => panic!("not base64"),
            } as u32;
            bits = (bits << 6) | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
        }
        out
    }

    /// A TLS server on this computer that shows one of the two certificates and answers every request with `answer` (sent as it is). What each connection sent after the handshake, as the
    /// server read it, comes out of the channel when that connection is over (nothing, if the client left after the handshake).
    async fn serves_tls(identity: &[u8], answer: String) -> (u16, UnboundedReceiver<Vec<u8>>) {
        let identity = native_tls::Identity::from_pkcs12(identity, PASSWORD).unwrap();
        let acceptor = tokio_native_tls::TlsAcceptor::from(native_tls::TlsAcceptor::new(identity).unwrap());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { return };
                let (tx, answer, acceptor) = (tx.clone(), answer.clone(), acceptor.clone());
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else { return drop(tx.send(Vec::new())) };
                    let mut seen = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        let n = tls.read(&mut buffer).await.unwrap_or(0);
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
                    let had_something = !seen.is_empty();
                    let _ = tx.send(seen);
                    if had_something {
                        let _ = tls.write_all(answer.as_bytes()).await;
                    }
                    let _ = tls.shutdown().await;
                });
            }
        });
        (port, rx)
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-answer: yes\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    fn url(port: u16, path: &str) -> Url {
        Url::parse(&format!("https://127.0.0.1:{port}{path}")).unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
    }

    #[test]
    fn writes_a_fingerprint_as_openssl_does_and_reads_it_however_it_is_written() {
        // a known answer: the certificate's SHA-256, as `openssl x509 -fingerprint -sha256` said it when the file was made
        assert_eq!(fingerprint(&der_of(CERT_A)), FP_A);
        assert_eq!(fingerprint(&der_of(CERT_B)), FP_B);
        assert_eq!(fingerprint(b""), "E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55");
        let bytes = parse_fingerprint(FP_A).unwrap();
        assert_eq!(format_fingerprint(&bytes), FP_A);
        for written in [FP_A.to_lowercase(), FP_A.replace(':', " "), FP_A.replace(':', ""), format!("  {FP_A} ")] {
            assert_eq!(parse_fingerprint(&written), Some(bytes), "{written}");
        }
        for wrong in ["", "93:B9", &FP_A[..FP_A.len() - 3], &format!("{FP_A}:00"), &FP_A.replace('9', "G"), &FP_A.replace(':', "-"), "zz"] {
            assert_eq!(parse_fingerprint(wrong), None, "{wrong}");
        }
        // (the last digit counts: a fingerprint that differs by one digit is another one)
        let mut other = FP_A.to_string();
        other.pop();
        other.push('4');
        assert_ne!(parse_fingerprint(&other), Some(bytes));
    }

    #[test]
    fn trusts_a_certificate_for_a_server_and_not_for_a_page_of_it_or_for_an_address_that_is_not_https() {
        for good in ["https://notes.example.org", "https://notes.example.org:8443", "https://notes.example.org:8443/", "https://192.168.10.10:8443", "https://[::1]:8443"] {
            assert!(check_origin(good).is_ok(), "{good}");
        }
        for bad in ["http://notes.example.org", "http://127.0.0.1:8080", "ftp://notes.example.org", "https://ada:secret@notes.example.org", "https://notes.example.org/api/me", "https://notes.example.org/?x=1", "https://notes.example.org/#x", "https://", "not an address", ""] {
            assert!(check_origin(bad).is_err(), "{bad}");
        }
        // the key is the origin, the port always written, so that one server is one key whichever way its address was typed
        assert_eq!(origin_of("https://Notes.Example.org/api/me").as_deref(), Some("https://notes.example.org:443"));
        assert_eq!(origin_of("https://notes.example.org:443/api/me").as_deref(), Some("https://notes.example.org:443"));
        assert_eq!(origin_of("https://notes.example.org:8443/api/me?x=1").as_deref(), Some("https://notes.example.org:8443"));
        assert_eq!(origin_of("https://[::1]:8443/api/me").as_deref(), Some("https://[::1]:8443"));
        assert_eq!(origin_of("https://192.168.10.10:8443").as_deref(), Some("https://192.168.10.10:8443"));
        assert_eq!(origin_of("http://127.0.0.1:8080/api/me"), None, "an address that is not https has nothing trusted for it");
        assert_eq!(origin_of("not an address"), None);
    }

    #[tokio::test]
    async fn looks_at_a_certificate_that_a_server_shows_without_sending_it_anything() {
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{}")).await;
        let shown = inspect(&format!("https://127.0.0.1:{port}")).await.unwrap();
        assert_eq!(shown.fingerprint, FP_A);
        // the server saw a handshake and not one byte after it
        assert_eq!(seen.recv().await.unwrap(), Vec::<u8>::new());
        let (port, _) = serves_tls(IDENTITY_B, ok("{}")).await;
        assert_eq!(inspect(&format!("https://127.0.0.1:{port}/")).await.unwrap().fingerprint, FP_B);
        // what is not an origin is not looked at, and a server that is not there is said to be
        assert!(inspect("https://127.0.0.1:1/api/me").await.unwrap_err().message.contains("not for a page"));
        let nobody = { TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port() };
        let failure = inspect(&format!("https://127.0.0.1:{nobody}")).await.unwrap_err();
        assert_eq!(failure.code, None);
        assert!(!failure.message.is_empty());
        assert!(!failure.message.contains(&nobody.to_string()), "an address does not come back with a failure: {}", failure.message);
        assert_eq!(inspect("http://127.0.0.1:1").await.unwrap_err().code, None);
    }

    #[tokio::test]
    async fn asks_a_server_it_trusts_the_way_an_app_asks_and_gives_back_what_it_answered() {
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{\"user\":null}")).await;
        let pin = parse_fingerprint(FP_A).unwrap();
        let sent = headers(&[("Authorization", "Bearer t0ken"), ("content-type", "application/json"), ("X-Requested-With", "zim"), ("cookie", "zim=stolen"), ("Origin", "https://evil.example"), ("x-made-up", "1")]);
        let answer = send_pinned(&url(port, "/api/sync/x?y=1"), &pin, reqwest::Method::POST, &sent, Some("{\"a\":1}".into())).await.unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, "{\"user\":null}");
        assert_eq!(answer.headers.get("x-answer").map(String::as_str), Some("yes"));
        assert_eq!(answer.headers.get("content-type").map(String::as_str), Some("application/json"));
        let head = String::from_utf8(seen.recv().await.unwrap()).unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /api/sync/x?y=1 http/1.1"), "{head}");
        assert!(head.contains(&format!("host: 127.0.0.1:{port}")), "{head}");
        assert!(head.contains("authorization: bearer t0ken"), "{head}");
        assert!(head.contains("x-requested-with: zim"), "{head}");
        assert!(head.contains("content-type: application/json"), "{head}");
        assert!(head.contains("user-agent: zimnotebook/"), "{head}");
        assert!(head.ends_with("{\"a\":1}"), "{head}");
        for left_out in ["cookie", "origin", "x-made-up"] {
            assert!(!head.contains(&format!("{left_out}:")), "{left_out} went on: {head}");
        }
        // every kind of request that the app makes, with no body for the ones that have none
        for method in [reqwest::Method::GET, reqwest::Method::DELETE, reqwest::Method::PUT, reqwest::Method::PATCH] {
            let carries = method == reqwest::Method::PUT || method == reqwest::Method::PATCH;
            let answer = send_pinned(&url(port, "/api/x"), &pin, method.clone(), &headers(&[]), carries.then(|| "{}".to_string())).await.unwrap();
            assert_eq!(answer.status, 200, "{method}");
            assert!(String::from_utf8(seen.recv().await.unwrap()).unwrap().starts_with(&format!("{method} /api/x ")), "{method}");
        }
    }

    #[tokio::test]
    async fn sends_nothing_to_a_server_that_shows_another_certificate_than_the_one_that_was_trusted() {
        // trusted: A. The server shows B.
        let (port, mut seen) = serves_tls(IDENTITY_B, ok("{\"secret\":\"answer\"}")).await;
        let pin = parse_fingerprint(FP_A).unwrap();
        let failure = send_pinned(&url(port, "/api/me"), &pin, reqwest::Method::GET, &headers(&[("authorization", "Bearer t0ken-that-must-not-leave")]), None).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_CHANGED));
        assert!(failure.message.contains("not the one that you trusted"), "{}", failure.message);
        assert!(!failure.message.contains(&port.to_string()), "an address does not come back with a failure: {}", failure.message);
        // what the server read after the handshake: nothing (the token did not leave)
        assert_eq!(seen.recv().await.unwrap(), Vec::<u8>::new());
        // a pin that differs from the certificate by one digit is not the certificate
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{}")).await;
        let mut nearly = parse_fingerprint(FP_A).unwrap();
        nearly[31] ^= 1;
        let failure = send_pinned(&url(port, "/api/me"), &nearly, reqwest::Method::GET, &headers(&[("authorization", "Bearer t0ken")]), Some("{}".into())).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_CHANGED));
        assert_eq!(seen.recv().await.unwrap(), Vec::<u8>::new());
        // and the one that was trusted is taken at once on the next try
        let answer = send_pinned(&url(port, "/api/me"), &parse_fingerprint(FP_A).unwrap(), reqwest::Method::GET, &headers(&[]), None).await.unwrap();
        assert_eq!(answer.status, 200);
    }

    #[tokio::test]
    async fn does_not_take_what_is_too_big_in_either_direction_and_says_that_a_server_is_not_there() {
        let pin = parse_fingerprint(FP_A).unwrap();
        let (port, _) = serves_tls(IDENTITY_A, ok(&"x".repeat(MAX_ANSWER + 1))).await;
        let failure = send_pinned(&url(port, "/api/big"), &pin, reqwest::Method::GET, &headers(&[]), None).await.unwrap_err();
        assert_eq!(failure.message, "The server's answer is too big.");
        // (a server that would answer, with something small: the request itself is what is too big, and it is not sent)
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{}")).await;
        let failure = send_pinned(&url(port, "/api/x"), &pin, reqwest::Method::POST, &headers(&[]), Some("x".repeat(MAX_BODY + 1))).await.unwrap_err();
        assert_eq!(failure.message, "That request is too big.");
        assert!(seen.try_recv().is_err(), "nothing was sent: the server saw no connection");
        let nobody = { TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port() };
        let failure = send_pinned(&url(nobody, "/api/me"), &pin, reqwest::Method::GET, &headers(&[]), None).await.unwrap_err();
        assert!(!failure.message.is_empty());
        assert_eq!(failure.code, None, "a server that is down is not a certificate");
    }

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("zim-tls-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    #[tokio::test]
    async fn goes_the_way_that_what_is_trusted_for_a_server_says() {
        let dir = folder("route");
        let pins = Pins::new(dir.clone());
        let net = Net::new().unwrap();
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{\"user\":null}")).await;
        let origin = format!("https://127.0.0.1:{port}");
        let key = origin_of(&origin).unwrap();
        let ask = |pin: Option<String>| {
            let net = &net;
            let request = NetRequest { url: format!("{origin}/api/me"), method: "GET".into(), headers: headers(&[("authorization", "Bearer t0ken-that-must-not-leave")]), body: None };
            async move { net.send(request, pin.as_deref()).await }
        };
        // nothing is trusted for it and the system does not know the certificate: refused, as the system refuses it, with the code that the page acts on, and with nothing sent
        let failure = ask(pins.get(&key)).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_UNTRUSTED), "{}", failure.message);
        assert!(failure.message.contains("not one that this computer trusts"), "{}", failure.message);
        assert_eq!(seen.recv().await.unwrap(), Vec::<u8>::new(), "the token did not leave");
        // trusted: the request is made, over that certificate
        trust(&pins, &origin, FP_A).await.unwrap();
        let answer = ask(pins.get(&key)).await.unwrap();
        assert_eq!((answer.status, answer.body.as_str()), (200, "{\"user\":null}"));
        // what was trusted for one server says nothing of another: a server that shows the other certificate on another port is refused as the system refuses it
        let (other, mut seen_other) = serves_tls(IDENTITY_B, ok("{}")).await;
        let other_origin = format!("https://127.0.0.1:{other}");
        let request = NetRequest { url: format!("{other_origin}/api/me"), method: "GET".into(), headers: headers(&[("authorization", "Bearer t0ken")]), body: None };
        let failure = net.send(request, pins.get(&origin_of(&other_origin).unwrap()).as_deref()).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_UNTRUSTED));
        assert_eq!(seen_other.recv().await.unwrap(), Vec::<u8>::new());
        // what was trusted for a server that shows another certificate now: refused as changed, with nothing sent, whatever the system thinks of the certificate it shows
        pins.set(&origin_of(&other_origin).unwrap(), FP_A).unwrap();
        let request = NetRequest { url: format!("{other_origin}/api/me"), method: "GET".into(), headers: headers(&[("authorization", "Bearer t0ken")]), body: None };
        let failure = net.send(request, pins.get(&origin_of(&other_origin).unwrap()).as_deref()).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_CHANGED));
        assert_eq!(seen_other.recv().await.unwrap(), Vec::<u8>::new());
        // a trust that can't be read is no trust at all (the system is asked, and refuses): never a way round
        let failure = ask(Some("not a fingerprint".into())).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_UNTRUSTED));
        // and nothing is trusted for an address that is not https
        let plain = net.send(NetRequest { url: "http://127.0.0.1:1/api/me".into(), method: "GET".into(), headers: HashMap::new(), body: None }, Some(FP_A)).await.unwrap_err();
        assert_eq!(plain.code, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn trusts_a_certificate_only_if_the_server_shows_it_now() {
        let dir = folder("trust");
        let pins = Pins::new(dir.clone());
        let (port, mut seen) = serves_tls(IDENTITY_A, ok("{}")).await;
        let origin = format!("https://127.0.0.1:{port}");
        let key = origin_of(&origin).unwrap();
        // the person was shown B, and the server shows A now: nothing is kept
        let failure = trust(&pins, &origin, FP_B).await.unwrap_err();
        assert_eq!(failure.code, Some(CERTIFICATE_CHANGED));
        assert_eq!(pins.get(&key), None);
        // what is not a fingerprint, and what is not an origin, is refused before the server is asked
        assert!(trust(&pins, &origin, "not a fingerprint").await.is_err());
        assert!(trust(&pins, &format!("{origin}/api/me"), FP_A).await.is_err());
        assert!(trust(&pins, "http://127.0.0.1:1", FP_A).await.is_err());
        assert_eq!(pins.get(&key), None);
        // A is what it shows: it is kept, written as the program writes a fingerprint whatever way it came
        trust(&pins, &origin, &FP_A.to_lowercase().replace(':', " ")).await.unwrap();
        assert_eq!(pins.get(&key).as_deref(), Some(FP_A));
        // (the server saw handshakes and nothing else)
        while let Ok(read) = seen.try_recv() {
            assert!(read.is_empty());
        }
        // a new trust replaces the old one
        let (second, _) = serves_tls(IDENTITY_B, ok("{}")).await;
        let other = format!("https://127.0.0.1:{second}");
        trust(&pins, &other, FP_B).await.unwrap();
        assert_eq!(pins.get(&origin_of(&other).unwrap()).as_deref(), Some(FP_B));
        assert_eq!(pins.get(&key).as_deref(), Some(FP_A), "another server's stays");
        let _ = fs::remove_dir_all(&dir);
    }
}
