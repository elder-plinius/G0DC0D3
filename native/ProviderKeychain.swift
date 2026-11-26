import Foundation
import Security

// This mode runs before AppKit starts. The record travels only over private pipes.
func providerKeychain(_ arguments: [String]) -> Int32 {
    guard arguments.count == 4,
          arguments[3].range(of: #"^[0-9a-f]{64}\.(venice|openrouter|anthropic|openai|gemini|nous)$"#, options: .regularExpression) != nil
    else { return 2 }
    let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.g0dc0d3.operator.providers",
        kSecAttrAccount as String: arguments[3],
        kSecAttrSynchronizable as String: kCFBooleanFalse!
    ]
    switch arguments[2] {
    case "read":
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecItemNotFound { return 0 }
        guard status == errSecSuccess, let data = found as? Data, data.count <= 16384 else { return 1 }
        FileHandle.standardOutput.write(data)
        return 0
    case "write":
        let data = FileHandle.standardInput.readData(ofLength: 16385)
        guard !data.isEmpty, data.count <= 16384 else { return 2 }
        let value: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrLabel as String: "G0DM0D3 Saved API Keys",
            kSecAttrDescription as String: "Local API key stored on this device by G0DM0D3",
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(item as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item.merging(value) { _, new in new } as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(item as CFDictionary, value as CFDictionary)
            }
        }
        return status == errSecSuccess ? 0 : 1
    case "delete":
        let status = SecItemDelete(item as CFDictionary)
        return (status == errSecSuccess || status == errSecItemNotFound) ? 0 : 1
    default:
        return 2
    }
}
