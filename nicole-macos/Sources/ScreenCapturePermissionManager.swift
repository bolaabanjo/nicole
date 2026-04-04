import Foundation
@preconcurrency import ScreenCaptureKit

@MainActor
enum ScreenCapturePermissionManager {
  /// Check if screen capture actually works by trying to get shareable content.
  /// This is more reliable than CGPreflightScreenCaptureAccess() for self-signed apps.
  static func checkPermission() async -> Bool {
    do {
      _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      return true
    } catch {
      return false
    }
  }

  /// Request screen capture permission on launch if not already granted.
  static func requestOnLaunch() {
    Task.detached(priority: .userInitiated) {
      let hasAccess = await checkPermission()
      if !hasAccess {
        _ = CGRequestScreenCaptureAccess()
      }
    }
  }
}
