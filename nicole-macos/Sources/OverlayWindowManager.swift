import AppKit
import Foundation

@MainActor
final class OverlayWindowManager: ObservableObject {
  static let shared = OverlayWindowManager()

  private weak var window: NSWindow?
  private var preferredWidth: CGFloat = 620

  private init() {}

  // MARK: - Setup

  func attach(window: NSWindow, preferredWidth: CGFloat) {
    self.preferredWidth = preferredWidth
    
    // 💡 Avoid re-configuring if it's the same window
    if self.window === window {
        positionWindow(animated: false)
        return
    }

    self.window = window
    configure(window: window)
    positionWindow(animated: false)
  }

  // MARK: - Public Controls

  func updatePreferredWidth(_ width: CGFloat) {
    preferredWidth = width
    positionWindow(animated: true)
  }

  func togglePanel() {
    guard let window else { return }

    if window.isVisible {
      window.orderOut(nil)
    } else {
      showPanel()
    }
  }

  func showPanel() {
    guard let window else { return }

    if window.isMiniaturized {
      window.deminiaturize(nil)
    }

    positionWindow(animated: false)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func minimizePanel() {
    window?.miniaturize(nil)
  }

  func toggleFullScreen() {
    window?.toggleFullScreen(nil)
  }

  // MARK: - Configuration

  private func configure(window: NSWindow) {
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = false
    window.isOpaque = false
    window.backgroundColor = NSColor.black
    window.hasShadow = true

    // ✅ MAIN WINDOW behavior (not overlay)
    window.level = .normal

    // ✅ Proper fullscreen support
    window.collectionBehavior = [.fullScreenPrimary]

    window.isMovableByWindowBackground = true

    // ✅ Required for fullscreen + minimize + resize
    let targetStyleMask: NSWindow.StyleMask = [
      .titled,
      .closable,
      .miniaturizable,
      .resizable,
      .fullSizeContentView
    ]
    
    var newStyleMask = targetStyleMask
    if window.styleMask.contains(.fullScreen) {
      newStyleMask.insert(.fullScreen)
    }
    
    if window.styleMask != newStyleMask {
      window.styleMask = newStyleMask
    }

    window.minSize = NSSize(width: 560, height: 680)
  }

  // MARK: - Layout

  private func positionWindow(animated: Bool) {
    guard let window else { return }

    // 🚫 Never override macOS fullscreen layout
    if window.styleMask.contains(.fullScreen) {
      return
    }

    guard let screen = window.screen ?? NSScreen.main else { return }

    let visibleFrame = screen.visibleFrame

    let width = max(560, min(preferredWidth, visibleFrame.width - 40))
    let height = max(680, visibleFrame.height - 28)

    let x = visibleFrame.maxX - width - 14
    let y = visibleFrame.minY + 14

    let frame = NSRect(x: x, y: y, width: width, height: height)

    if animated {
      window.setFrame(frame, display: true, animate: true)
    } else {
      window.setFrame(frame, display: true)
    }
  }
}