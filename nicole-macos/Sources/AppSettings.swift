import Foundation

@MainActor
final class AppSettings: ObservableObject {
  enum WindowMode: String, CaseIterable, Identifiable {
    case compact
    case expanded

    var id: String { rawValue }

    var title: String {
      switch self {
      case .compact:
        return "Compact"
      case .expanded:
        return "Expanded"
      }
    }

    var idealWidth: Double {
      switch self {
      case .compact:
        return 440
      case .expanded:
        return 760
      }
    }
  }

  private enum Keys {
    static let serverName = "nicole.macos.server-name"
    static let baseURL = "nicole.macos.base-url"
    static let windowMode = "nicole.macos.window-mode"
    static let includeClipboard = "nicole.macos.include-clipboard"
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

  @Published var windowMode: WindowMode {
    didSet {
      UserDefaults.standard.set(windowMode.rawValue, forKey: Keys.windowMode)
    }
  }

  @Published var includeClipboard: Bool {
    didSet {
      UserDefaults.standard.set(includeClipboard, forKey: Keys.includeClipboard)
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
    trimmedServerName ?? derivedHostLabel ?? "Nicole server"
  }

  init() {
    self.serverName =
      UserDefaults.standard.string(forKey: Keys.serverName) ?? ""
    self.baseURLString =
      UserDefaults.standard.string(forKey: Keys.baseURL) ?? ""
    self.windowMode =
      WindowMode(rawValue: UserDefaults.standard.string(forKey: Keys.windowMode) ?? "")
      ?? .compact
    self.includeClipboard =
      UserDefaults.standard.object(forKey: Keys.includeClipboard) as? Bool ?? true
  }
}
