import SwiftUI

@main
struct NicoleMacOSApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var settings = AppSettings()
  @StateObject private var viewModel = ChatViewModel()
  @StateObject private var voiceController = NicoleVoiceController()

  var body: some Scene {
    WindowGroup("Nicole") {
      ContentView(
        settings: settings,
        viewModel: viewModel,
        voiceController: voiceController
      )
        .onAppear {
          if settings.windowMode != .expanded {
            settings.windowMode = .expanded
          }
          appDelegate.settings = settings
          viewModel.attachVoiceController(voiceController)
          CompactWindowManager.shared.setup(
            settings: settings,
            viewModel: viewModel,
            voiceController: voiceController
          )
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
