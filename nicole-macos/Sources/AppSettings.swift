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
    static let baseURL = "nicole.macos.base-url"
    static let windowMode = "nicole.macos.window-mode"
    static let includeClipboard = "nicole.macos.include-clipboard"
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

  init() {
    self.baseURLString =
      UserDefaults.standard.string(forKey: Keys.baseURL) ?? "http://127.0.0.1:3000"
    self.windowMode =
      WindowMode(rawValue: UserDefaults.standard.string(forKey: Keys.windowMode) ?? "")
      ?? .compact
    self.includeClipboard =
      UserDefaults.standard.object(forKey: Keys.includeClipboard) as? Bool ?? true
  }
}
