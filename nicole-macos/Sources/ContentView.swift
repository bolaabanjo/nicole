import SwiftUI

struct ContentView: View {
  @ObservedObject var settings: AppSettings
  @ObservedObject var viewModel: ChatViewModel

  @State private var isShowingSettings = false

  var body: some View {
    VStack(spacing: 0) {
      header

      Divider()
        .overlay(Color.white.opacity(0.08))

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
      minWidth: 420,
      idealWidth: settings.windowMode.idealWidth,
      minHeight: 680
    )
    .background(Color.black)
    .preferredColorScheme(.dark)
    .background(
      WindowAccessor { window in
        OverlayWindowManager.shared.attach(
          window: window,
          preferredWidth: settings.windowMode.idealWidth
        )
      }
    )
    .sheet(isPresented: $isShowingSettings) {
      SettingsView(settings: settings)
    }
    .task {
      await viewModel.loadHistory(baseURLString: settings.baseURLString)
    }
    .onChange(of: settings.windowMode) { _, mode in
      OverlayWindowManager.shared.updatePreferredWidth(mode.idealWidth)
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Nicole")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(Color.white)

        Text(primaryStatusLine)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(statusColor)
          .lineLimit(1)

        Text(secondaryStatusLine)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color.white.opacity(0.42))
          .lineLimit(1)
      }

      Spacer()

      Picker("Mode", selection: $settings.windowMode) {
        ForEach(AppSettings.WindowMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .frame(width: 190)

      Button {
        Task {
          await viewModel.loadHistory(baseURLString: settings.baseURLString)
        }
      } label: {
        Label("Refresh", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Color.white.opacity(0.8))

      Button {
        isShowingSettings = true
      } label: {
        Label("Settings", systemImage: "slider.horizontal.3")
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Color.white.opacity(0.8))
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
    .background(Color(red: 0.06, green: 0.06, blue: 0.07))
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
      Divider()
        .overlay(Color.white.opacity(0.08))

      HStack(alignment: .bottom, spacing: 12) {
        TextField("Talk to Nicole...", text: $viewModel.input, axis: .vertical)
          .textFieldStyle(.plain)
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(Color.white)
          .lineLimit(1 ... 6)
          .submitLabel(.send)
          .onSubmit {
            Task {
              await viewModel.send(baseURLString: settings.baseURLString, settings: settings)
            }
          }

        Button {
          Task {
            await viewModel.send(baseURLString: settings.baseURLString, settings: settings)
          }
        } label: {
          Image(systemName: viewModel.isSending ? "ellipsis" : "arrow.up")
            .font(.system(size: 15, weight: .bold))
            .frame(width: 38, height: 38)
            .background(viewModel.isSending ? Color.white.opacity(0.15) : Color.white)
            .foregroundStyle(viewModel.isSending ? Color.white.opacity(0.85) : Color.black)
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isSending)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .background(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(Color.white.opacity(0.06))
          .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
              .stroke(Color.white.opacity(0.08), lineWidth: 1)
          )
      )
      .padding(.horizontal, 20)
      .padding(.vertical, 18)
      .background(Color(red: 0.06, green: 0.06, blue: 0.07))
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
          Toggle("Include clipboard text", isOn: $settings.includeClipboard)

          Text("Clipboard text can help Nicole understand what you're working on, but it gets sent with each message.")
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

    switch viewModel.connectionState {
    case .idle:
      return "Set the canonical Nicole server once and this app will keep using it."
    case .connecting:
      return settings.derivedHostLabel.map { "Trying \($0). Toggle with Command-Shift-N." } ?? "Trying the configured server."
    case .connected(let messageCount):
      if messageCount == 0 {
        return "The server is up, but it returned no shared chat history yet."
      }
      return "\(messageCount) shared messages loaded. Toggle with Command-Shift-N."
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
}
