// What the iPhone app does for an account that a WebView does not: the requests to the account server (the page's content policy lets it ask nowhere but its own address, and a shell's address is
// not the server's), a place for the token (the keychain), trusting a certificate that the system does not know by its fingerprint, and the person's browser. It is the other half of Android's
// ZimNativePlugin (mobile/android/.../ZimNativePlugin.java), with the same methods, the same rules (ZimNativeRules) and the same words; `web/src/account/native.ts` is the page's side, and
// `mobile/shell/shell.ts` sets the hooks over these methods.
import Capacitor
import Foundation
import Security
import UIKit
import ZimNativeRules

@objc(ZimNativePlugin)
public class ZimNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ZimNativePlugin"
    public let jsName = "ZimNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openBrowser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trustInspect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trustPin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trustPinned", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trustUnpin", returnType: CAPPluginReturnPromise)
    ]

    private let sessions = Sessions()
    private let pins = Pins()
    private let secrets = Keychain(service: "org.zimnotebook.app.secrets")

    private func reject(_ call: CAPPluginCall, _ failure: Failure) {
        call.reject(failure.message, failure.code)
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        reject(call, Rules.describe(error))
    }

    // MARK: - the requests

    /// A request to the account server: `{ url, method, headers, body }` in; `{ status, headers, body }` out (the body as text). A failure is words for a person, and, when it is about the server's
    /// certificate, a `code` too: the system does not know it and nothing was trusted for this server (`certificate-untrusted`), or something was and the server shows another (`certificate-changed`).
    @objc func request(_ call: CAPPluginCall) {
        let url: URL
        do {
            url = try Rules.checkUrl(call.getString("url"))
        } catch {
            return reject(call, error)
        }
        let method = (call.getString("method") ?? "GET").uppercased()
        guard Rules.methods.contains(method) else { return call.reject("That is not a request that this app makes.") }
        let text = call.getString("body")
        let body = text.map { Data($0.utf8) }
        if let body = body, body.count > Rules.maxBody { return call.reject("That request is too big.") }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 120)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("ZimNotebook-iOS", forHTTPHeaderField: "User-Agent")
        var contentType = "application/json"
        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                guard Rules.forwards(name), let text = value as? String else { continue }
                if name.lowercased() == "content-type" { contentType = text }
                request.setValue(text, forHTTPHeaderField: name)
            }
        }
        if method == "POST" || method == "PUT" || method == "PATCH" {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body ?? Data()
        }
        // (the certificate trusted for this server, if there is one: its session takes that one and nothing else)
        let wanted = url.scheme?.lowercased() == "https" ? Rules.originKey(of: url).flatMap { pins.wanted($0) } : nil
        sessions.session(taking: wanted).send(request) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let answer):
                call.resolve(["status": answer.status, "headers": answer.headers, "body": answer.body])
            case .failure(let failure):
                self.reject(call, failure)
            }
        }
    }

    // MARK: - a server whose certificate the system does not know

    private func origin(_ call: CAPPluginCall) throws -> (key: String, host: String, port: Int) {
        let read = try Rules.checkOrigin(call.getString("origin"))
        let port = read.port ?? 443
        return (Rules.originKey(of: read), Rules.bareHost(read.host ?? ""), port)
    }

    /// What the server at this origin shows as its certificate, found out by a handshake and nothing else: no request is made, so nothing is sent to a server that was not trusted yet.
    @objc func trustInspect(_ call: CAPPluginCall) {
        let found: (key: String, host: String, port: Int)
        do {
            found = try origin(call)
        } catch {
            return reject(call, error)
        }
        Look.at(host: found.host, port: found.port) { [weak self] result in
            switch result {
            case .success(let der):
                call.resolve(["fingerprint": Rules.fingerprint(of: der)])
            case .failure(let failure):
                self?.reject(call, failure)
            }
        }
    }

    /// Trust the certificate with this fingerprint for this origin, if the server shows it now (it is looked at again: what the person was shown is not taken for what the server shows).
    @objc func trustPin(_ call: CAPPluginCall) {
        let found: (key: String, host: String, port: Int)
        do {
            found = try origin(call)
        } catch {
            return reject(call, error)
        }
        guard let wanted = Rules.parse(call.getString("fingerprint")) else { return call.reject("That is not a fingerprint.") }
        Look.at(host: found.host, port: found.port) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let der):
                if Rules.sha256(der) != wanted {
                    call.reject("The server shows another certificate now, so nothing was trusted.", Rules.certificateChanged)
                } else {
                    self.pins.set(found.key, wanted)
                    call.resolve()
                }
            case .failure(let failure):
                self.reject(call, failure)
            }
        }
    }

    /// The fingerprint that was trusted for this origin, or null.
    @objc func trustPinned(_ call: CAPPluginCall) {
        do {
            let found = try origin(call)
            if let kept = pins.text(found.key) {
                call.resolve(["fingerprint": kept])
            } else {
                call.resolve(["fingerprint": NSNull()])
            }
        } catch {
            reject(call, error)
        }
    }

    /// Stop trusting what was trusted for this origin (that nothing was is not a failure).
    @objc func trustUnpin(_ call: CAPPluginCall) {
        do {
            pins.remove(try origin(call).key)
            call.resolve()
        } catch {
            reject(call, error)
        }
    }

    // MARK: - the browser

    /// Open the person's browser at an address (https, or this device's own): where they sign in and allow the app. The browser sends them back to the app's own address (`org.zimnotebook.app.ios:/callback`,
    /// which the system hands to this app: the shell hears it as `appUrlOpen`).
    @objc func openBrowser(_ call: CAPPluginCall) {
        let url: URL
        do {
            url = try Rules.checkBrowserUrl(call.getString("url"))
        } catch {
            return reject(call, error)
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("No browser was found on this device.")
                }
            }
        }
    }

    // MARK: - the token

    /// The secret under a name, or null.
    @objc func secretGet(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Rules.validSecretName(name) else { return call.reject("That is not a name that a secret can have.") }
        if let value = secrets.get(name) {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    /// Keep a secret under a name: in the keychain, for this device only.
    @objc func secretSet(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Rules.validSecretName(name), let value = call.getString("value") else { return call.reject("That is not a secret that can be kept.") }
        let status = secrets.set(name, value)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("The device's keychain would not keep it (error \(status)).")
        }
    }

    /// Forget a secret.
    @objc func secretRemove(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), Rules.validSecretName(name) else { return call.reject("That is not a name that a secret can have.") }
        secrets.remove(name)
        call.resolve()
    }
}
