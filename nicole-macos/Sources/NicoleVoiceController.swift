import AppKit
import AVFoundation
import Speech

@MainActor
final class NicoleVoiceController: NSObject, ObservableObject {
  enum Surface: Equatable {
    case expanded
    case compact
  }

  enum InputState: Equatable {
    case idle
    case requestingPermissions
    case listening(Surface)
    case failed(String)
  }

  @Published private(set) var inputState: InputState = .idle

  var inlineStatusText: String? {
    switch inputState {
    case .idle:
      return nil
    case .requestingPermissions:
      return "Requesting microphone and speech access…"
    case .listening:
      return "Listening…"
    case let .failed(message):
      return message
    }
  }

  private let audioEngine = AVAudioEngine()
  private let synthesizer = AVSpeechSynthesizer()
  private let speechRecognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()

  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var transcriptSink: ((String) -> Void)?
  private var lastSpokenAssistantMessageID: String?

  func isListening(on surface: Surface) -> Bool {
    guard case let .listening(activeSurface) = inputState else {
      return false
    }

    return activeSurface == surface
  }

  func toggleListening(
    on surface: Surface,
    seedText: String,
    onTranscript: @escaping (String) -> Void
  ) {
    if isListening(on: surface) {
      stopListening()
      return
    }

    Task {
      await startListening(on: surface, seedText: seedText, onTranscript: onTranscript)
    }
  }

  func stopListeningIfActive(on surface: Surface) {
    guard isListening(on: surface) else { return }
    stopListening()
  }

  func handleCompletedAssistantMessage(_ message: NicoleMessage) {
    guard
      let appDelegate = NSApp.delegate as? AppDelegate,
      let settings = appDelegate.settings,
      settings.voiceRepliesEnabled,
      message.role == .assistant,
      !message.content.isEmpty,
      lastSpokenAssistantMessageID != message.id
    else {
      return
    }

    lastSpokenAssistantMessageID = message.id
    speak(text: message.content)
  }

  private func startListening(
    on surface: Surface,
    seedText: String,
    onTranscript: @escaping (String) -> Void
  ) async {
    guard let speechRecognizer else {
      inputState = .failed("Speech recognition isn’t available on this Mac.")
      return
    }

    synthesizer.stopSpeaking(at: .immediate)
    stopListening(clearStatus: false)
    inputState = .requestingPermissions

    let permissions = await requestPermissions()
    guard permissions.microphoneGranted else {
      inputState = .failed("Microphone access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    guard permissions.speechGranted else {
      inputState = .failed("Speech recognition access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    do {
      let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
      recognitionRequest.shouldReportPartialResults = true
      recognitionRequest.requiresOnDeviceRecognition = speechRecognizer.supportsOnDeviceRecognition

      self.recognitionRequest = recognitionRequest
      self.transcriptSink = onTranscript
      self.inputState = .listening(surface)

      let inputNode = audioEngine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        self?.recognitionRequest?.append(buffer)
      }

      audioEngine.prepare()
      try audioEngine.start()

      recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
        guard let self else { return }

        if let result {
          let transcript = self.mergeTranscript(
            seedText: seedText,
            transcript: result.bestTranscription.formattedString
          )

          Task { @MainActor in
            self.transcriptSink?(transcript)

            if result.isFinal {
              self.stopListening()
            }
          }
        }

        if let error {
          Task { @MainActor in
            self.stopListening(clearStatus: false)
            self.inputState = .failed("Voice input stopped: \(error.localizedDescription)")
          }
        }
      }
    } catch {
      stopListening(clearStatus: false)
      inputState = .failed("Nicole couldn’t start listening: \(error.localizedDescription)")
    }
  }

  private func stopListening(clearStatus: Bool = true) {
    recognitionTask?.cancel()
    recognitionTask = nil

    recognitionRequest?.endAudio()
    recognitionRequest = nil

    if audioEngine.isRunning {
      audioEngine.stop()
    }

    audioEngine.inputNode.removeTap(onBus: 0)
    transcriptSink = nil

    if clearStatus {
      inputState = .idle
    }
  }

  private func speak(text: String) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.rate = 0.48
    utterance.pitchMultiplier = 1.02
    utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")
    synthesizer.speak(utterance)
  }

  private func mergeTranscript(seedText: String, transcript: String) -> String {
    let trimmedSeed = seedText.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmedSeed.isEmpty else {
      return trimmedTranscript
    }

    if trimmedTranscript.isEmpty {
      return trimmedSeed
    }

    return "\(trimmedSeed) \(trimmedTranscript)"
  }

  private func requestPermissions() async -> (speechGranted: Bool, microphoneGranted: Bool) {
    async let speechGranted = requestSpeechAuthorization()
    async let microphoneGranted = requestMicrophoneAuthorization()
    return await (speechGranted, microphoneGranted)
  }

  private func requestSpeechAuthorization() async -> Bool {
    let status = SFSpeechRecognizer.authorizationStatus()

    switch status {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { authorizationStatus in
          continuation.resume(returning: authorizationStatus == .authorized)
        }
      }
    @unknown default:
      return false
    }
  }

  private func requestMicrophoneAuthorization() async -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)

    switch status {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }
}
