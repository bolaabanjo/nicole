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
        if message.role == .assistant && shouldShowThoughtView {
            ThoughtView(
                thought: message.thoughtContent ?? "",
                duration: message.thoughtDuration,
                isStreaming: message.isStreaming,
                isOpen: $isThoughtOpen
            )
            .padding(.bottom, 4)
        }

        if message.role == .assistant && hasActivityFeed {
          AssistantActivityFeedView(message: message)
            .padding(.bottom, message.content.isEmpty ? 4 : 8)
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
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)

      if message.role != .user {
        Spacer()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
    .frame(maxWidth: 720)
  }

  private var hasActivityFeed: Bool {
    message.preActionText?.isEmpty == false ||
      message.liveStatusText?.isEmpty == false ||
      !message.activityItems.isEmpty
  }

  private var shouldShowThoughtView: Bool {
    (message.thoughtContent != nil || message.isStreaming) && !hasActivityFeed
  }
}

private struct AssistantActivityFeedView: View {
  let message: NicoleMessage

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let preActionText = message.preActionText, !preActionText.isEmpty {
        Text(preActionText)
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(Color.white.opacity(0.9))
          .fixedSize(horizontal: false, vertical: true)
      }

      if let liveStatusText = message.liveStatusText, !liveStatusText.isEmpty {
        HStack(spacing: 8) {
          Circle()
            .fill(Color.white.opacity(0.5))
            .frame(width: 6, height: 6)

          Text(liveStatusText)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.52))
        }
      }

      if !message.activityItems.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(message.activityItems) { item in
            HStack(alignment: .center, spacing: 8) {
              Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.62))

              Text(item.text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.05))
            )
          }
        }
      }
    }
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
