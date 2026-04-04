import CoreGraphics
import Foundation

@MainActor
enum ScreenCapturePermissionManager {
  static var hasPermission: Bool {
    CGPreflightScreenCaptureAccess()
  }

  /// Request screen capture permission on launch.
  /// With stable code signing, macOS remembers the grant —
  /// this only shows a dialog if permission hasn't been granted yet.
  static func requestOnLaunch() {
    if !CGPreflightScreenCaptureAccess() {
      Task.detached(priority: .userInitiated) {
        _ = CGRequestScreenCaptureAccess()
      }
    }
  }
}
