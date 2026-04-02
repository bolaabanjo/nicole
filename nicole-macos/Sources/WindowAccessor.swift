import SwiftUI

struct WindowAccessor: NSViewRepresentable {
  let onResolve: @MainActor (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView {
    let view = ResolverView()
    view.onResolve = onResolve
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    guard let resolverView = nsView as? ResolverView else { return }
    resolverView.onResolve = onResolve

    if let window = resolverView.window {
      Task { @MainActor in
        onResolve(window)
      }
    }
  }
}

private final class ResolverView: NSView {
  var onResolve: (@MainActor (NSWindow) -> Void)?

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()

    guard let window, let onResolve else { return }
    Task { @MainActor in
      onResolve(window)
    }
  }
}
