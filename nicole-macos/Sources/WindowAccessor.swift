import SwiftUI

struct WindowAccessor: NSViewRepresentable {
  let onResolve: @MainActor (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView {
    let view = NSView()

    DispatchQueue.main.async {
      if let window = view.window {
        Task { @MainActor in
          onResolve(window)
        }
      }
    }

    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async {
      if let window = nsView.window {
        Task { @MainActor in
          onResolve(window)
        }
      }
    }
  }
}
