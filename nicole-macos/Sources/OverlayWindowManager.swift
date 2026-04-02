import AppKit
import Foundation

@MainActor
final class OverlayWindowManager: ObservableObject {
  static let shared = OverlayWindowManager()

  private weak var window: NSWindow?
  private var preferredWidth: CGFloat = 440

  private init() {}

  func attach(window: NSWindow, preferredWidth: CGFloat) {
    self.window = window
    self.preferredWidth = preferredWidth

    configure(window: window)
    positionWindow(animated: false)
  }

  func updatePreferredWidth(_ width: CGFloat) {
    preferredWidth = width
    positionWindow(animated: true)
  }

  func togglePanel() {
    guard let window else { return }

    if window.isVisible {
      window.orderOut(nil)
      return
    }

    positionWindow(animated: false)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func showPanel() {
    guard let window else { return }
    positionWindow(animated: false)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  private func configure(window: NSWindow) {
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isOpaque = false
    window.backgroundColor = NSColor.black
    window.hasShadow = true
    window.level = .floating
    window.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
    window.isMovableByWindowBackground = true

    window.standardWindowButton(.closeButton)?.isHidden = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true

    window.styleMask.insert(.fullSizeContentView)
    window.styleMask.insert(.resizable)
    window.styleMask.insert(.titled)
  }

  private func positionWindow(animated: Bool) {
    guard let window else { return }
    guard let screen = window.screen ?? NSScreen.main else { return }

    let visibleFrame = screen.visibleFrame
    let width = max(420, min(preferredWidth, visibleFrame.width - 40))
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
