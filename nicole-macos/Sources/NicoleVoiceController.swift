import AppKit
import AVFoundation
import Speech

@MainActor
final class NicoleVoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
  enum Surface: Equatable {
    case expanded
    case compact
    case ambient
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
  private var finalTranscriptSink: ((String) -> Void)?
  private var lastSpokenAssistantMessageID: String?
  private var pendingReplyCompletion: (() -> Void)?
  private var forceSpeakNextReply = false

  override init() {
    super.init()
    synthesizer.delegate = self
  }

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

  func startAmbientCapture(onFinalTranscript: @escaping (String) -> Void) {
    Task {
      await startListening(
        on: .ambient,
        seedText: "",
        onTranscript: { _ in },
        onFinalTranscript: onFinalTranscript
      )
    }
  }

  func prepareForAmbientReply(onCompletion: @escaping () -> Void) {
    synthesizer.stopSpeaking(at: .immediate)
    forceSpeakNextReply = true
    pendingReplyCompletion = onCompletion
  }

  func completePreparedReplyWithoutSpeech() {
    forceSpeakNextReply = false
    let completion = pendingReplyCompletion
    pendingReplyCompletion = nil
    completion?()
  }

  func stopSpeaking() {
    synthesizer.stopSpeaking(at: .immediate)
  }

  func handleCompletedAssistantMessage(_ message: NicoleMessage) {
    guard
      let appDelegate = NSApp.delegate as? AppDelegate,
      let settings = appDelegate.settings,
      message.role == .assistant,
      !message.content.isEmpty,
      lastSpokenAssistantMessageID != message.id
    else {
      return
    }

    let shouldSpeak = settings.voiceRepliesEnabled || forceSpeakNextReply
    let completion = pendingReplyCompletion
    pendingReplyCompletion = nil
    forceSpeakNextReply = false

    guard shouldSpeak else {
      completion?()
      return
    }

    lastSpokenAssistantMessageID = message.id
    speak(text: message.content, onCompletion: completion)
  }

  private func startListening(
    on surface: Surface,
    seedText: String,
    onTranscript: @escaping (String) -> Void,
    onFinalTranscript: ((String) -> Void)? = nil
  ) async {
    guard let speechRecognizer else {
      inputState = .failed("Speech recognition isn’t available on this Mac.")
      return
    }

    synthesizer.stopSpeaking(at: .immediate)
    stopListening(clearStatus: false)
    inputState = .requestingPermissions

    let permissions = await NicoleSpeechPermissionManager.requestPermissions()
    guard permissions.microphoneGranted else {
      inputState = .failed("Microphone access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    guard permissions.speechGranted else {
      inputState = .failed("Speech recognition access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    if permissions.promptedDuringRequest {
      inputState = .requestingPermissions
      try? await Task.sleep(for: .milliseconds(900))
    }

    do {
      let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
      recognitionRequest.shouldReportPartialResults = true
      if speechRecognizer.supportsOnDeviceRecognition {
        recognitionRequest.requiresOnDeviceRecognition = true
      }

      self.recognitionRequest = recognitionRequest
      self.transcriptSink = onTranscript
      self.finalTranscriptSink = onFinalTranscript
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
              self.finalTranscriptSink?(transcript)
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
    finalTranscriptSink = nil

    if clearStatus {
      inputState = .idle
    }
  }

  private func speak(text: String, onCompletion: (() -> Void)? = nil) {
    pendingReplyCompletion = onCompletion
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

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in
      let completion = self.pendingReplyCompletion
      self.pendingReplyCompletion = nil
      completion?()
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in
      let completion = self.pendingReplyCompletion
      self.pendingReplyCompletion = nil
      completion?()
    }
  }
}
