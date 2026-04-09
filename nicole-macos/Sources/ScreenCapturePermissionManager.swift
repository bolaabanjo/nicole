import AppKit
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

enum NicolePermissionState: Equatable {
  case authorized
  case notDetermined
  case denied
  case restricted
  case unavailable(String)
}

@MainActor
enum ScreenCapturePermissionManager {
  private static let requestAttemptKey = "nicole.screenCapturePermissionRequested"

  static func currentState() async -> NicolePermissionState {
    if CGPreflightScreenCaptureAccess() {
      return .authorized
    }

    do {
      _ = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      return .authorized
    } catch let error as NSError {
      if error.domain == SCStreamErrorDomain {
        if hasRequestedPermissionBefore {
          return .denied
        }
        return .notDetermined
      }

      if hasRequestedPermissionBefore {
        return .denied
      }

      return .unavailable(error.localizedDescription)
    } catch {
      if hasRequestedPermissionBefore {
        return .denied
      }

      return .unavailable(error.localizedDescription)
    }
  }

  static func requestAccessIfNeeded() async -> NicolePermissionState {
    let state = await currentState()

    switch state {
    case .authorized, .denied, .restricted:
      return state
    case .unavailable:
      return state
    case .notDetermined:
      UserDefaults.standard.set(true, forKey: requestAttemptKey)
      _ = CGRequestScreenCaptureAccess()
      try? await Task.sleep(nanoseconds: 350_000_000)
      return await currentState()
    }
  }

  static func openSystemSettings() {
    guard
      let url = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      )
    else {
      return
    }

    NSWorkspace.shared.open(url)
  }

  private static var hasRequestedPermissionBefore: Bool {
    UserDefaults.standard.bool(forKey: requestAttemptKey)
  }
}
