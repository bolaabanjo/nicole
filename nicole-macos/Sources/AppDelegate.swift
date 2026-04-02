import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var globalHotkeyMonitor: Any?
  private var localHotkeyMonitor: Any?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    installHotkeyMonitors()
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let globalHotkeyMonitor {
      NSEvent.removeMonitor(globalHotkeyMonitor)
    }
    if let localHotkeyMonitor {
      NSEvent.removeMonitor(localHotkeyMonitor)
    }
  }

  @MainActor
  func toggleNicolePanel() {
    OverlayWindowManager.shared.togglePanel()
  }

  private func installHotkeyMonitors() {
    localHotkeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      if Self.isToggleEvent(event) {
        Task { @MainActor in
          OverlayWindowManager.shared.togglePanel()
        }
        return nil
      }

      return event
    }

    globalHotkeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
      if Self.isToggleEvent(event) {
        Task { @MainActor in
          OverlayWindowManager.shared.togglePanel()
        }
      }
    }
  }

  private static func isToggleEvent(_ event: NSEvent) -> Bool {
    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard modifiers.contains(.command), modifiers.contains(.shift) else {
      return false
    }

    return event.charactersIgnoringModifiers?.lowercased() == "n"
  }
}
