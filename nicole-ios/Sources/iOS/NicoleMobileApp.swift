import SwiftUI

@main
struct NicoleMobileApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var viewModel = ChatViewModel()
    
    var body: some Scene {
        WindowGroup {
            MobileContentView(settings: settings, viewModel: viewModel)
        }
    }
}
