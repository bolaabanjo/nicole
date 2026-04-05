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
        return 620
      case .expanded:
        return 1180
      }
    }

    var minimumWidth: Double {
      switch self {
      case .compact:
        return 560
      case .expanded:
        return 980
      }
    }

    var minimumHeight: Double {
      switch self {
      case .compact:
        return 680
      case .expanded:
        return 760
      }
    }

    var chatCanvasWidth: Double {
      switch self {
      case .compact:
        return 760
      case .expanded:
        return 860
      }

    }

    var usesSidebar: Bool {
      switch self {
      case .compact:
        return false
      case .expanded:
        return true
      }
    }
  }

  private enum Keys {
    static let serverName = "nicole.macos.server-name"
    static let baseURL = "nicole.macos.base-url"
    static let windowMode = "nicole.macos.window-mode"
    static let includeClipboard = "nicole.macos.include-clipboard"
    static let voiceRepliesEnabled = "nicole.macos.voice-replies-enabled"
    static let alwaysOnVoiceEnabled = "nicole.macos.always-on-voice-enabled"
    static let voiceModeActive = "nicole.macos.voice-mode-active"
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

  @Published var voiceRepliesEnabled: Bool {
    didSet {
      UserDefaults.standard.set(voiceRepliesEnabled, forKey: Keys.voiceRepliesEnabled)
    }
  }

  @Published var alwaysOnVoiceEnabled: Bool {
    didSet {
      UserDefaults.standard.set(alwaysOnVoiceEnabled, forKey: Keys.alwaysOnVoiceEnabled)
    }
  }

  @Published var voiceModeActive: Bool {
    didSet {
      UserDefaults.standard.set(voiceModeActive, forKey: Keys.voiceModeActive)
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
    let storedServerName = UserDefaults.standard.string(forKey: Keys.serverName) ?? ""
    self.serverName = storedServerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "Banjo"
      : storedServerName
    self.baseURLString =
      UserDefaults.standard.string(forKey: Keys.baseURL) ?? ""
    self.windowMode =
      WindowMode(rawValue: UserDefaults.standard.string(forKey: Keys.windowMode) ?? "")
      ?? .expanded
    self.includeClipboard =
      UserDefaults.standard.object(forKey: Keys.includeClipboard) as? Bool ?? true
    self.voiceRepliesEnabled =
      UserDefaults.standard.object(forKey: Keys.voiceRepliesEnabled) as? Bool ?? false
    self.alwaysOnVoiceEnabled =
      UserDefaults.standard.object(forKey: Keys.alwaysOnVoiceEnabled) as? Bool ?? false
    self.voiceModeActive =
      UserDefaults.standard.object(forKey: Keys.voiceModeActive) as? Bool ?? false
  }
}
