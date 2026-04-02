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
          Text(message.content)
            .textSelection(.enabled)
            .font(.system(size: 15, weight: .medium))
            .foregroundColor(.black)
        } else {
          // Assistant message - dark background, white text
          Text(message.content.isEmpty && message.isStreaming ? "Nicole is thinking..." : message.content)
            .textSelection(.enabled)
            .font(.system(size: 15, weight: .regular))
            .foregroundColor(.white.opacity(0.92))
        }

        // Streaming indicator for assistant
        if message.isStreaming && message.role == .assistant && !message.content.isEmpty {
          HStack(spacing: 4) {
            Circle()
              .fill(Color.white.opacity(0.3))
              .frame(width: 4, height: 4)
            Circle()
              .fill(Color.white.opacity(0.3))
              .frame(width: 4, height: 4)
            Circle()
              .fill(Color.white.opacity(0.3))
              .frame(width: 4, height: 4)
          }
          .padding(.top, 4)
        }

        // Message actions for assistant messages
        if message.role == .assistant && !message.isStreaming && !message.content.isEmpty {
          HStack(spacing: 12) {
            Button(action: { /* Handle like */ }) {
              Image(systemName: "hand.thumbsup")
            }
            Button(action: { /* Handle dislike */ }) {
              Image(systemName: "hand.thumbsdown")
            }
            Button(action: { /* Handle copy */ }) {
              Image(systemName: "doc.on.doc")
            }
            Button(action: { /* Handle retry */ }) {
              Image(systemName: "arrow.clockwise")
            }
          }
          .buttonStyle(.plain)
          .font(.system(size: 11))
          .foregroundColor(.white.opacity(0.32))
          .padding(.top, 8)
        }
      }
        .padding(.horizontal, message.role == .user ? 16 : 0)
        .padding(.vertical, message.role == .user ? 12 : 8)
        .background(message.role == .user ? Color.white : Color.clear)
        .clipShape(
          .rect(
            topLeadingRadius: 18,
            bottomLeadingRadius: 18,
            bottomTrailingRadius: message.role == .user ? 4 : 18,
            topTrailingRadius: 18,
            style: .continuous
          )
        )
        .overlay(
          Group {
            if message.role == .user {
              EmptyView()
            } else {
              // No border for assistant
              EmptyView()
            }
          }
        )
        .frame(maxWidth: 600, alignment: message.role == .user ? .trailing : .leading)

      if message.role != .user {
        Spacer()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
  }
}
