// The rules of what the iPhone app asks of the network (Rules.swift), with the cases of the Android app's tests (AccountRulesTest.java, PinnedTrustTest.java) and the desktop program's (account.rs).
import XCTest
@testable import ZimNativeRules

final class RulesTests: XCTestCase {
    private func assertRefused(_ raw: String?, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try Rules.checkUrl(raw), "was not refused: \(String(describing: raw))", file: file, line: line) { error in
            XCTAssertFalse((error as? Refused)?.message.isEmpty ?? true, file: file, line: line)
        }
    }

    func testOnlyAServerThatCanBeTrustedWithATokenIsAsked() throws {
        for good in [
            "https://notes.example.org/api/me",
            "https://notes.example.org:8443/api/sync/notebooks?x=1",
            "http://127.0.0.1:8080/api/me",
            "http://localhost:3000/api/me",
            "http://[::1]:8080/api/me",
            "http://127.0.0.2:80/api/me",
            "HTTPS://Notes.Example.org/api/me",
            "https://notes.example.org/api/./me",
            "https://notes.example.org/api/a%2eb",
        ] {
            let url = try Rules.checkUrl(good)
            XCTAssertEqual(url.absoluteString.lowercased(), good.lowercased(), good)
        }
        for bad in [
            "http://notes.example.org/api/me",
            "http://192.168.1.10/api/me",
            "http://127.0.0.1.example.org/api/me",
            "http://localhost.example.org/api/me",
            "http://128.0.0.1/api/me",
            "http://127.0.0.256/api/me",
            "ftp://notes.example.org/api/me",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://ada:secret@notes.example.org/api/me",
            "https://ada@notes.example.org/api/me",
            "http://127.0.0.1@evil.example/api/me",
            "https://notes.example.org/other",
            "https://notes.example.org/api",
            "https://notes.example.org/apix/me",
            "https://notes.example.org/api/me#x",
            "https://notes.example.org/api/../etc/passwd",
            // a dot segment written in percent: the client's parser resolves it, so the request would leave /api/
            "https://notes.example.org/api/%2e%2e/etc/passwd",
            "https://notes.example.org/api/%2E%2E/etc/passwd",
            "https://notes.example.org/api/.%2e/etc/passwd",
            "https://notes.example.org/api/%2e./etc/passwd",
            "https://notes.example.org/api/x/%2e%2e/%2e%2e/y",
            "https://notes.example.org/api/%2e%2e",
            // a slash that is not written as one (the server and the client may read it differently)
            "https://notes.example.org/api/x%2fy",
            "https://notes.example.org/api/x%5cy",
            // an address that the client cannot read at all (a port that is no port, a space, a backslash)
            "https://notes.example.org:99999/api/me",
            "https://notes.example.org/api/a b",
            "https://notes.example.org\\@evil.example/api/me",
            "not an address",
            "",
        ] {
            assertRefused(bad)
        }
        assertRefused(nil)
    }

    func testACertificateIsTrustedForAServerAndNotForAPageOfItOrForAnAddressThatIsNotHttps() throws {
        for good in ["https://notes.example.org", "https://notes.example.org:8443", "https://notes.example.org:8443/", "https://192.168.10.10:8443", "https://[::1]:8443", "HTTPS://Notes.Example.org"] {
            XCTAssertNoThrow(try Rules.checkOrigin(good), good)
        }
        for bad in ["http://notes.example.org", "http://127.0.0.1:8080", "ftp://notes.example.org", "https://ada:secret@notes.example.org", "https://ada@notes.example.org", "https://notes.example.org/api/me", "https://notes.example.org:8443/x", "https://notes.example.org?x=1", "https://notes.example.org#x", "notes.example.org", "", "https://"] {
            XCTAssertThrowsError(try Rules.checkOrigin(bad), "was not refused: \(bad)")
        }
        XCTAssertThrowsError(try Rules.checkOrigin(nil))
        // the key is the origin, the port always written, so that one server is one key whichever way its address was typed
        XCTAssertEqual(Rules.originKey(of: try Rules.checkOrigin("https://Notes.Example.org/")), "https://notes.example.org:443")
        XCTAssertEqual(Rules.originKey(of: try Rules.checkOrigin("https://notes.example.org:443")), "https://notes.example.org:443")
        XCTAssertEqual(Rules.originKey(of: try Rules.checkOrigin("https://notes.example.org:8443")), "https://notes.example.org:8443")
        XCTAssertEqual(Rules.originKey(of: try Rules.checkOrigin("https://192.168.10.10:8443")), "https://192.168.10.10:8443")
        XCTAssertEqual(Rules.originKey(of: try Rules.checkOrigin("https://[::1]:8443")), "https://[::1]:8443")
        // and the address of a request has the same key as the origin that its server was trusted under
        XCTAssertEqual(Rules.originKey(of: URL(string: "https://notes.example.org:8443/api/sync/x?y=1")!), "https://notes.example.org:8443")
    }

    func testTheBrowserIsSentOnlyWhereAPersonWouldGo() throws {
        for good in ["https://notes.example.org/?app=authorize&state=x", "http://127.0.0.1:8080/?app=authorize", "http://localhost:3000/"] {
            XCTAssertNoThrow(try Rules.checkBrowserUrl(good), good)
        }
        for bad in ["http://notes.example.org/", "file:///etc/passwd", "javascript:alert(1)", "ftp://notes.example.org/", "https://ada:secret@notes.example.org/", "mailto:a@b.c", "org.zimnotebook.app:/callback?code=x", "", "not an address"] {
            XCTAssertThrowsError(try Rules.checkBrowserUrl(bad), "was not refused: \(bad)")
        }
        XCTAssertThrowsError(try Rules.checkBrowserUrl(nil))
    }

    func testARequestCarriesTheHeadersOfAnAppAndNoOthers() {
        for name in ["Authorization", "content-type", "X-Requested-With", "ACCEPT"] { XCTAssertTrue(Rules.forwards(name), name) }
        for name in ["cookie", "Origin", "referer", "x-made-up", "host", "content-length", ""] { XCTAssertFalse(Rules.forwards(name), name) }
        XCTAssertTrue(Rules.methods.contains("PATCH"))
        XCTAssertFalse(Rules.methods.contains("TRACE"))
    }

    func testASecretsNameIsNotAPath() {
        XCTAssertTrue(Rules.validSecretName("account-token"))
        for bad in ["", "a/b", "../x", ".hidden", "a b", "a.b", String(repeating: "a", count: 65)] { XCTAssertFalse(Rules.validSecretName(bad), bad) }
        XCTAssertFalse(Rules.validSecretName(nil))
    }

    func testOnlyThisDevicesOwnAddressesAreLoopback() {
        for good in ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.255", "::1", "[::1]"] { XCTAssertTrue(Rules.isLoopback(good), good) }
        for bad in ["", "128.0.0.1", "127.0.0.256", "127.0.0", "127.0.0.1.example.org", "localhost.example.org", "192.168.1.1", "::2", "127.0.0.١"] { XCTAssertFalse(Rules.isLoopback(bad), bad) }
        XCTAssertFalse(Rules.isLoopback(nil))
    }

    func testAFingerprintIsWhatOpensslSaysAndIsReadHoweverItIsWritten() throws {
        let empty = "E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55"
        XCTAssertEqual(Rules.fingerprint(of: Data()), empty)
        XCTAssertEqual(Rules.fingerprint(of: Data("abc".utf8)), "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD")
        let bytes = try XCTUnwrap(Rules.parse(empty))
        XCTAssertEqual(bytes.count, 32)
        XCTAssertEqual(Rules.format(bytes), empty)
        for written in [empty.lowercased(), empty.replacingOccurrences(of: ":", with: " "), empty.replacingOccurrences(of: ":", with: ""), "  " + empty + " "] {
            XCTAssertEqual(Rules.parse(written), bytes, written)
        }
        for wrong in ["", "93:B9", String(empty.dropLast(3)), empty + ":00", empty.replacingOccurrences(of: "9", with: "G"), empty.replacingOccurrences(of: ":", with: "-"), "zz", "+" + String(empty.dropFirst())] {
            XCTAssertNil(Rules.parse(wrong), wrong)
        }
        XCTAssertNil(Rules.parse(nil))
        // (the last digit counts)
        XCTAssertNotEqual(Rules.parse(String(empty.dropLast()) + "4"), bytes)
    }

    func testAFailureIsToldInWordsThatAPersonCanActOnAndACertificateOneWithItsCode() {
        // what was trusted for the server is not what it shows: told as that, whatever the system said
        let changed = Rules.describe(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled), mismatch: true)
        XCTAssertEqual(changed.code, Rules.certificateChanged)
        XCTAssertTrue(changed.message.contains("not the one that you trusted"), changed.message)
        // a certificate that the system does not know, in each of the ways that it can say so
        for code in [NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid] {
            let told = Rules.describe(NSError(domain: NSURLErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: "The certificate for this server is invalid.\nAnother line."]))
            XCTAssertEqual(told.code, Rules.certificateUntrusted, "\(code)")
            XCTAssertTrue(told.message.hasPrefix("The server's certificate is not one that this device trusts (The certificate for this server is invalid)"), told.message)
            XCTAssertFalse(told.message.contains("Another line"), told.message)
        }
        // the others have no code
        let unreachable = Rules.describe(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
        XCTAssertNil(unreachable.code)
        XCTAssertTrue(unreachable.message.contains("did not answer"), unreachable.message)
        XCTAssertTrue(Rules.describe(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost)).message.contains("name was not found"))
        XCTAssertTrue(Rules.describe(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)).message.contains("too long"))
        XCTAssertNil(Rules.describe(NSError(domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed)).code)
        XCTAssertEqual(Rules.describe(Refused("No.")), Failure(message: "No.", code: nil))
        XCTAssertFalse(Rules.describe(NSError(domain: "other", code: 1)).message.isEmpty)
    }
}
