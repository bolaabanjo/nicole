import SwiftUI
import MarkdownUI

struct MobileContentView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool

    @State private var showFilePicker = false
    @State private var showSettings = false
    @State private var isRecording = false
    @State private var voiceStatusText: String?
    @State private var speechRecognizer = SpeechRecognizer()

    private let maxContentWidth: CGFloat = 760

    var body: some View {
        VStack(spacing: 0) {
            headerView

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

                        Color.clear.frame(height: 12)
                    }
                    .padding(.top, 20)
                    .frame(maxWidth: .infinity)
                }
                .background(Color.black)
                .onChange(of: viewModel.messages.last?.id) { newValue in
                    guard let newValue else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(newValue, anchor: .bottom)
                    }
                }
            }

            composerView
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showSettings) {
            MobileSettingsView(settings: settings, viewModel: viewModel)
        }
        #if os(iOS)
        .sheet(isPresented: $showFilePicker) {
            DocumentPicker { url in
                Task {
                    await viewModel.send(
                        baseURLString: settings.baseURLString,
                        settings: settings,
                        attachmentURL: url
                    )
                }
            }
        }
        #endif
        .onAppear {
            if !settings.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Task {
                    _ = await viewModel.connectMobileClient(settings: settings)
                }
            } else {
                showSettings = true
            }
        }
    }

    // MARK: - Header

    private var headerView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Spacer()
                HStack(alignment: .center, spacing: 0) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text("Nicole")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.white)

                            Circle()
                                .fill(viewModel.connectionState.indicatorColor)
                                .frame(width: 6, height: 6)
                        }

                        Text(primaryStatusLine)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.white.opacity(0.42))
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
                        .foregroundColor(.white.opacity(0.58))

                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "slider.horizontal.3")
                                .font(.system(size: 14, weight: .medium))
                        }
                        .foregroundColor(.white.opacity(0.58))
                    }
                }
                .padding(.horizontal, 20)
                Spacer()
            }
            .padding(.vertical, 12)

            Divider()
                .background(Color.white.opacity(0.08))
        }
        .background(Color.black)
    }

    // MARK: - Composer

    private var composerView: some View {
        VStack(spacing: 0) {
            // Info/error banner
            if let info = viewModel.infoText {
                Text(info)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.green.opacity(0.8))
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)
            }
            if let error = viewModel.errorText {
                Text(error)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.red.opacity(0.8))
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)
            }
            if let voiceStatusText {
                Text(voiceStatusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white.opacity(0.62))
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)
            }

            VStack(spacing: 12) {
                HStack(alignment: .center, spacing: 12) {
                    Button {
                        showFilePicker = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.white.opacity(0.58))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)

                    TextField("Talk to Nicole...", text: $viewModel.input, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundColor(.white.opacity(0.94))
                        .lineLimit(1...8)
                        .focused($isInputFocused)

                    // Mic button
                    Button {
                        toggleRecording()
                    } label: {
                        Image(systemName: isRecording ? "mic.fill" : "mic")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(isRecording ? .red : .white.opacity(0.5))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)

                    // Send button
                    Button {
                        submitCurrentMessage()
                    } label: {
                        Image(systemName: viewModel.isSending ? "ellipsis" : "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .frame(width: 32, height: 32)
                            .background(viewModel.isSending ? Color.white.opacity(0.12) : Color.white)
                            .foregroundColor(viewModel.isSending ? Color.white.opacity(0.8) : Color.black)
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
                    RoundedRectangle(cornerRadius: 100, style: .continuous)
                        .fill(Color.white.opacity(0.045))
                        .overlay(
                            RoundedRectangle(cornerRadius: 100, style: .continuous)
                                .stroke(Color.white.opacity(0.08), lineWidth: 1)
                        )
                )
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 34)
            .background(Color.black)
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nicole")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.white)

            Text("This is your standalone mobile assistant. It connects to the same memory as your Mac and Web apps.")
                .font(.system(size: 15, weight: .regular))
                .foregroundColor(.white.opacity(0.66))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 400, alignment: .center)
        .padding(.horizontal, 40)
    }

    // MARK: - Helpers

    private var primaryStatusLine: String {
        switch viewModel.connectionState {
        case .idle:
            return viewModel.isTrustedDevicePaired
              ? "Ready for \(settings.serverDisplayName)"
              : "Pair this iPhone with Banjo."
        case .connecting:
            return "Connecting to \(settings.serverDisplayName)…"
        case .connected:
            if let trustedDeviceName = viewModel.trustedDeviceName {
                return "Connected to \(settings.serverDisplayName) as \(trustedDeviceName)"
            }
            return "Connected to \(settings.serverDisplayName)"
        case .syncing:
            return "Syncing..."
        case .failed:
            return "Couldn't reach \(settings.serverDisplayName)"
        }
    }

    private var isSendDisabled: Bool {
        viewModel.isSending || viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submitCurrentMessage() {
        guard !isSendDisabled else { return }
        speechRecognizer.stop()
        isRecording = false
        Task {
            await viewModel.send(baseURLString: settings.baseURLString, settings: settings)
        }
    }

    private func toggleRecording() {
        if isRecording {
            speechRecognizer.stop()
            isRecording = false
            voiceStatusText = nil
        } else {
            speechRecognizer.start { active, errorText in
                isRecording = active
                voiceStatusText = errorText
            } onTranscript: { transcript in
                viewModel.input = transcript
            }
        }
    }
}

// MARK: - Settings Sheet

struct MobileSettingsView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var viewModel: ChatViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                Section("Server") {
                    TextField("Server name", text: $settings.serverName)
                    TextField("Banjo URL (Tailscale)", text: $settings.baseURLString)
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()

                    TextField("This iPhone's name", text: $settings.deviceName)

                    SecureField("Pairing code", text: $settings.pairingCode)

                    Text("Use Banjo's Tailscale-reachable Nicole URL here. The pairing code is a one-time trust step so this iPhone can talk to Nicole privately.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button(viewModel.isTrustedDevicePaired ? "Reconnect" : "Pair & Connect") {
                        dismiss()
                        Task {
                            _ = await viewModel.connectMobileClient(settings: settings)
                        }
                    }
                    .disabled(settings.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let trustedDeviceName = viewModel.trustedDeviceName {
                    Section("Trusted Device") {
                        Text("Paired as \(trustedDeviceName).")
                            .font(.system(size: 13, weight: .medium))
                    }
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: - Document Picker

#if os(iOS)
import UniformTypeIdentifiers

struct DocumentPicker: UIViewControllerRepresentable {
    let onPick: (URL) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [
            .pdf, .plainText, .text, .png, .jpeg, .heic, .image,
        ])
        picker.delegate = context.coordinator
        picker.allowsMultipleSelection = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void

        init(onPick: @escaping (URL) -> Void) {
            self.onPick = onPick
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            if url.startAccessingSecurityScopedResource() {
                onPick(url)
                url.stopAccessingSecurityScopedResource()
            }
        }
    }
}
#endif

// MARK: - Speech Recognizer

#if os(iOS)
import Speech
import AVFoundation

final class SpeechRecognizer: ObservableObject {
    private var recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var onTranscript: ((String) -> Void)?
    private var onStateChange: ((Bool, String?) -> Void)?

    func start(
        onStateChange: @escaping (Bool, String?) -> Void,
        onTranscript: @escaping (String) -> Void
    ) {
        self.onStateChange = onStateChange
        self.onTranscript = onTranscript

        Task {
            let speechGranted = await requestSpeechAuthorization()
            guard speechGranted else {
                await MainActor.run {
                    onStateChange(false, "Allow Speech Recognition for Nicole in Settings.")
                }
                return
            }

            let micGranted = await requestMicrophoneAuthorization()
            guard micGranted else {
                await MainActor.run {
                    onStateChange(false, "Allow microphone access for Nicole in Settings.")
                }
                return
            }

            await MainActor.run {
                self.beginRecording()
            }
        }
    }

    func stop() {
        audioEngine.stop()
        if audioEngine.inputNode.numberOfInputs > 0 {
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        Task { @MainActor in
            self.onStateChange?(false, nil)
        }
    }

    private func beginRecording() {
        stop()

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            onStateChange?(false, "Nicole couldn't start the microphone.")
            return
        }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else {
            onStateChange?(false, "Nicole couldn't prepare speech recognition.")
            return
        }
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.requiresOnDeviceRecognition = false
        onStateChange?(true, "Listening…")

        recognitionTask = recognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            if let result {
                Task { @MainActor in
                    self?.onTranscript?(result.bestTranscription.formattedString)
                }
            }

            if let error {
                Task { @MainActor in
                    self?.onStateChange?(false, error.localizedDescription)
                }
            }

            if error != nil || (result?.isFinal == true) {
                Task { @MainActor in
                    self?.stop()
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            onStateChange?(false, "Nicole couldn't start the audio engine.")
            stop()
        }
    }

    private func requestSpeechAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private func requestMicrophoneAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
#else
final class SpeechRecognizer: ObservableObject {
    func start(
        onStateChange: @escaping (Bool, String?) -> Void,
        onTranscript: @escaping (String) -> Void
    ) {}
    func stop() {}
}
#endif

// MARK: - Connection State Color

extension ChatViewModel.ConnectionState {
    var indicatorColor: Color {
        switch self {
        case .connected: return .green
        case .connecting, .syncing: return .orange
        case .failed: return .red
        case .idle: return .white.opacity(0.24)
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
