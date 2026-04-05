import AppKit
import AVFoundation

@MainActor
final class NicoleVoiceController: NSObject, ObservableObject, AudioConsumer {
  enum Surface: Equatable {
    case expanded
    case compact
    case ambient
  }

  enum InputState: Equatable {
    case idle
    case requestingPermissions
    case listening(Surface)
    case transcribing
    case failed(String)
  }

  @Published private(set) var inputState: InputState = .idle
  @Published private(set) var currentAudioLevel: Float = -60.0

  var inlineStatusText: String? {
    switch inputState {
    case .idle:
      return nil
    case .requestingPermissions:
      return "Requesting microphone access…"
    case .listening:
      return "Listening…"
    case .transcribing:
      return "Transcribing…"
    case let .failed(message):
      return message
    }
  }

  private let speaker = KokoroSpeaker.shared

  private var audioBuffer = Data()
  private var transcriptSink: ((String) -> Void)?
  private var finalTranscriptSink: ((String) -> Void)?
  private var lastSpokenAssistantMessageID: String?
  private var pendingReplyCompletion: (() -> Void)?
  private var forceSpeakNextReply = false
  private var seedText = ""

  // VAD
  private var silenceTimer: Task<Void, Never>?
  private var hasDetectedSpeech = false
  private let silenceThresholdSeconds: Double = 1.6
  private let speechEnergyThreshold: Float = -40.0

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
    speaker.stopSpeaking()
    forceSpeakNextReply = true
    pendingReplyCompletion = onCompletion
  }

  func completePreparedReplyWithoutSpeech() {
    forceSpeakNextReply = false
    isStreamingTTS = false
    let completion = pendingReplyCompletion
    pendingReplyCompletion = nil
    completion?()
  }

  func stopSpeaking() {
    speaker.stopSpeaking()
  }

  // MARK: - Streaming TTS

  private(set) var isStreamingTTS = false
  private var spokenContentLength = 0

  func beginStreamingTTS(onAllComplete: @escaping () -> Void) {
    speaker.stopSpeaking()
    forceSpeakNextReply = false
    pendingReplyCompletion = nil
    isStreamingTTS = true
    spokenContentLength = 0

    speaker.beginStreamingSpeech(onAllComplete: onAllComplete)
  }

  func handleStreamingContent(_ visibleContent: String) {
    guard isStreamingTTS else { return }

    let newContent = String(visibleContent.dropFirst(spokenContentLength))
    guard !newContent.isEmpty else { return }

    // Extract complete sentences from the new content
    let (sentences, _) = extractSentences(from: newContent)

    for sentence in sentences {
      spokenContentLength += sentence.count
      speaker.enqueueSentence(sentence)
    }
  }

  func finishStreamingTTS(remainingContent: String) {
    guard isStreamingTTS else { return }
    isStreamingTTS = false

    // Send any remaining text that didn't end with sentence punctuation
    let unsent = String(remainingContent.dropFirst(spokenContentLength))
      .trimmingCharacters(in: .whitespacesAndNewlines)

    speaker.finishStreamingSpeech(remainingText: unsent.isEmpty ? nil : unsent)
  }

  func cancelStreamingTTS() {
    isStreamingTTS = false
    spokenContentLength = 0
    speaker.stopSpeaking()
  }

  private func extractSentences(from text: String) -> (sentences: [String], remainder: String) {
    var sentences: [String] = []
    var current = ""
    let chars = Array(text)
    var i = 0

    while i < chars.count {
      current.append(chars[i])

      let isSentenceEnd = chars[i] == "." || chars[i] == "!" || chars[i] == "?"
      let nextIsSpaceOrEnd = (i + 1 >= chars.count) || chars[i + 1] == " " || chars[i + 1] == "\n"

      // Split on sentence-ending punctuation followed by space/end, with minimum length
      // to avoid splitting on "Dr." or "3.14"
      if isSentenceEnd && nextIsSpaceOrEnd && current.count >= 20 {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
          sentences.append(trimmed)
        }
        current = ""
      }

      i += 1
    }

    // Also split on newlines as sentence boundaries
    if !current.isEmpty && current.contains("\n") {
      let lines = current.components(separatedBy: "\n")
      for (index, line) in lines.enumerated() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty && index < lines.count - 1 {
          sentences.append(trimmed)
          current = lines[(index + 1)...].joined(separator: "\n")
          break
        }
      }
    }

    return (sentences, current)
  }

  // MARK: - Non-streaming speech

  func handleCompletedAssistantMessage(_ message: NicoleMessage) {
    guard
      message.role == .assistant,
      !message.content.isEmpty,
      lastSpokenAssistantMessageID != message.id
    else {
      return
    }

    // Skip if streaming TTS already handled this message
    guard !isStreamingTTS else { return }

    let voiceRepliesEnabled = (NSApp.delegate as? AppDelegate)?.settings?.voiceRepliesEnabled ?? false
    let shouldSpeak = voiceRepliesEnabled || forceSpeakNextReply
    let completion = pendingReplyCompletion
    pendingReplyCompletion = nil
    forceSpeakNextReply = false

    guard shouldSpeak else {
      completion?()
      return
    }

    lastSpokenAssistantMessageID = message.id
    speaker.speak(text: message.content, onCompletion: completion)
  }

  private func startListening(
    on surface: Surface,
    seedText: String,
    onTranscript: @escaping (String) -> Void,
    onFinalTranscript: ((String) -> Void)? = nil
  ) async {
    speaker.stopSpeaking()
    stopListening(clearStatus: false)

    inputState = .requestingPermissions
    self.seedText = seedText

    let permissions = await NicoleSpeechPermissionManager.requestMicrophonePermission()
    guard permissions else {
      inputState = .failed("Microphone access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    let whisperReady = await WhisperTranscriber.shared.isAvailable()
    guard whisperReady else {
      inputState = .failed("Whisper server isn't running. Start it with: ./start-whisper.sh")
      return
    }

    do {
      audioBuffer = Data()
      hasDetectedSpeech = false
      transcriptSink = onTranscript
      finalTranscriptSink = onFinalTranscript
      inputState = .listening(surface)

      try SharedAudioEngine.shared.ensureRunning()
      SharedAudioEngine.shared.setConsumer(self)
    } catch {
      stopListening(clearStatus: false)
      inputState = .failed("Nicole couldn't start listening: \(error.localizedDescription)")
    }
  }

  func receiveAudio(data: Data, energyDB: Float) {
    audioBuffer.append(data)
    currentAudioLevel = energyDB

    let isSpeech = energyDB > speechEnergyThreshold

    if isSpeech {
      hasDetectedSpeech = true
      silenceTimer?.cancel()
      silenceTimer = nil
    } else if hasDetectedSpeech, silenceTimer == nil {
      silenceTimer = Task { [weak self] in
        try? await Task.sleep(for: .seconds(self?.silenceThresholdSeconds ?? 1.6))
        guard !Task.isCancelled else { return }
        self?.finishAndTranscribe()
      }
    }
  }

  private func finishAndTranscribe() {
    guard case .listening = inputState else { return }

    let capturedAudio = audioBuffer
    let capturedSeed = seedText

    SharedAudioEngine.shared.setConsumer(nil)
    silenceTimer?.cancel()
    silenceTimer = nil

    guard !capturedAudio.isEmpty, hasDetectedSpeech else {
      stopListening()
      return
    }

    inputState = .transcribing

    Task {
      do {
        let result = try await WhisperTranscriber.shared.transcribe(audioData: capturedAudio)

        let transcript = mergeTranscript(seedText: capturedSeed, transcript: result.text)

        if transcript.isEmpty {
          inputState = .idle
          return
        }

        transcriptSink?(transcript)
        finalTranscriptSink?(transcript)
        inputState = .idle
      } catch {
        inputState = .failed("Transcription failed: \(error.localizedDescription)")
      }

      transcriptSink = nil
      finalTranscriptSink = nil
      audioBuffer = Data()
    }
  }

  private func stopListening(clearStatus: Bool = true) {
    silenceTimer?.cancel()
    silenceTimer = nil

    SharedAudioEngine.shared.setConsumer(nil)
    transcriptSink = nil
    finalTranscriptSink = nil
    audioBuffer = Data()
    hasDetectedSpeech = false

    if clearStatus {
      inputState = .idle
    }
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
}
