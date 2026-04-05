import SwiftUI
@preconcurrency import MarkdownUI

struct MessageBubbleView: View {
    let message: NicoleMessage
    @State private var isThoughtOpen: Bool

    init(message: NicoleMessage) {
      self.message = message
      self._isThoughtOpen = State(initialValue: message.isThoughtOpen)
    }
    
  var body: some View {
    HStack {
      if message.role == .user {
        Spacer()
      }

      VStack(alignment: .leading, spacing: 8) {
        if message.role == .assistant && (message.thoughtContent != nil || message.isStreaming) {
            ThoughtView(
                thought: message.thoughtContent ?? "",
                duration: message.thoughtDuration,
                isStreaming: message.isStreaming,
                isOpen: $isThoughtOpen
            )
            .padding(.bottom, 4)
        }

        if message.role == .user {
          // User message - white background, black text
          Markdown(message.content)
            .markdownTheme(.userNicole)
            .textSelection(.enabled)
        } else {
          // Assistant message - dark background, white text
          if !message.content.isEmpty {
            Markdown(message.content)
              .markdownTheme(.assistantNicole)
              .textSelection(.enabled)
          }
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
        .padding(.vertical, message.role == .user ? 8 : 4)
        .background(message.role == .user ? Color.white : Color.clear)
        .clipShape(
          NicoleBubbleShape(
            topLeading: 18,
            bottomLeading: 18,
            bottomTrailing: message.role == .user ? 4 : 18,
            topTrailing: 18
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
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)

      if message.role != .user {
        Spacer()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
    .frame(maxWidth: 720)
  }
}

@MainActor
extension Theme {
  static let assistantNicole = Theme()
    .text {
      ForegroundColor(.white.opacity(0.92))
      FontSize(15)
    }
    .paragraph { configuration in
      configuration.label
        .lineSpacing(4)
    }
    .code {
      FontFamilyVariant(.monospaced)
      FontSize(14)
      BackgroundColor(.white.opacity(0.1))
    }
      .codeBlock { configuration in
        ScrollView(.horizontal) {
          configuration.label
            .font(.system(size: 12, design: .monospaced))
            .padding(12)
        }
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.vertical, 12)
      }
    .strong {
      FontWeight(.semibold)
    }
    .link {
      ForegroundColor(.blue)
    }
    .heading1 { configuration in
        configuration.label
            .font(.system(size: 20, weight: .bold))
            .padding(.top, 16)
            .padding(.bottom, 8)
    }
    .heading2 { configuration in
        configuration.label
            .font(.system(size: 18, weight: .bold))
            .padding(.top, 14)
            .padding(.bottom, 6)
    }
    .heading3 { configuration in
        configuration.label
            .font(.system(size: 16, weight: .bold))
            .padding(.top, 12)
            .padding(.bottom, 4)
    }

  static let userNicole = Theme()
    .text {
      ForegroundColor(.black)
      FontSize(15)
      FontWeight(.medium)
    }
    .paragraph { configuration in
      configuration.label
        .lineSpacing(4)
    }
    .strong {
      FontWeight(.bold)
    }
}
