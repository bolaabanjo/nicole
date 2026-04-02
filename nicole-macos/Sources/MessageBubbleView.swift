import SwiftUI

struct MessageBubbleView: View {
  let message: NicoleMessage

  var body: some View {
    HStack {
      if message.role == .user {
        Spacer(minLength: 40)
      }

      VStack(alignment: .leading, spacing: 8) {
        Text(message.content.isEmpty && message.isStreaming ? "Nicole is thinking..." : message.content)
          .textSelection(.enabled)
          .font(.system(size: 15, weight: .regular, design: .default))
          .foregroundStyle(foregroundStyle)
          .frame(maxWidth: .infinity, alignment: .leading)

        if message.isStreaming {
          ProgressView()
            .controlSize(.small)
            .tint(.secondary)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .frame(maxWidth: 560, alignment: .leading)
      .background(bubbleBackground)
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .strokeBorder(borderColor, lineWidth: 1)
      )

      if message.role != .user {
        Spacer(minLength: 40)
      }
    }
  }

  private var bubbleBackground: some ShapeStyle {
    switch message.role {
    case .user:
      return Color.white
    case .assistant:
      return Color.white.opacity(0.05)
    case .system:
      return Color.white.opacity(0.03)
    }
  }

  private var foregroundStyle: some ShapeStyle {
    switch message.role {
    case .user:
      return Color.black
    case .assistant, .system:
      return Color.white.opacity(0.94)
    }
  }

  private var borderColor: Color {
    switch message.role {
    case .user:
      return Color.white.opacity(0.18)
    case .assistant, .system:
      return Color.white.opacity(0.08)
    }
  }
}
