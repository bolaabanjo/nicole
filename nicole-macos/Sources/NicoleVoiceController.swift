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
  private var progressiveTranscriptSink: ((String) -> Void)?
  private var finalTranscriptSink: ((String) -> Void)?
  private var lastSpokenAssistantMessageID: String?
  private var pendingReplyCompletion: (() -> Void)?
  private var forceSpeakNextReply = false
  private var seedText = ""
  private var activeListeningSurface: Surface?
  private var streamingSurface: Surface?

  override init() {
    super.init()
    speaker.onPlaybackStart = { [weak self] in
      guard let self, let surface = self.streamingSurface else { return }
      VoiceLatencyTracker.shared.markPlaybackStarted(on: surface)
    }
  }

  // VAD
  private var silenceTimer: Task<Void, Never>?
  private var hasDetectedSpeech = false
  private var speechFrameCount = 0
  private var peakEnergyDB: Float = -100.0
  private let silenceThresholdSeconds: Double = 0.42
  private let speechEnergyThreshold: Float = -35.0       // dB to count as speech (raised from -40 to filter clicks/taps)
  private let minSpeechFrames = 6                         // ~375ms of speech frames required before accepting
  private let directSpeechMinDB: Float = -28.0            // peak dB required — filters out quiet ambient noise

  // Barge-in (interrupt detection while Nicole is speaking)
  private var isMonitoringForInterrupt = false
  private var interruptSpeechFrames = 0
  private var interruptAudioBuffer = Data()
  private var interruptSink: ((Data) -> Void)?
  private let interruptEnergyThreshold: Float = -18.0    // much higher — only direct speech into the mic, not speaker bleed
  private let interruptMinFrames = 10                     // ~625ms sustained — must be clearly intentional

  // Overlapping transcription — transcribe while user is still speaking
  private var progressiveTranscribeTimer: Task<Void, Never>?
  private var latestProgressiveTranscript: String?
  private var progressiveAudioSnapshot = 0               // byte count at last progressive transcription
  private let progressiveIntervalSeconds: Double = 0.30   // faster live STT cadence for voice-first turns
  private let progressiveTailThreshold = 6400             // ~200ms of new audio — if less, trust the progressive transcript

  // MARK: - Barge-in (interrupt while speaking)

  /// Start monitoring the mic for speech while Nicole is talking.
  /// If the user speaks loudly enough for long enough, `onInterrupt` fires
  /// with the captured audio data so far (to include in transcription).
  func startInterruptMonitoring(onInterrupt: @escaping (Data) -> Void) {
    isMonitoringForInterrupt = true
    interruptSpeechFrames = 0
    interruptAudioBuffer = Data()
    interruptSink = onInterrupt

    do {
      try SharedAudioEngine.shared.ensureRunning()
      SharedAudioEngine.shared.setConsumer(self)
    } catch {
      isMonitoringForInterrupt = false
      interruptSink = nil
    }
  }

  func stopInterruptMonitoring() {
    guard isMonitoringForInterrupt else { return }
    isMonitoringForInterrupt = false
    interruptSpeechFrames = 0
    interruptAudioBuffer = Data()
    interruptSink = nil
    SharedAudioEngine.shared.setConsumer(nil)
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
      await startListening(
        on: surface,
        seedText: seedText,
        onTranscript: onTranscript,
        onProgressiveTranscript: nil
      )
    }
  }

  func stopListeningIfActive(on surface: Surface) {
    guard isListening(on: surface) else { return }
    stopListening()
  }

  func startAmbientCapture(
    onProgressiveTranscript: ((String) -> Void)? = nil,
    onFinalTranscript: @escaping (String) -> Void
  ) {
    Task {
      await startListening(
        on: .ambient,
        seedText: "",
        onTranscript: { _ in },
        onProgressiveTranscript: onProgressiveTranscript,
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
    beginStreamingTTS(on: .ambient, onAllComplete: onAllComplete)
  }

  func beginStreamingTTS(
    on surface: Surface,
    onAllComplete: @escaping () -> Void
  ) {
    speaker.stopSpeaking()
    forceSpeakNextReply = false
    pendingReplyCompletion = nil
    isStreamingTTS = true
    spokenContentLength = 0
    streamingSurface = surface

    speaker.beginStreamingSpeech { [weak self] in
      self?.streamingSurface = nil
      onAllComplete()
    }
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

  func handleSpeechBoundary(_ text: String) {
    guard isStreamingTTS else { return }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    spokenContentLength += trimmed.count
    if let surface = streamingSurface {
      VoiceLatencyTracker.shared.recordStreamEvent(
        NicoleStreamEventEnvelope(type: .speechBoundary, text: trimmed, metric: nil),
        on: surface
      )
    }
    speaker.enqueueSentence(trimmed)
  }

  func finishStreamingTTS(remainingContent: String) {
    guard isStreamingTTS else { return }
    isStreamingTTS = false

    // Send any remaining text that didn't end with sentence punctuation
    var unsent = String(remainingContent.dropFirst(spokenContentLength))
      .trimmingCharacters(in: .whitespacesAndNewlines)

    // Strip markdown artifacts that would produce silent/glitchy TTS
    unsent = unsent
      .replacingOccurrences(of: #"[*_~`#>\-\[\](){}|]"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    // Only send if there's actual speakable content (at least a few real characters)
    let hasSpeakableContent = unsent.count >= 3 && unsent.rangeOfCharacter(from: .letters) != nil
    speaker.finishStreamingSpeech(remainingText: hasSpeakableContent ? unsent : nil)
  }

  func cancelStreamingTTS() {
    isStreamingTTS = false
    spokenContentLength = 0
    streamingSurface = nil
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
      let isClauseEnd =
        chars[i] == "," || chars[i] == ";" || chars[i] == ":" || chars[i] == "\n"
      let nextIsSpaceOrEnd = (i + 1 >= chars.count) || chars[i + 1] == " " || chars[i + 1] == "\n"

      if isSentenceEnd && nextIsSpaceOrEnd && current.count >= 16 {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
          sentences.append(trimmed)
        }
        current = ""
      } else if isClauseEnd && nextIsSpaceOrEnd && current.count >= 28 {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
          sentences.append(trimmed)
        }
        current = ""
      } else if current.count >= 88 && chars[i] == " " {
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

    streamingSurface = nil
    lastSpokenAssistantMessageID = message.id
    speaker.speak(text: message.content, onCompletion: completion)
  }

  private func startListening(
    on surface: Surface,
    seedText: String,
    onTranscript: @escaping (String) -> Void,
    onProgressiveTranscript: ((String) -> Void)? = nil,
    onFinalTranscript: ((String) -> Void)? = nil
  ) async {
    speaker.stopSpeaking()
    stopListening(clearStatus: false)

    inputState = .requestingPermissions
    self.seedText = seedText

    let permissions = await NicoleSpeechPermissionManager.requestMicrophonePermission()
    guard permissions == .authorized else {
      inputState = .failed(messageForMicrophonePermissionState(permissions))
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
      progressiveTranscriptSink = onProgressiveTranscript
      finalTranscriptSink = onFinalTranscript
      inputState = .listening(surface)
      activeListeningSurface = surface

      try SharedAudioEngine.shared.ensureRunning()
      SharedAudioEngine.shared.setConsumer(self)
    } catch {
      stopListening(clearStatus: false)
      inputState = .failed("Nicole couldn't start listening: \(error.localizedDescription)")
    }
  }

  private func messageForMicrophonePermissionState(_ state: NicolePermissionState) -> String {
    switch state {
    case .authorized:
      return ""
    case .notDetermined:
      return "Microphone permission is still pending."
    case .denied, .restricted:
      return "Microphone access is blocked. Enable it for Nicole in Privacy & Security."
    case let .unavailable(message):
      return message
    }
  }

  func receiveAudio(data: Data, energyDB: Float) {
    // Barge-in mode: monitoring for interrupt while Nicole speaks
    if isMonitoringForInterrupt {
      interruptAudioBuffer.append(data)

      if energyDB > interruptEnergyThreshold {
        interruptSpeechFrames += 1
        print("[Barge-in] frame \(interruptSpeechFrames)/\(interruptMinFrames) energy=\(String(format: "%.1f", energyDB))dB")

        if interruptSpeechFrames >= interruptMinFrames {
          // User is definitely speaking over Nicole — fire interrupt
          print("[Barge-in] INTERRUPT TRIGGERED — \(interruptSpeechFrames) frames above \(interruptEnergyThreshold)dB")
          let capturedAudio = interruptAudioBuffer
          let sink = interruptSink
          stopInterruptMonitoring()
          sink?(capturedAudio)
        }
      } else {
        if interruptSpeechFrames > 0 {
          print("[Barge-in] reset at energy=\(String(format: "%.1f", energyDB))dB (threshold=\(interruptEnergyThreshold)dB)")
        }
        // Reset if silence — must be sustained speech, not a one-off noise
        interruptSpeechFrames = 0
      }
      return
    }

    // Normal voice capture mode
    audioBuffer.append(data)
    currentAudioLevel = energyDB

    let isSpeech = energyDB > speechEnergyThreshold

    if isSpeech {
      speechFrameCount += 1
      peakEnergyDB = max(peakEnergyDB, energyDB)

      // Only mark speech as detected after enough consecutive-ish frames
      // This filters out short transient sounds (clicks, taps, door squeaks)
      if speechFrameCount >= minSpeechFrames {
        if !hasDetectedSpeech, let surface = activeListeningSurface {
          VoiceLatencyTracker.shared.markSpeechDetected(on: surface)
        }
        hasDetectedSpeech = true
        startProgressiveTranscriptionIfNeeded()
      }

      silenceTimer?.cancel()
      silenceTimer = nil
    } else if hasDetectedSpeech, silenceTimer == nil {
      silenceTimer = Task { [weak self] in
        try? await Task.sleep(for: .seconds(self?.silenceThresholdSeconds ?? 0.42))
        guard !Task.isCancelled else { return }
        self?.finishAndTranscribe()
      }
    }
  }

  private func startProgressiveTranscriptionIfNeeded() {
    guard progressiveTranscribeTimer == nil else { return }

    progressiveTranscribeTimer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(self?.progressiveIntervalSeconds ?? 0.30))
        guard !Task.isCancelled else { break }
        await self?.runProgressiveTranscription()
      }
    }
  }

  private func stopProgressiveTranscription() {
    progressiveTranscribeTimer?.cancel()
    progressiveTranscribeTimer = nil
  }

  private func runProgressiveTranscription() async {
    // Snapshot the current audio buffer and transcribe it in the background
    let snapshot = audioBuffer
    guard snapshot.count > progressiveAudioSnapshot + 8000 else { return } // at least ~250ms of new audio

    progressiveAudioSnapshot = snapshot.count

    do {
      let result = try await WhisperTranscriber.shared.transcribe(audioData: snapshot)
      let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        let merged = mergeTranscript(seedText: seedText, transcript: text)
        latestProgressiveTranscript = merged
        progressiveTranscriptSink?(merged)
      }
    } catch {
      // Progressive transcription is best-effort — don't fail the whole flow
    }
  }

  private func finishAndTranscribe() {
    guard case .listening = inputState else { return }

    let capturedAudio = audioBuffer
    let capturedSeed = seedText
    let capturedPeakDB = peakEnergyDB
    let progressiveResult = latestProgressiveTranscript
    let newAudioSinceProgressive = capturedAudio.count - progressiveAudioSnapshot

    SharedAudioEngine.shared.setConsumer(nil)
    silenceTimer?.cancel()
    silenceTimer = nil
    stopProgressiveTranscription()

    // Not enough speech detected, or peak too quiet (ambient noise, not direct speech)
    guard !capturedAudio.isEmpty, hasDetectedSpeech, capturedPeakDB >= directSpeechMinDB else {
      latestProgressiveTranscript = nil
      progressiveAudioSnapshot = 0
      stopListening()
      return
    }

    inputState = .transcribing
    if let surface = activeListeningSurface {
      VoiceLatencyTracker.shared.markEndpointDetected(on: surface)
    }

    Task {
      do {
        let transcript: String

        // If we have a progressive result and very little new audio since,
        // use it immediately — saves a full Whisper round trip
        if let progressiveResult, !progressiveResult.isEmpty,
           newAudioSinceProgressive < progressiveTailThreshold {
          transcript = progressiveResult
        } else {
          // Full re-transcription of complete audio
          let result = try await WhisperTranscriber.shared.transcribe(audioData: capturedAudio)
          transcript = result.text
        }

        let merged = mergeTranscript(seedText: capturedSeed, transcript: transcript)

        latestProgressiveTranscript = nil
        progressiveAudioSnapshot = 0

        if merged.isEmpty {
          inputState = .idle
          return
        }

        if let surface = self.activeListeningSurface {
          VoiceLatencyTracker.shared.markFinalTranscriptReady(merged, on: surface)
        }
        transcriptSink?(merged)
        finalTranscriptSink?(merged)
        inputState = .idle
      } catch {
        latestProgressiveTranscript = nil
        progressiveAudioSnapshot = 0
        inputState = .failed("Transcription failed: \(error.localizedDescription)")
      }

      transcriptSink = nil
      progressiveTranscriptSink = nil
      finalTranscriptSink = nil
      audioBuffer = Data()
    }
  }

  private func stopListening(clearStatus: Bool = true) {
    silenceTimer?.cancel()
    silenceTimer = nil
    stopProgressiveTranscription()
    latestProgressiveTranscript = nil
    progressiveAudioSnapshot = 0

    SharedAudioEngine.shared.setConsumer(nil)
    transcriptSink = nil
    progressiveTranscriptSink = nil
    finalTranscriptSink = nil
    audioBuffer = Data()
    hasDetectedSpeech = false
    speechFrameCount = 0
    peakEnergyDB = -100.0
    activeListeningSurface = nil

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
