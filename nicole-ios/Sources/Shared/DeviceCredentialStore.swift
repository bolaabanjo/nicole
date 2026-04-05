import Foundation
import Security

enum DeviceCredentialStore {
  private static let service = "com.banjo.nicole-mobile"
  private static let account = "trusted-device"

  static func load() -> TrustedDeviceCredentials? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    guard status == errSecSuccess,
          let data = item as? Data,
          let credentials = try? JSONDecoder().decode(TrustedDeviceCredentials.self, from: data)
    else {
      return nil
    }

    return credentials
  }

  static func save(_ credentials: TrustedDeviceCredentials) {
    guard let data = try? JSONEncoder().encode(credentials) else { return }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]

    let attributes: [String: Any] = [
      kSecValueData as String: data,
    ]

    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
      return
    }

    var createQuery = query
    createQuery[kSecValueData as String] = data
    SecItemAdd(createQuery as CFDictionary, nil)
  }

  static func clear() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]

    SecItemDelete(query as CFDictionary)
  }
}
