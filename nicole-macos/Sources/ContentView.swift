import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
  @ObservedObject var settings: AppSettings
  @ObservedObject var viewModel: ChatViewModel
  @ObservedObject var voiceController: NicoleVoiceController

  @State private var isShowingSettings = false
  @State private var selectedAttachment: ComposerAttachment?
  @State private var isDropTargeted = false

  private let maxContentWidth: CGFloat = 760

  var body: some View {
    VStack(spacing: 0) {
      header

      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 16) {
            if viewModel.messages.isEmpty && !viewModel.isLoadingHistory {
              emptyState
            } else {
              ForEach(viewModel.messages.filter { $0.role != .system }) { message in
                MessageBubbleView(message: message)
                  .id(message.id)
              }
            }
          }
          .padding(.horizontal, 20)
          .padding(.vertical, 20)
          .frame(maxWidth: maxContentWidth)
          .frame(maxWidth: .infinity)
        }
        .background(Color.black)
        .onChange(of: viewModel.messages.last?.id) { _, messageID in
          guard let messageID else { return }
          withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(messageID, anchor: .bottom)
          }
        }
      }

      composer
    }
    .frame(
      minWidth: AppSettings.WindowMode.expanded.minimumWidth,
      idealWidth: AppSettings.WindowMode.expanded.idealWidth,
      minHeight: AppSettings.WindowMode.expanded.minimumHeight
    )
    .background(Color.black)
    .preferredColorScheme(.dark)
    .sheet(isPresented: $isShowingSettings) {
      SettingsView(settings: settings)
    }
    .task {
      await viewModel.loadHistory(baseURLString: settings.baseURLString)
    }
  }

  private var header: some View {
    HStack(spacing: 0) {
      Spacer()
      HStack(alignment: .center, spacing: 0) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 8) {
            Text("Nicole")
              .font(.system(size: 16, weight: .bold))
              .foregroundStyle(Color.white)
            
            Circle()
              .fill(statusDotColor)
              .frame(width: 6, height: 6)
          }

          Text(primaryStatusLine)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.42))
            .lineLimit(1)
        }

        Spacer()

        HStack(spacing: 16) {
          Button {
            Task {
              await viewModel.loadHistory(baseURLString: settings.baseURLString)
            }
          } label: {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 14, weight: .medium))
          }
          .buttonStyle(.plain)
          .foregroundStyle(Color.white.opacity(0.58))
          .help("Refresh History")

          Button {
            isShowingSettings = true
          } label: {
            Image(systemName: "slider.horizontal.3")
              .font(.system(size: 14, weight: .medium))
          }
          .buttonStyle(.plain)
          .foregroundStyle(Color.white.opacity(0.58))
          .help("Settings")
        }
      }
      .frame(maxWidth: maxContentWidth)
      .padding(.horizontal, 20)
      Spacer()
    }
    .padding(.vertical, 8)
    .background(Color.black)
  }

  private var statusDotColor: Color {
    switch viewModel.connectionState {
    case .connected:
      return .green
    case .connecting, .syncing:
      return .orange
    case .failed:
      return .red
    case .idle:
      return .white.opacity(0.24)
    }
  }

  private var emptyState: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Native Nicole")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(Color.white)

      Text(emptyStateBodyText)
        .font(.system(size: 15, weight: .regular))
        .foregroundStyle(Color.white.opacity(0.66))
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, minHeight: 360, alignment: .center)
  }

  private var composer: some View {
    VStack(spacing: 0) {
      VStack(spacing: 12) {
        if let selectedAttachment {
          HStack {
            attachmentPreview(selectedAttachment)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 4)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }

        HStack(alignment: .center, spacing: 12) {
          Button {
            openAttachmentPicker()
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 15, weight: .medium))
              .foregroundStyle(Color.white.opacity(0.58))
              .frame(width: 24, height: 24)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)

          TextField("Talk to Nicole...", text: $viewModel.input, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(Color.white.opacity(0.94))
            .lineLimit(1 ... 8)
            .submitLabel(.send)
            .onSubmit {
              submitCurrentMessage()
            }

          Button {
            toggleExpandedVoiceInput()
          } label: {
            Image(systemName: expandedVoiceIconName)
              .font(.system(size: 15, weight: .medium))
              .frame(width: 28, height: 28)
              .foregroundStyle(expandedVoiceColor)
          }
          .buttonStyle(.plain)
          .help(expandedVoiceHelpText)

          Button {
            submitCurrentMessage()
          } label: {
            Image(systemName: viewModel.isSending ? "ellipsis" : "arrow.up")
              .font(.system(size: 15, weight: .bold))
              .frame(width: 32, height: 32)
              .background(viewModel.isSending ? Color.white.opacity(0.12) : Color.white)
              .foregroundStyle(viewModel.isSending ? Color.white.opacity(0.8) : Color.black)
              .clipShape(Circle())
          }
          .buttonStyle(.plain)
          .disabled(isSendDisabled)
          .opacity(isSendDisabled ? 0.42 : 1)
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(
          RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color.white.opacity(0.045))
            .overlay(
              RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
        )

        if let voiceStatusText = voiceController.inlineStatusText {
          HStack {
            Text(voiceStatusText)
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(Color.white.opacity(0.45))
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 4)
          .transition(.opacity)
        }

      }
      .frame(maxWidth: maxContentWidth)
      .padding(.horizontal, 20)
      .padding(.top, 16)
      .padding(.bottom, 12)
      .frame(maxWidth: .infinity)
      .background(Color.black)
      .overlay {
        if isDropTargeted {
          RoundedRectangle(cornerRadius: 28, style: .continuous)
            .stroke(Color.white.opacity(0.22), style: StrokeStyle(lineWidth: 1.5, dash: [8, 8]))
            .padding(.horizontal, 26)
            .padding(.vertical, 18)
        }
      }
      .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isDropTargeted) { providers in
        handleDroppedFile(providers: providers)
      }
    }
  }
}

private struct SettingsView: View {
  @ObservedObject var settings: AppSettings
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section("Canonical Server") {
          TextField("Server name", text: $settings.serverName, prompt: Text("Banjo"))
            .textFieldStyle(.roundedBorder)

          TextField("Nicole server URL", text: $settings.baseURLString, prompt: Text("http://banjo.local:3000"))
            .textFieldStyle(.roundedBorder)

          Text("Point the Mac app at your canonical Nicole server. This should usually be Banjo, not this Mac.")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)

          if let host = settings.derivedHostLabel {
            Text("Currently targeting \(host).")
              .font(.system(size: 12))
              .foregroundStyle(.secondary)
          }
        }

        Section("Context") {
          Text("Nicole now uses hidden local workspace sensing on your Mac. Accessibility improves selected text capture, and Screen Recording enables local OCR of visible screen text. Nothing is shown visibly in the UI.")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        }

        Section("Voice") {
          Toggle("Always listen for “Hey Nicole” or “Nicole”", isOn: $settings.alwaysOnVoiceEnabled)
          Toggle("Speak Nicole's replies aloud", isOn: $settings.voiceRepliesEnabled)

          Text("Always-on voice is Mac-only in this build. When enabled, Nicole listens locally for “Hey Nicole” or “Nicole”, sends the spoken request through Banjo, speaks back through your Mac, then resumes listening.")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)

          Text("The microphone button still fills the composer with live transcription when you want a UI-driven loop.")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            dismiss()
          }
        }
      }
    }
    .frame(minWidth: 480, minHeight: 260)
  }
}

private extension ContentView {
  var primaryStatusLine: String {
    switch viewModel.connectionState {
    case .idle:
      return "Choose Nicole's server in Settings."
    case .connecting:
      return "Connecting to \(settings.serverDisplayName)…"
    case .connected(let messageCount):
      if messageCount == 0 {
        return "Connected to \(settings.serverDisplayName)"
      }
      return "Connected to \(settings.serverDisplayName)"
    case .syncing:
      return "Syncing with \(settings.serverDisplayName)…"
    case .failed:
      return "Couldn’t reach \(settings.serverDisplayName)"
    }
  }

  var secondaryStatusLine: String {
    if let errorText = viewModel.errorText, case .failed = viewModel.connectionState {
      return errorText
    }

    if let infoText = viewModel.infoText {
      return infoText
    }

    switch viewModel.connectionState {
    case .idle:
      return "Set the canonical Nicole server once and this app will keep using it."
    case .connecting:
      return settings.derivedHostLabel.map { "Trying \($0). Summon Compact with Control-N." } ?? "Trying the configured server."
    case .connected(let messageCount):
      if messageCount == 0 {
        return "The server is up, but it returned no shared chat history yet."
      }
      return "\(messageCount) shared messages loaded. Summon Compact with Control-N."
    case .syncing:
      return "Sending this conversation through the shared Nicole backend."
    case .failed:
      return settings.derivedHostLabel.map { "Last known server: \($0)." } ?? "Check the configured server URL."
    }
  }

  var statusColor: Color {
    switch viewModel.connectionState {
    case .failed:
      return Color.red.opacity(0.9)
    case .connected:
      return Color.white.opacity(0.78)
    case .syncing, .connecting:
      return Color.white.opacity(0.68)
    case .idle:
      return Color.white.opacity(0.58)
    }
  }

  var shouldShowDiagnostics: Bool {
    false
  }

  var emptyStateBodyText: String {
    switch viewModel.connectionState {
    case .connected(let messageCount) where messageCount == 0:
      return "\(settings.serverDisplayName) is reachable, but it returned no shared chat history yet. If you expected old conversations here, make sure this app is pointed at Banjo's real Nicole backend and database."
    case .failed:
      return "This Mac app is only the shell. Nicole's actual memory and conversation history live on the canonical server you connect to."
    default:
      return "This is the first native macOS shell for Nicole. It connects to your canonical Nicole server, so the same conversation and memory can follow you across devices."
    }
  }

  var isSendDisabled: Bool {
    viewModel.isSending || (
      viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
      selectedAttachment == nil
    )
  }

  func submitCurrentMessage() {
    guard !isSendDisabled else { return }
    voiceController.stopListeningIfActive(on: .expanded)

    Task {
      let didComplete = await viewModel.send(
        baseURLString: settings.baseURLString,
        settings: settings,
        attachmentURL: selectedAttachment?.url
      )

      if didComplete {
        withAnimation(.easeOut(duration: 0.16)) {
          selectedAttachment = nil
        }
      }
    }
  }

  var expandedVoiceIconName: String {
    voiceController.isListening(on: .expanded) ? "waveform.circle.fill" : "mic"
  }

  var expandedVoiceColor: Color {
    voiceController.isListening(on: .expanded)
      ? Color.green.opacity(0.95)
      : Color.white.opacity(0.58)
  }

  var expandedVoiceHelpText: String {
    voiceController.isListening(on: .expanded) ? "Stop voice input" : "Start voice input"
  }

  func toggleExpandedVoiceInput() {
    voiceController.toggleListening(
      on: .expanded,
      seedText: viewModel.input
    ) { transcript in
      viewModel.input = transcript
    }
  }

  @ViewBuilder
  func attachmentPreview(_ attachment: ComposerAttachment) -> some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if let previewImage = attachment.previewImage {
          Image(nsImage: previewImage)
            .resizable()
            .scaledToFill()
        } else {
          VStack(spacing: 4) {
            Image(systemName: "doc.fill")
              .font(.system(size: 14))
            Text(attachment.typeLabel)
              .font(.system(size: 8, weight: .bold))
          }
          .foregroundStyle(Color.white.opacity(0.45))
        }
      }
      .frame(width: 44, height: 44)
      .background(Color.white.opacity(0.06))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(Color.white.opacity(0.08), lineWidth: 1)
      )

      Button {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
          selectedAttachment = nil
        }
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 8, weight: .bold))
          .frame(width: 16, height: 16)
          .background(Color.red.opacity(0.85))
          .foregroundStyle(Color.white)
          .clipShape(Circle())
      }
      .buttonStyle(.plain)
      .offset(x: 6, y: -6)
    }
    .help(attachment.displayName)
  }

  func openAttachmentPicker() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.content, .item]

    if panel.runModal() == .OK, let url = panel.url {
      withAnimation(.easeOut(duration: 0.18)) {
        selectedAttachment = ComposerAttachment(url: url)
      }
    }
  }

  func handleDroppedFile(providers: [NSItemProvider]) -> Bool {
    guard
      let provider = providers.first(where: {
        $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
      })
    else {
      return false
    }

    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
      var resolvedURL: URL?

      if let data = item as? Data {
        resolvedURL = URL(dataRepresentation: data, relativeTo: nil)
      } else if let url = item as? URL {
        resolvedURL = url
      }

      guard let resolvedURL else { return }

      DispatchQueue.main.async {
        withAnimation(.easeOut(duration: 0.18)) {
          selectedAttachment = ComposerAttachment(url: resolvedURL)
        }
      }
    }

    return true
  }

}

private struct ComposerAttachment {
  let url: URL
  let displayName: String
  let typeLabel: String
  let previewImage: NSImage?

  init(url: URL) {
    self.url = url
    self.displayName = url.lastPathComponent

    let fileExtension = url.pathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
    if fileExtension.isEmpty {
      self.typeLabel = "File"
    } else {
      self.typeLabel = fileExtension.uppercased()
    }

    self.previewImage = NSImage(contentsOf: url)
  }
}
