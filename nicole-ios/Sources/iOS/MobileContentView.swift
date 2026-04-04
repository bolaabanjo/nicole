import SwiftUI
import MarkdownUI

struct MobileContentView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerView
            
            // Chat Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }
                        
                        // Small bottom padding
                        Color.clear.frame(height: 20)
                    }
                    .padding(.top, 16)
                }
                .onChange(of: viewModel.messages.count) { _ in
                    withAnimation {
                        if let lastId = viewModel.messages.last?.id {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                    }
                }
            }
            
            // Bottom Input Area (Docked, not floating)
            inputArea
        }
        .background(Color.windowBackgroundColor.ignoresSafeArea())
    }
    
    private var headerView: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nicole")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                    
                    HStack(spacing: 4) {
                        Circle()
                            .fill(viewModel.connectionState.indicatorColor)
                            .frame(width: 6, height: 6)
                        Text(settings.serverDisplayName)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                }
                Spacer()
                
                // Optional: Sidebar/History toggle could go here in future
                Button(action: { /* Open Sidebar */ }) {
                    Image(systemName: "line.3.horizontal")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.primary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            
            Divider()
                .opacity(0.1)
        }
        .background(.ultraThinMaterial)
    }
    
    private var inputArea: some View {
        VStack(spacing: 0) {
            Divider()
                .opacity(0.1)
            
            HStack(alignment: .bottom, spacing: 12) {
                // Attachment Button
                Button(action: { /* Handle attachments */ }) {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 24))
                        .foregroundColor(.secondary)
                }
                .padding(.bottom, 8)
                
                // Text Input
                ZStack(alignment: .leading) {
                    if viewModel.input.isEmpty {
                        Text("Message Nicole...")
                            .foregroundColor(.secondary.opacity(0.6))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    }
                    
                    TextEditor(text: $viewModel.input)
                        .focused($isInputFocused)
                        .frame(minHeight: 40, maxHeight: 120)
                        .fixedSize(horizontal: false, vertical: true)
                        .transparentScrolling()
                        .background(Color.clear)
                        .font(.system(size: 16))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                }
                .background(Color.secondary.opacity(0.08))
                .cornerRadius(20)
                
                // Send Button
                Button(action: {
                    Task {
                        await viewModel.send(baseURLString: settings.baseURLString, settings: settings)
                    }
                }) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(viewModel.input.isEmpty ? .secondary : .primary)
                }
                .disabled(viewModel.input.isEmpty || viewModel.isSending)
                .padding(.bottom, 4)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24) // Extra padding for safe area/keyboard
        }
        .background(Color.windowBackgroundColor)
    }
}

extension ChatViewModel.ConnectionState {
    var indicatorColor: Color {
        switch self {
        case .connected: return .green
        case .connecting, .syncing: return .orange
        case .failed: return .red
        case .idle: return .secondary
        }
    }
}

#if DEBUG
#Preview {
    MobileContentView(
        settings: AppSettings(),
        viewModel: ChatViewModel()
    )
}
#endif
