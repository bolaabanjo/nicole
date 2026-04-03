import SwiftUI

@main
struct NicoleMacOSApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var settings = AppSettings()
  @StateObject private var viewModel = ChatViewModel()

  var body: some Scene {
    WindowGroup("Nicole") {
      ContentView(settings: settings, viewModel: viewModel)
        .onAppear {
          if settings.windowMode != .expanded {
            settings.windowMode = .expanded
          }
          CompactWindowManager.shared.setup(settings: settings, viewModel: viewModel)
        }
    }
    .defaultSize(width: AppSettings.WindowMode.expanded.idealWidth, height: 760)
    .windowResizability(.contentMinSize)
    .commands {
      CommandMenu("Nicole") {
        Button("Toggle Nicole") {
          appDelegate.toggleNicolePanel()
        }
        .keyboardShortcut("n", modifiers: .control)
      }
    }
  }
}
