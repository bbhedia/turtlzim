// What the person trusted for servers that the system does not know: a fingerprint for each (`https://host:port`), kept in the app's own preferences (it is not a secret: it is what the server
// shows to anyone who asks). The rules are in ZimNativeRules; this keeps them.
import Foundation
import ZimNativeRules

struct Pins {
    private let defaults = UserDefaults.standard
    private func key(_ origin: String) -> String { "zim-pin:\(origin)" }

    /// The 32 bytes trusted for this origin, or nil (a value that is not a fingerprint is no trust).
    func wanted(_ origin: String) -> Data? {
        Rules.parse(defaults.string(forKey: key(origin)))
    }

    /// The fingerprint as it is kept (capitals and colons), or nil.
    func text(_ origin: String) -> String? {
        guard let bytes = wanted(origin) else { return nil }
        return Rules.format(bytes)
    }

    func set(_ origin: String, _ digest: Data) {
        defaults.set(Rules.format(digest), forKey: key(origin))
        defaults.synchronize()
    }

    func remove(_ origin: String) {
        defaults.removeObject(forKey: key(origin))
        defaults.synchronize()
    }
}
