import AppKit
import Carbon.HIToolbox

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var hotKeyRef: EventHotKeyRef?
  private var hotKeyHandler: EventHandlerRef?
  private static let summonHotKeyID: UInt32 = 1

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    installGlobalHotKey()
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let hotKeyRef {
      UnregisterEventHotKey(hotKeyRef)
    }

    if let hotKeyHandler {
      RemoveEventHandler(hotKeyHandler)
    }
  }

  func toggleNicolePanel() {
    Task { @MainActor in
      let wasHidden = !CompactWindowManager.shared.isPanelVisible
      await WorkspaceContextProvider.captureExternalContext()
      CompactWindowManager.shared.togglePanel()

      if wasHidden {
        ScreenCapturePermissionManager.requestIfNeeded()
      }
    }
  }

  private func installGlobalHotKey() {
    let eventSpec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )

    let selfPointer = Unmanaged.passUnretained(self).toOpaque()

    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, eventRef, userData in
        guard let userData else {
          return noErr
        }

        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
          eventRef,
          EventParamName(kEventParamDirectObject),
          EventParamType(typeEventHotKeyID),
          nil,
          MemoryLayout<EventHotKeyID>.size,
          nil,
          &hotKeyID
        )

        guard status == noErr, hotKeyID.id == AppDelegate.summonHotKeyID else {
          return noErr
        }

        let appDelegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
        appDelegate.toggleNicolePanel()

        return noErr
      },
      1,
      [eventSpec],
      selfPointer,
      &hotKeyHandler
    )

    let hotKeyID = EventHotKeyID(
      signature: OSType(0x4E49434C), // "NICL"
      id: Self.summonHotKeyID
    )

    RegisterEventHotKey(
      UInt32(kVK_ANSI_N),
      UInt32(controlKey),
      hotKeyID,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )
  }
}
