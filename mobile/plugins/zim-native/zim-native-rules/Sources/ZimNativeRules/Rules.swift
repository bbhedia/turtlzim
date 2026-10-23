// What the iPhone app may ask of the network, and with what: the rules of ZimNativePlugin, kept apart from the phone so that they are tried on a plain Mac (`swift test`). They are the rules of the
// Android app (mobile/android/.../AccountRules.java) and of the desktop program (desktop/src-tauri/src/account.rs), and the cases of their tests are the same: an https address (or http to this
// device's own address, which is how a server is tried out), an `/api/` path of the server, no name or password in the address, a few headers, and no redirect followed.
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// A request that is not to be made, with the reason in words for a person.
public struct Refused: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// A request that could not be made: the words for a person and, for the two ways that a certificate is refused, the code that the page acts on (else nil).
public struct Failure: Error, Equatable {
    public let message: String
    public let code: String?
    public init(message: String, code: String?) {
        self.message = message
        self.code = code
    }
}

public enum Rules {
    /// What the page may send along with a request: the others (a cookie, an origin, a referrer, whatever its engine adds) are the page's, and not an app's.
    public static let forwarded: Set<String> = ["authorization", "content-type", "x-requested-with", "accept"]
    /// The requests that this app makes.
    public static let methods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    /// The most that a request may carry and an answer may be (a notebook's files are sent as base64 in JSON; the server's own limits are well under these).
    public static let maxBody = 16 * 1024 * 1024
    public static let maxAnswer = 32 * 1024 * 1024
    /// The codes of a refusal for the sake of a certificate: the page acts on these two (`web/src/app/shell.ts` has them too).
    public static let certificateUntrusted = "certificate-untrusted"
    public static let certificateChanged = "certificate-changed"

    // MARK: - addresses

    /// Whether a host is this device's own: `localhost`, `::1`, or an address of 127.0.0.0/8.
    public static func isLoopback(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        if host == "localhost" || host == "::1" || host == "[::1]" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == "127" else { return false }
        return parts.allSatisfy { part in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(part) else { return false }
            return number <= 255
        }
    }

    /// What no address has: a control character, a space, and what a parser would read as something else than it was written (a backslash is a slash to some of them).
    private static func hasForbiddenCharacter(_ raw: String) -> Bool {
        let forbidden: Set<UInt32> = [0x5C, 0x3C, 0x3E, 0x22, 0x7B, 0x7D, 0x7C, 0x5E, 0x60]
        return raw.unicodeScalars.contains { $0.value <= 0x20 || $0.value == 0x7F || forbidden.contains($0.value) }
    }

    /// Whether a path, as it is written, leaves where it is by a dot segment (written in percent too, which the client's parser resolves: `%2e%2e`), or hides a slash (`%2f`, `%5c`).
    private static func escapesItsFolder(_ encodedPath: String) -> Bool {
        for segment in encodedPath.split(separator: "/", omittingEmptySubsequences: false) {
            let written = String(segment).lowercased()
            if written.contains("%2f") || written.contains("%5c") { return true }
            let decoded = (String(segment).removingPercentEncoding ?? String(segment)).lowercased()
            if decoded == ".." { return true }
        }
        return false
    }

    private static func parts(_ raw: String?) -> URLComponents? {
        guard let raw = raw, !raw.isEmpty, !hasForbiddenCharacter(raw), let parts = URLComponents(string: raw) else { return nil }
        if let port = parts.port, !(1...65535).contains(port) { return nil }
        return parts
    }

    /// The address of a request that may be made.
    public static func checkUrl(_ raw: String?) throws -> URL {
        guard let read = parts(raw), let scheme = read.scheme?.lowercased(), let host = read.host, !host.isEmpty else { throw Refused("That is not an address.") }
        switch scheme {
        case "https":
            break
        case "http":
            if !isLoopback(host) { throw Refused("A server that is not on this device has to be reached over https.") }
        default:
            throw Refused("That is not an address of a server.")
        }
        if read.user != nil || read.password != nil { throw Refused("There is no name or password in the address of the server.") }
        let path = read.percentEncodedPath
        if read.fragment != nil || !path.hasPrefix("/api/") || escapesItsFolder(path) { throw Refused("That is not a request to the account server.") }
        guard let url = read.url else { throw Refused("That is not an address.") }
        return url
    }

    /// The address of a server that a certificate can be trusted for (the page names it: `https://host:port`): https, a host, at most a port, and nothing after it. (A certificate is trusted for a
    /// server, not for a page of it; an address that is not https has no certificate to trust.)
    public static func checkOrigin(_ raw: String?) throws -> URLComponents {
        guard let read = parts(raw), read.scheme != nil, let host = read.host, !host.isEmpty else { throw Refused("That is not an address.") }
        if read.scheme?.lowercased() != "https" { throw Refused("A certificate can be trusted only for an https address.") }
        if read.user != nil || read.password != nil { throw Refused("There is no name or password in the address of the server.") }
        let path = read.percentEncodedPath
        if !(path.isEmpty || path == "/") || read.query != nil || read.fragment != nil { throw Refused("A certificate is trusted for a server, not for a page of it.") }
        return read
    }

    /// A host without the brackets that an IPv6 address is written in (some versions of Foundation give it with them, some without: what is made of it, a key or a connection, must not depend on which).
    public static func bareHost(_ host: String) -> String {
        guard host.count >= 2, host.hasPrefix("["), host.hasSuffix("]") else { return host }
        return String(host.dropFirst().dropLast())
    }

    /// The key that what is trusted for a server is kept under: `https://host:port`, the port always there (the default one written out), the host in lower case and an IPv6 address in brackets.
    public static func originKey(host: String, port: Int?) -> String {
        let name = bareHost(host).lowercased()
        return "https://\(name.contains(":") ? "[\(name)]" : name):\(port ?? 443)"
    }

    public static func originKey(of components: URLComponents) -> String {
        originKey(host: components.host ?? "", port: components.port)
    }

    public static func originKey(of url: URL) -> String? {
        guard let read = URLComponents(url: url, resolvingAgainstBaseURL: false), read.host != nil else { return nil }
        return originKey(of: read)
    }

    /// The address that the person's browser may be sent to (an https page, or one on this device): what the page may ask the app to open.
    public static func checkBrowserUrl(_ raw: String?) throws -> URL {
        guard let read = parts(raw), let scheme = read.scheme?.lowercased(), let host = read.host, !host.isEmpty, scheme == "https" || (scheme == "http" && isLoopback(host)) else {
            throw Refused("A browser is only sent to an https address (or to one on this device).")
        }
        if read.user != nil || read.password != nil { throw Refused("There is no name or password in the address of the server.") }
        guard let url = read.url else { throw Refused("That is not an address.") }
        return url
    }

    public static func forwards(_ headerName: String) -> Bool {
        forwarded.contains(headerName.lowercased())
    }

    /// Whether a name is one that a secret can have (it is part of the key that the keychain keeps it under).
    public static func validSecretName(_ name: String?) -> Bool {
        guard let name = name else { return false }
        return name.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil
    }

    // MARK: - fingerprints

    /// The SHA-256 of a certificate (as the server sent it: DER) as 32 pairs of capital hexadecimal digits with a colon between them, which is what `openssl x509 -noout -fingerprint -sha256` says.
    public static func fingerprint(of der: Data) -> String {
        format(sha256(der))
    }

    #if canImport(CryptoKit)
    public static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }
    #endif

    public static func format(_ digest: Data) -> String {
        digest.map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    /// The 32 bytes of a fingerprint written any of the usual ways (capitals or not, a colon or a space between the pairs, or nothing); nil if it is not exactly 32 bytes of hexadecimal.
    public static func parse(_ text: String?) -> Data? {
        guard let text = text else { return nil }
        let digits = text.filter { $0 != ":" && $0 != " " }
        guard digits.count == 64, digits.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        var bytes = Data(capacity: 32)
        var index = digits.startIndex
        for _ in 0..<32 {
            let next = digits.index(index, offsetBy: 2)
            guard let byte = UInt8(digits[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        return bytes
    }

    // MARK: - what went wrong

    /// The reason that the system gave for a failure, as a short line for a person: its first line, without a full stop or a colon at its end (empty when there is none).
    public static func reasonOf(_ error: NSError) -> String {
        var reason = error.localizedDescription
        if let end = reason.firstIndex(of: "\n") { reason = String(reason[reason.startIndex..<end]) }
        reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = reason.last, last == "." || last == ":" { reason.removeLast() }
        return reason.trimmingCharacters(in: .whitespaces)
    }

    /// A failure of a request in words that a person can act on (a certificate that this device does not trust is the one that matters most), with the code that the page acts on when it was
    /// about the certificate: the server showed another one than the one that was trusted for it (`mismatch`), or one that the system does not know.
    public static func describe(_ error: Error, mismatch: Bool = false) -> Failure {
        if mismatch { return Failure(message: "The server's certificate is not the one that you trusted for it.", code: certificateChanged) }
        if let refused = error as? Refused { return Failure(message: refused.message, code: nil) }
        let known = error as NSError
        if known.domain == NSURLErrorDomain {
            switch known.code {
            case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid:
                let reason = reasonOf(known)
                return Failure(message: "The server's certificate is not one that this device trusts" + (reason.isEmpty ? "" : " (\(reason))") + ".", code: certificateUntrusted)
            case NSURLErrorSecureConnectionFailed:
                return Failure(message: "A secure connection to the server could not be set up (\(reasonOf(known))).", code: nil)
            case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
                return Failure(message: "The server's name was not found: check the address, and that this device is online.", code: nil)
            case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet:
                return Failure(message: "The server did not answer: check the address, and that this device is online.", code: nil)
            case NSURLErrorTimedOut:
                return Failure(message: "The server took too long to answer.", code: nil)
            default:
                break
            }
        }
        let message = known.localizedDescription
        return Failure(message: message.isEmpty ? "The request could not be made." : message, code: nil)
    }
}
