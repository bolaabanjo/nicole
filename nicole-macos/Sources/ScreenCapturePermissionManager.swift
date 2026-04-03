import CoreGraphics
import Foundation

@MainActor
enum ScreenCapturePermissionManager {
  private static var requestedThisLaunch = false

  static func requestIfNeeded() {
    guard !CGPreflightScreenCaptureAccess() else { return }
    guard !requestedThisLaunch else { return }

    requestedThisLaunch = true

    Task.detached(priority: .userInitiated) {
      _ = CGRequestScreenCaptureAccess()
    }
  }
}
