import AppKit
import Foundation
import SwiftUI

@MainActor
final class CompactWindowManager: ObservableObject {
  static let shared = CompactWindowManager()

  private var panel: KeyableCompactPanel?
  private(set) var panelState = CompactPanelState()
  private var panelWidth: CGFloat = 520
  private var anchorTopY: CGFloat?
  private weak var currentScreen: NSScreen?
  private weak var voiceController: NicoleVoiceController?

  private init() {}

  var isPanelVisible: Bool {
    panel?.isVisible ?? false
  }

  func setup(
    settings: AppSettings,
    viewModel: ChatViewModel,
    voiceController: NicoleVoiceController
  ) {
    self.voiceController = voiceController

    if panel == nil {
      let newPanel = KeyableCompactPanel(
        contentRect: NSRect(
          x: 0,
          y: 0,
          width: panelWidth,
          height: CompactPanelState.collapsedHeight
        ),
        styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
        backing: .buffered,
        defer: false
      )

      newPanel.identifier = NSUserInterfaceItemIdentifier("CompactPanel")
      newPanel.titleVisibility = .hidden
      newPanel.titlebarAppearsTransparent = true
      newPanel.isOpaque = false
      newPanel.backgroundColor = .clear
      newPanel.hasShadow = true

      // Window level high enough to float over full-screen apps
      newPanel.level = NSWindow.Level(Int(CGShieldingWindowLevel()))

      // canJoinAllSpaces: appear on every desktop/space
      // fullScreenAuxiliary: appear over full-screen apps
      // stationary: don't get dragged when switching spaces
      newPanel.collectionBehavior = [
        .canJoinAllSpaces,
        .fullScreenAuxiliary,
        .stationary,
      ]

      newPanel.isMovableByWindowBackground = true
      newPanel.hidesOnDeactivate = false
      newPanel.animationBehavior = .utilityWindow
      newPanel.worksWhenModal = true
      newPanel.isFloatingPanel = true

      let rootView = CompactView(
        settings: settings,
        viewModel: viewModel,
        panelState: panelState,
        voiceController: voiceController
      )
      let hostingView = NSHostingView(rootView: rootView)
      hostingView.sizingOptions = [.intrinsicContentSize]
      newPanel.contentView = hostingView

      panel = newPanel
    }
  }

  func togglePanel() {
    guard let panel else { return }

    if panel.isVisible {
      hidePanel()
    } else {
      showPanel()
    }
  }

  func showPanel() {
    guard let panel else { return }

    let targetScreen = screenForSummon()
    currentScreen = targetScreen
    configureAnchorIfNeeded(for: targetScreen)
    panelState.markShown()
    updatePanelHeight(panelState.currentHeight, animated: false)

    panel.orderFrontRegardless()
    panel.makeKeyAndOrderFront(nil)
  }

  func hidePanel() {
    guard let panel else { return }

    voiceController?.stopListeningIfActive(on: .compact)
    panel.orderOut(nil)
    panelState.markHidden()
  }

  func updatePanelHeight(_ height: CGFloat, animated: Bool) {
    guard let panel else { return }

    let clampedHeight = max(
      CompactPanelState.collapsedHeight,
      min(height, CompactPanelState.maxExpandedHeight)
    )
    panelState.updateMeasuredHeight(clampedHeight)

    let screen = currentScreen ?? screenForSummon()
    currentScreen = screen
    configureAnchorIfNeeded(for: screen)

    // Use full frame (not visibleFrame) so it works in full-screen apps too
    let frame = screen.frame
    let x = frame.midX - (panelWidth / 2)
    let topEdge = anchorTopY ?? (frame.midY + 90)
    let y = topEdge - clampedHeight

    let newFrame = NSRect(x: x, y: y, width: panelWidth, height: clampedHeight)

    if animated {
      panel.setFrame(newFrame, display: true, animate: true)
    } else {
      panel.setFrame(newFrame, display: true)
    }
  }

  private func configureAnchorIfNeeded(for screen: NSScreen) {
    if currentScreen !== screen || anchorTopY == nil {
      let frame = screen.frame
      anchorTopY = frame.midY + 90
    }
  }

  private func screenForSummon() -> NSScreen {
    let mouseLocation = NSEvent.mouseLocation
    if let mouseScreen = NSScreen.screens.first(where: { NSMouseInRect(mouseLocation, $0.frame, false) }) {
      return mouseScreen
    }

    if let mainScreen = NSScreen.main {
      return mainScreen
    }

    if let firstScreen = NSScreen.screens.first {
      return firstScreen
    }

    fatalError("NicoleMacOS requires an available screen to present the compact panel.")
  }
}

private final class KeyableCompactPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}
