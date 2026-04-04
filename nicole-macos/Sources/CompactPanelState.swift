import Foundation

@MainActor
final class CompactPanelState: ObservableObject {
  static let collapsedHeight: CGFloat = 76
  static let maxExpandedHeight: CGFloat = 840

  @Published var isVisible = false
  @Published var focusRequestID = UUID()
  @Published var currentHeight: CGFloat = collapsedHeight

  struct Exchange: Identifiable, Equatable {
    var id: String { assistantMessageID }
    let userText: String
    let assistantMessageID: String
  }

  @Published var exchanges: [Exchange] = []
  @Published var contextLabel: String?
  @Published var hasScreenCapture = false

  var isExpanded: Bool {
    currentHeight > Self.collapsedHeight + 12
  }

  func requestFocus() {
    focusRequestID = UUID()
  }

  func markShown() {
    isVisible = true
    requestFocus()
    refreshContextLabel()
  }

  func refreshContextLabel() {
    Task {
      let read = await WorkspaceSnapshotStore.shared.currentSnapshot(maxAge: 5)
      guard let payload = read.payload else {
        contextLabel = nil
        hasScreenCapture = false
        return
      }

      let app = payload.activeApp ?? "Unknown"
      if let visible = payload.visibleContent, !visible.isEmpty {
        contextLabel = "Seeing: \(app)"
        hasScreenCapture = true
      } else {
        contextLabel = "Metadata: \(app)"
        hasScreenCapture = false
      }
    }
  }

  func markHidden() {
    isVisible = false
    clearExchanges()
  }

  func beginExchange(userText: String, assistantMessageID: String) {
    exchanges.append(Exchange(userText: userText, assistantMessageID: assistantMessageID))
  }

  func clearExchanges() {
    exchanges.removeAll()
  }

  func resetHeight() {
    currentHeight = Self.collapsedHeight
  }

  func updateMeasuredHeight(_ height: CGFloat) {
    let clamped = max(Self.collapsedHeight, min(height, Self.maxExpandedHeight))
    guard abs(clamped - currentHeight) > 0.5 else { return }
    currentHeight = clamped
  }
}

