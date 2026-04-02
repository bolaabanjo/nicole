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
    .sheet(isPresented: $isShowingSettings) {
      SettingsView(settings: settings)
    }
    .task {
      await viewModel.loadHistory(baseURLString: settings.baseURLString)
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Nicole")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(Color.white)

        Text(viewModel.errorText ?? viewModel.statusText)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(viewModel.errorText == nil ? Color.white.opacity(0.58) : Color.red.opacity(0.9))
          .lineLimit(1)

        if let backendOrigin = viewModel.backendOrigin {
          Text("Backend: \(backendOrigin)")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.42))
            .lineLimit(1)
        }

        if let lastRequestURL = viewModel.lastRequestURL {
          Text("Route: \(lastRequestURL)")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.34))
            .lineLimit(1)
            .textSelection(.enabled)
        }
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

      Text("This is the first local macOS shell for Nicole. It already talks to the same brain as the web app, so your history stays shared.")
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
        Section("Backend") {
          TextField("Base URL", text: $settings.baseURLString)
            .textFieldStyle(.roundedBorder)

          Text("Use your local Nicole server, for example `http://127.0.0.1:3000`.")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        }

        Section("Context") {
          Toggle("Include clipboard text", isOn: $settings.includeClipboard)
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
