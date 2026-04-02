import AppKit
import Foundation

@MainActor
enum WorkspaceContextProvider {
  static func currentContext(settings: AppSettings) -> NicoleWorkspaceContextPayload {
    NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: NSRunningApplication.current.localizedName,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: settings.includeClipboard ? readClipboardText() : nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: "Sent from the native macOS client."
    )
  }

  private static func readClipboardText() -> String? {
    NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
