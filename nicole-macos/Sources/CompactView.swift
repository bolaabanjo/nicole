import SwiftUI

private struct CompactContentHeightKey: PreferenceKey {
  static let defaultValue: CGFloat = 76

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

struct CompactView: View {
  @ObservedObject var settings: AppSettings
  @ObservedObject var viewModel: ChatViewModel
  @ObservedObject var panelState: CompactPanelState
  @ObservedObject var voiceController: NicoleVoiceController

  @FocusState private var isInputFocused: Bool
  @State private var draft = ""

  private let horizontalInset: CGFloat = 16
  private let responseMaxHeight: CGFloat = 780

  var body: some View {
    VStack(spacing: 0) {
      if !panelState.exchanges.isEmpty {
        HStack(spacing: 16) {
          Button {
            CompactWindowManager.shared.hidePanel()
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.system(size: 16, weight: .regular))
              .foregroundStyle(Color.white.opacity(0.3), Color.white.opacity(0.1))
          }
          .buttonStyle(.plain)

          Spacer()

          Button(action: {}) {
            Image(systemName: "doc.on.doc")
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(Color.white.opacity(0.4))
          }
          .buttonStyle(.plain)

          Button(action: {
            panelState.clearExchanges()
          }) {
            Image(systemName: "square.and.pencil")
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(Color.white.opacity(0.4))
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)

        ScrollViewReader { proxy in
          ScrollView {
            VStack(spacing: 24) {
              ForEach(panelState.exchanges) { exchange in
                MessageBubbleView(
                  message: NicoleMessage(role: .user, content: exchange.userText)
                )

                if let assistantMsg = viewModel.messages.first(where: { $0.id == exchange.assistantMessageID }) {
                  MessageBubbleView(message: assistantMsg)
                    .id(assistantMsg.id)
                }
              }
            }
            .padding(.horizontal, horizontalInset)
            .padding(.top, 16)
            .padding(.bottom, 24)
            .fixedSize(horizontal: false, vertical: true)
          }
          .onChange(of: viewModel.messages.last?.id) { _, newId in
            if let id = newId {
              withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) }
            }
          }
        }
        .frame(minHeight: 400, maxHeight: responseMaxHeight)
      }


      HStack(alignment: .center, spacing: 12) {
        HStack(spacing: 12) {
          Button(action: {}) {
            Image(systemName: "plus")
          }
          Button(action: {}) {
            Image(systemName: "globe")
          }
          Button(action: {}) {
            Image(systemName: "textformat")
          }
        }
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(Color.white.opacity(0.5))
        .buttonStyle(.plain)

        TextField("Talk to Nicole...", text: $draft)
          .textFieldStyle(.plain)
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(Color.white.opacity(0.94))
          .lineLimit(1)
          .focused($isInputFocused)
          .submitLabel(.send)
          .onSubmit {
            submit()
          }

        HStack(spacing: 12) {
          Button {
            toggleCompactVoiceInput()
          } label: {
            Image(systemName: compactVoiceIconName)
          }
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(compactVoiceColor)
          .buttonStyle(.plain)
          .help(compactVoiceHelpText)

          Button {
            submit()
          } label: {
            Image(systemName: viewModel.isSending ? "ellipsis" : "arrow.up")
              .font(.system(size: 13, weight: .bold))
              .frame(width: 28, height: 28)
              .background(
                viewModel.isSending
                  ? Color.white.opacity(0.12)
                  : (isSendDisabled ? Color.white.opacity(0.2) : Color.white)
              )
              .foregroundStyle(
                viewModel.isSending
                  ? Color.white
                  : (isSendDisabled ? Color.white.opacity(0.5) : Color.black)
              )
              .clipShape(Circle())
          }
          .buttonStyle(.plain)
          .disabled(isSendDisabled)
        }
      }
      .padding(.leading, 14)
      .padding(.trailing, 10)
      .padding(.vertical, 10)
      .background(
        Group {
          if !panelState.exchanges.isEmpty {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
              .fill(Color.white.opacity(0.045))
              .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                  .stroke(Color.white.opacity(0.08), lineWidth: 1)
              )
          } else {
            Color.clear
          }
        }
      )
      .padding(.horizontal, !panelState.exchanges.isEmpty ? 12 : 0)
      .padding(.bottom, !panelState.exchanges.isEmpty ? 12 : 0)

      if let voiceStatusText = voiceController.inlineStatusText {
        HStack {
          Text(voiceStatusText)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.42))
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 12)
      }
    }
    .background(
      RoundedRectangle(cornerRadius: 34, style: .continuous)
        .fill(Color(white: 0.1).opacity(0.98))
    )
    .background(
      GeometryReader { geometry in
        Color.clear.preference(
          key: CompactContentHeightKey.self,
          value: geometry.size.height
        )
      }
    )
    .onPreferenceChange(CompactContentHeightKey.self) { height in
      CompactWindowManager.shared.updatePanelHeight(height, animated: true)
    }
    .onChange(of: panelState.focusRequestID) { _, _ in
      focusInputSoon()
    }
    .onAppear {
      focusInputSoon()
    }
    .animation(.spring(response: 0.3, dampingFraction: 0.8), value: !panelState.exchanges.isEmpty)
    .animation(.spring(response: 0.3, dampingFraction: 0.8), value: viewModel.messages.last?.id)
    .animation(.spring(response: 0.3, dampingFraction: 0.8), value: viewModel.isSending)
  }


  private var isSendDisabled: Bool {
    viewModel.isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var compactVoiceIconName: String {
    voiceController.isListening(on: .compact) ? "waveform.circle.fill" : "mic"
  }

  private var compactVoiceColor: Color {
    voiceController.isListening(on: .compact)
      ? Color.green.opacity(0.95)
      : Color.white.opacity(0.5)
  }

  private var compactVoiceHelpText: String {
    voiceController.isListening(on: .compact) ? "Stop voice input" : "Start voice input"
  }

  private func submit() {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !viewModel.isSending else { return }

    let submittedText = trimmed
    voiceController.stopListeningIfActive(on: .compact)

    Task {
      if let assistantID = await viewModel.sendCompactMessage(
        submittedText,
        baseURLString: settings.baseURLString,
        settings: settings
      ) {
        panelState.beginExchange(userText: submittedText, assistantMessageID: assistantID)
        draft = ""
      }
    }
  }

  private func toggleCompactVoiceInput() {
    voiceController.toggleListening(
      on: .compact,
      seedText: draft
    ) { transcript in
      draft = transcript
    }
  }

  private func focusInputSoon() {
    DispatchQueue.main.async {
      isInputFocused = true
    }
  }
}
