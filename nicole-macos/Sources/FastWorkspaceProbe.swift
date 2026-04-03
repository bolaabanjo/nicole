import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct WorkspaceCaptureTarget: Sendable, Equatable {
  let processID: pid_t
  let bundleIdentifier: String?
  let applicationName: String?
  let windowID: CGWindowID?
  let windowBounds: CGRect?
}

struct FastWorkspaceSnapshot: Sendable {
  let payload: NicoleWorkspaceContextPayload
  let capturedAt: Date
  let target: WorkspaceCaptureTarget
}

@MainActor
enum FastWorkspaceProbe {
  static func captureExternalWorkspace(
    excluding bundleIdentifier: String?
  ) -> FastWorkspaceSnapshot? {
    guard let frontmostApp = NSWorkspace.shared.frontmostApplication else {
      return nil
    }

    if frontmostApp.bundleIdentifier == bundleIdentifier {
      return nil
    }

    let windowInfo = frontmostWindowInfo(for: frontmostApp.processIdentifier)
    let activeApp = frontmostApp.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let selectedText = readSelectedText()
    let currentURL = readCurrentURL(for: activeApp)
    let currentFilePath = readCurrentFilePath(for: activeApp)

    let target = WorkspaceCaptureTarget(
      processID: frontmostApp.processIdentifier,
      bundleIdentifier: frontmostApp.bundleIdentifier,
      applicationName: activeApp,
      windowID: windowInfo?.id,
      windowBounds: windowInfo?.bounds
    )

    let payload = NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: activeApp,
      windowTitle: windowInfo?.title,
      selectedText: selectedText,
      clipboardText: nil,
      currentUrl: currentURL,
      currentFilePath: currentFilePath,
      visibleContent: nil,
      note: nil
    )

    return FastWorkspaceSnapshot(
      payload: payload,
      capturedAt: Date(),
      target: target
    )
  }

  private static func frontmostWindowInfo(
    for processIdentifier: pid_t
  ) -> (id: CGWindowID, title: String?, bounds: CGRect?)? {
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
        layer == 0,
        let windowNumber = window[kCGWindowNumber as String] as? NSNumber
      else {
        continue
      }

      let title = (window[kCGWindowName as String] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let boundsDictionary = (window[kCGWindowBounds as String] as? NSDictionary)
        .map { $0 as CFDictionary }
      var bounds = CGRect.zero
      let hasBounds = boundsDictionary.flatMap { CGRect(dictionaryRepresentation: $0) } != nil
      if let boundsDictionary {
        bounds = CGRect(dictionaryRepresentation: boundsDictionary) ?? .zero
      }

      return (
        id: CGWindowID(windowNumber.uint32Value),
        title: title?.isEmpty == false ? title : nil,
        bounds: hasBounds ? bounds : nil
      )
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
