import SwiftUI

struct MessageBubbleView: View {
    let message: NicoleMessage
    
    var body: some View {
        HStack {
            if message.role == .user {
                Spacer()
            }
            
            VStack(alignment: .leading, spacing: 8) {
                if message.role == .user {
                    // User message - white background, black text
                    Text(message.content.isEmpty && message.isStreaming ? "Thinking..." : message.content)
                        .textSelection(.enabled)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    // Assistant message - transparent background, white text
                    Text(message.content.isEmpty && message.isStreaming ? "Nicole is thinking..." : message.content)
                        .textSelection(.enabled)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundColor(.white.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                
                // Streaming indicator for assistant
                if message.isStreaming && message.role == .assistant {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: 4, height: 4)
                        Circle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: 4, height: 4)
                            .padding(.leading, 2)
                        Circle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: 4, height: 4)
                            .padding(.leading, 2)
                    }
                }
                
                // Message actions for assistant messages
                if message.role == .assistant && !message.isStreaming && !message.content.isEmpty {
                    HStack(spacing: 6) {
                        Button(action: { /* Handle like */ }) {
                            Image(systemName: "hand.thumbsup")
                                .font(.system(size: 12))
                                .foregroundColor(.white.opacity(0.5))
                        }
                        Button(action: { /* Handle dislike */ }) {
                            Image(systemName: "hand.thumbsdown")
                                .font(.system(size: 12))
                                .foregroundColor(.white.opacity(0.5))
                        }
                        Button(action: { /* Handle copy */ }) {
                            Image(systemName: "doc.on.doc")
                                .font(.system(size: 12))
                                .foregroundColor(.white.opacity(0.5))
                        }
                        Button(action: { /* Handle regenerate */ }) {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 12))
                                .foregroundColor(.white.opacity(0.5))
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: 560, alignment: .leading)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: message.role == .user ? 22 : 99, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: message.role == .user ? 22 : 99, style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            )
            
            if message.role != .user {
                Spacer()
            }
        }
        .padding(.horizontal, message.role == .user ? 60 : 20)
        .padding(.vertical, 8)
    }
    
    private var bubbleBackground: some ShapeStyle {
        switch message.role {
        case .user:
            return Color.white
        case .assistant:
            return Color.clear // Transparent for assistant
        case .system:
            return Color.clear
        }
    }
    
    private var borderColor: Color {
        switch message.role {
        case .user:
            return Color.clear // No border for user messages
        case .assistant:
            return Color.white.opacity(0.08) // 8% white border for assistant
        case .system:
            return Color.clear
        }
    }
}
