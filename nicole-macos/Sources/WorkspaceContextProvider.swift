import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

@MainActor
enum WorkspaceContextProvider {
  private static var lastExternalContext: NicoleWorkspaceContextPayload?
  private static let nicoleBundleIdentifier = Bundle.main.bundleIdentifier

  static func captureExternalContext() {
    guard let snapshot = captureCurrentExternalContext(includeClipboard: false) else {
      return
    }

    lastExternalContext = snapshot
  }

  static func currentContext(settings: AppSettings) -> NicoleWorkspaceContextPayload {
    if let snapshot = captureCurrentExternalContext(includeClipboard: settings.includeClipboard) {
      lastExternalContext = snapshot
      return snapshot
    }

    let fallback = lastExternalContext ?? NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: nil,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: nil
    )

    return NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: fallback.activeApp,
      windowTitle: fallback.windowTitle,
      selectedText: fallback.selectedText,
      clipboardText: settings.includeClipboard ? readClipboardText() : nil,
      currentUrl: fallback.currentUrl,
      currentFilePath: fallback.currentFilePath,
      visibleContent: fallback.visibleContent,
      note: "Captured from your Mac workspace before Nicole came to the front."
    )
  }

  static func previewContext(settings: AppSettings) -> NicoleWorkspaceContextPayload? {
    let context = currentContext(settings: settings)
    return context.hasMeaningfulWorkspaceContext ? context : nil
  }

  private static func captureCurrentExternalContext(
    includeClipboard: Bool
  ) -> NicoleWorkspaceContextPayload? {
    guard let frontmostApp = NSWorkspace.shared.frontmostApplication else {
      return nil
    }

    if frontmostApp.bundleIdentifier == nicoleBundleIdentifier {
      return nil
    }

    let activeApp = frontmostApp.localizedName
    let windowTitle = readFrontmostWindowTitle(for: frontmostApp.processIdentifier)
    let selectedText = readSelectedText()
    let currentUrl = readCurrentURL(for: activeApp)
    let currentFilePath = readCurrentFilePath(for: activeApp)

    return NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: activeApp,
      windowTitle: windowTitle,
      selectedText: selectedText,
      clipboardText: includeClipboard ? readClipboardText() : nil,
      currentUrl: currentUrl,
      currentFilePath: currentFilePath,
      visibleContent: nil,
      note: "Sent from the native macOS client."
    )
  }

  private static func readClipboardText() -> String? {
    NSPasteboard.general.string(forType: .string)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func readFrontmostWindowTitle(for processIdentifier: pid_t) -> String? {
    guard
      let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
      ) as? [[String: Any]]
    else {
      return nil
    }

    for window in windowList {
      guard
        let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t,
        ownerPID == processIdentifier,
        let layer = window[kCGWindowLayer as String] as? Int,
        layer == 0
      else {
        continue
      }

      if
        let title = (window[kCGWindowName as String] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines),
        !title.isEmpty
      {
        return title
      }
    }

    return nil
  }

  private static func readSelectedText() -> String? {
    guard AXIsProcessTrusted() else {
      return nil
    }

    let systemWide = AXUIElementCreateSystemWide()
    var focusedElementRef: CFTypeRef?

    let focusedResult = AXUIElementCopyAttributeValue(
      systemWide,
      kAXFocusedUIElementAttribute as CFString,
      &focusedElementRef
    )

    guard focusedResult == .success, let focusedElementRef else {
      return nil
    }

    let focusedElement = focusedElementRef as! AXUIElement
    var selectedTextRef: CFTypeRef?

    let selectedTextResult = AXUIElementCopyAttributeValue(
      focusedElement,
      kAXSelectedTextAttribute as CFString,
      &selectedTextRef
    )

    guard
      selectedTextResult == .success,
      let selectedText = selectedTextRef as? String
    else {
      return nil
    }

    let trimmed = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func readCurrentURL(for appName: String?) -> String? {
    guard let appName else { return nil }

    let scriptSource: String?

    switch appName {
    case "Safari":
      scriptSource = #"tell application "Safari" to if exists front window then return URL of current tab of front window"#
    case "Google Chrome":
      scriptSource = #"tell application "Google Chrome" to if exists front window then return URL of active tab of front window"#
    case "Arc":
      scriptSource = #"tell application "Arc" to if exists front window then return URL of active tab of front window"#
    case "Brave Browser":
      scriptSource = #"tell application "Brave Browser" to if exists front window then return URL of active tab of front window"#
    case "Microsoft Edge":
      scriptSource = #"tell application "Microsoft Edge" to if exists front window then return URL of active tab of front window"#
    default:
      scriptSource = nil
    }

    guard let scriptSource else { return nil }
    return runAppleScript(scriptSource)
  }

  private static func readCurrentFilePath(for appName: String?) -> String? {
    guard let appName else { return nil }

    switch appName {
    case "Finder":
      return runAppleScript(
        """
        tell application "Finder"
          if (count of selection) > 0 then
            return POSIX path of ((item 1 of selection) as alias)
          else if exists front window then
            return POSIX path of (target of front window as alias)
          end if
        end tell
        """
      )
    default:
      return nil
    }
  }

  private static func runAppleScript(_ source: String) -> String? {
    guard let script = NSAppleScript(source: source) else {
      return nil
    }

    var errorInfo: NSDictionary?
    let result = script.executeAndReturnError(&errorInfo)

    guard errorInfo == nil else {
      return nil
    }

    let value = result.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
  }
}
