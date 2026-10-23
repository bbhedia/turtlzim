// The requests to the account server. A session for the system's trust, or, for a server that has a certificate trusted for it, a session of its own whose handshake takes that certificate and
// nothing else: it is compared **in the handshake, before a byte of the request is sent** (the challenge for the server's trust is answered there), and there is no fallback to what the system
// trusts for that address. No redirect is followed (the token is for the server that was typed, and goes to no other), no cookie is kept or sent, nothing is cached, and an answer that is too big
// is cut off. The rules of what may be asked are in ZimNativeRules.
import Foundation
import Security
import ZimNativeRules

struct Answer {
    let status: Int
    let headers: [String: String]
    let body: String
}

final class Exchange: NSObject, URLSessionDataDelegate {
    private struct Pending {
        var response: HTTPURLResponse?
        var data = Data()
        var mismatch = false
        var tooBig = false
        let done: (Result<Answer, Failure>) -> Void
    }

    /// The 32 bytes of the certificate that this session takes, or nil for a session that takes what the system trusts.
    private let wanted: Data?
    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private var session: URLSession!

    init(wanted: Data?) {
        self.wanted = wanted
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 180
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func send(_ request: URLRequest, done: @escaping (Result<Answer, Failure>) -> Void) {
        let task = session.dataTask(with: request)
        lock.lock()
        pending[task.taskIdentifier] = Pending(done: done)
        lock.unlock()
        task.resume()
    }

    private func change(_ task: URLSessionTask, _ update: (inout Pending) -> Void) {
        lock.lock()
        if var found = pending[task.taskIdentifier] {
            update(&found)
            pending[task.taskIdentifier] = found
        }
        lock.unlock()
    }

    // MARK: - what happens to a request

    /// A redirect is the answer: it is not followed.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// The server's trust is judged here, in the handshake. With a certificate trusted for this server, only the certificate that has its fingerprint (as the first of what the server sent) is taken,
    /// and any other ends the connection before anything is sent; with none, the system judges. This app has no name and password and no certificate of its own to give.
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        guard let wanted = wanted else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
        if let first = chain.first, Rules.sha256(SecCertificateCopyData(first) as Data) == wanted {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            change(task) { $0.mismatch = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        change(dataTask) { $0.response = response as? HTTPURLResponse }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var stop = false
        change(dataTask) {
            $0.data.append(data)
            if $0.data.count > Rules.maxAnswer {
                $0.tooBig = true
                stop = true
            }
        }
        if stop { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let finished = pending.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let finished = finished else { return }
        if finished.tooBig {
            finished.done(.failure(Failure(message: "The server's answer is too big.", code: nil)))
        } else if let error = error {
            finished.done(.failure(Rules.describe(error, mismatch: finished.mismatch)))
        } else if let response = finished.response {
            var headers: [String: String] = [:]
            for (name, value) in response.allHeaderFields {
                guard let name = name as? String else { continue }
                let key = name.lowercased()
                let text = "\(value)"
                headers[key] = headers[key].map { "\($0), \(text)" } ?? text
            }
            finished.done(.success(Answer(status: response.statusCode, headers: headers, body: String(decoding: finished.data, as: UTF8.self))))
        } else {
            finished.done(.failure(Failure(message: "The request could not be made.", code: nil)))
        }
    }
}

/// The sessions, one for the system's trust and one for each certificate that was trusted (a connection made under one is reused only by requests that take the same one).
final class Sessions {
    private let lock = NSLock()
    private var byFingerprint: [Data: Exchange] = [:]
    private let system = Exchange(wanted: nil)

    func session(taking wanted: Data?) -> Exchange {
        guard let wanted = wanted else { return system }
        lock.lock()
        defer { lock.unlock() }
        if let known = byFingerprint[wanted] { return known }
        let made = Exchange(wanted: wanted)
        byFingerprint[wanted] = made
        return made
    }
}
