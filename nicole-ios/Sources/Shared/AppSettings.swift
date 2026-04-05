import Foundation

#if os(iOS)
import UIKit
#endif

@MainActor
final class AppSettings: ObservableObject {
  private enum Keys {
    static let serverName = "nicole.mobile.server-name"
    static let baseURL = "nicole.mobile.base-url"
    static let deviceName = "nicole.mobile.device-name"
    static let pairingCode = "nicole.mobile.pairing-code"
  }

  @Published var serverName: String {
    didSet {
      UserDefaults.standard.set(serverName, forKey: Keys.serverName)
    }
  }

  @Published var baseURLString: String {
    didSet {
      UserDefaults.standard.set(baseURLString, forKey: Keys.baseURL)
    }
  }

  @Published var deviceName: String {
    didSet {
      UserDefaults.standard.set(deviceName, forKey: Keys.deviceName)
    }
  }

  @Published var pairingCode: String {
    didSet {
      UserDefaults.standard.set(pairingCode, forKey: Keys.pairingCode)
    }
  }

  var trimmedServerName: String? {
    let trimmed = serverName.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  var normalizedBaseURLString: String? {
    let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  var normalizedDeviceName: String {
    let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? defaultDeviceName : trimmed
  }

  var normalizedPairingCode: String? {
    let trimmed = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  var derivedHostLabel: String? {
    guard
      let rawValue = normalizedBaseURLString,
      let components = URLComponents(string: rawValue),
      let host = components.host,
      !host.isEmpty
    else {
      return nil
    }

    if let port = components.port {
      return "\(host):\(port)"
    }

    return host
  }

  var serverDisplayName: String {
    trimmedServerName ?? derivedHostLabel ?? "Banjo"
  }

  init() {
    let defaults = UserDefaults.standard
    let storedServerName = defaults.string(forKey: Keys.serverName) ?? ""
    serverName =
      storedServerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "Banjo"
      : storedServerName
    baseURLString = defaults.string(forKey: Keys.baseURL) ?? ""

    let storedDeviceName = defaults.string(forKey: Keys.deviceName) ?? ""
    deviceName =
      storedDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? defaultDeviceName
      : storedDeviceName

    pairingCode = defaults.string(forKey: Keys.pairingCode) ?? ""
  }
}

private let defaultDeviceName: String = {
  #if os(iOS)
  UIDevice.current.name
  #else
  Host.current().localizedName ?? "Nicole Phone"
  #endif
}()
