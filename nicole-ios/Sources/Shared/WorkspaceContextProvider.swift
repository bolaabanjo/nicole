import Foundation

@MainActor
enum WorkspaceContextProvider {
  static func currentContext(settings _: AppSettings) async -> NicoleWorkspaceContextPayload {
    NicoleWorkspaceContextPayload(
      surface: "ios",
      activeApp: nil,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: "Running on iPhone. No desktop workspace context is attached."
    )
  }
}
