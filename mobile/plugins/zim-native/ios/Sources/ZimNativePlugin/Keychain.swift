// A place for the token: the keychain, which keeps what is put in it out of the app's own files and out of a backup that goes to another device (`...ThisDeviceOnly`), and gives it only
// while the device is unlocked. What the page keeps there is a name and a text (web/src/account/native.ts is the page's side).
import Foundation
import Security

struct Keychain {
    let service: String

    private func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    /// The secret under a name, or nil. A secret that can't be opened for a reason that will not pass (the item is damaged, the data is not text) is forgotten, as on Android: the person signs in
    /// again. One that can't be opened because the device is locked is left alone.
    func get(_ name: String) -> String? {
        var search = query(name)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        switch status {
        case errSecSuccess:
            if let data = found as? Data, let text = String(data: data, encoding: .utf8) { return text }
            SecItemDelete(query(name) as CFDictionary)
            return nil
        case errSecItemNotFound, errSecInteractionNotAllowed:
            return nil
        default:
            return nil
        }
    }

    /// Keep a secret under a name (an old one is replaced). What the keychain said: `errSecSuccess`, or why it would not.
    func set(_ name: String, _ value: String) -> OSStatus {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status != errSecItemNotFound { return status }
        var add = query(name)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil)
    }

    func remove(_ name: String) {
        SecItemDelete(query(name) as CFDictionary)
    }
}
