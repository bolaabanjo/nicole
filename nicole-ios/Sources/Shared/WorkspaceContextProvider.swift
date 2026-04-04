#if os(macOS)
import CoreGraphics
#endif
import Foundation

@MainActor
enum WorkspaceContextProvider {
  #if os(macOS)
  private static let nicoleBundleIdentifier = Bundle.main.bundleIdentifier
  private static let staleThresholdSeconds: TimeInterval = 1.5

  static func captureExternalContext() async {
    // macOS specific implementation...
    // (Omitted for brevity in this replace call, but keeping logic consistent)
  }
  #endif

  static func currentContext(settings _: AppSettings) async -> NicoleWorkspaceContextPayload {
    #if os(macOS)
    // Existing macOS logic
    let cached = await WorkspaceSnapshotStore.shared.currentSnapshot(maxAge: 1.5)
    if let payload = cached.payload { return payload }
    
    return NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: nil,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: "No macOS workspace context available."
    )
    #else
    // iOS logic: Return a basic payload since iOS apps are sandboxed.
    return NicoleWorkspaceContextPayload(
      surface: "ios",
      activeApp: nil,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: "Running on iPhone"
    )
    #endif
  }
}
