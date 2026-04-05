import AVFoundation

@MainActor
final class NicoleWakeWordController: NSObject, ObservableObject, AudioConsumer {
  enum Detection {
    case wakeOnly
    case command(String)
  }

  enum State: Equatable {
    case idle
    case requestingPermissions
    case listening
    case failed(String)
  }

  @Published private(set) var state: State = .idle

  private var shouldRemainListening = false
  private var wakeSink: ((Detection) -> Void)?
  private var lastTriggeredAt: Date?

  // VAD state
  private var speechBuffer = Data()
  private var isSpeechActive = false
  private var silenceFrameCount = 0
  private var peakEnergyDB: Float = -100.0

  // VAD tuning — speech detection
  private let speechEnergyThreshold: Float = -42.0   // dB to start capturing any speech
  private let silenceFramesRequired = 20              // ~1.3s silence to finalize a segment

  // Anti-false-trigger tuning
  private let directSpeechMinDB: Float = -30.0        // peak dB required — filters out quiet speaker audio
  private let minSpeechBytes = 9600                   // 300ms minimum (16kHz * 2 * 0.3s) — filters transient noise
  private let maxSpeechBytes = 320_000                // 10s max capture

  func start(onWakeWord: @escaping (Detection) -> Void) {
    stop()
    wakeSink = onWakeWord
    shouldRemainListening = true

    Task {
      await beginListening()
    }
  }

  func stop() {
    shouldRemainListening = false
    speechBuffer = Data()
    isSpeechActive = false
    silenceFrameCount = 0
    peakEnergyDB = -100.0

    SharedAudioEngine.shared.setConsumer(nil)
    state = .idle
  }

  private func beginListening() async {
    guard shouldRemainListening else { return }

    state = .requestingPermissions

    let micGranted = await NicoleSpeechPermissionManager.requestMicrophonePermission()
    guard micGranted else {
      state = .failed("Microphone access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    let whisperReady = await WhisperTranscriber.shared.isAvailable()
    guard whisperReady else {
      state = .failed("Whisper server isn't running. Start it with: ./start-whisper.sh")
      return
    }

    do {
      speechBuffer = Data()
      isSpeechActive = false
      silenceFrameCount = 0
      peakEnergyDB = -100.0

      try SharedAudioEngine.shared.ensureRunning()
      SharedAudioEngine.shared.setConsumer(self)
      state = .listening
    } catch {
      state = .failed("Nicole couldn't start wake word listening: \(error.localizedDescription)")
    }
  }

  func receiveAudio(data: Data, energyDB: Float) {
    guard shouldRemainListening else { return }

    let isSpeech = energyDB > speechEnergyThreshold

    if isSpeech {
      if !isSpeechActive {
        isSpeechActive = true
        speechBuffer = Data()
        peakEnergyDB = -100.0
      }
      silenceFrameCount = 0
      speechBuffer.append(data)
      peakEnergyDB = max(peakEnergyDB, energyDB)

      if speechBuffer.count > maxSpeechBytes {
        transcribeAndCheck()
      }
    } else if isSpeechActive {
      speechBuffer.append(data)
      silenceFrameCount += 1

      if silenceFrameCount >= silenceFramesRequired {
        transcribeAndCheck()
      }
    }
  }

  private func transcribeAndCheck() {
    let capturedAudio = speechBuffer
    let capturedPeakDB = peakEnergyDB

    speechBuffer = Data()
    isSpeechActive = false
    silenceFrameCount = 0
    peakEnergyDB = -100.0

    // Too short — likely a cough, click, or transient noise
    guard capturedAudio.count >= minSpeechBytes else { return }

    // Too quiet — likely speaker audio from a call, not direct speech into the mic
    guard capturedPeakDB >= directSpeechMinDB else { return }

    // Debounce
    if let lastTriggeredAt, Date().timeIntervalSince(lastTriggeredAt) < 2.0 {
      return
    }

    Task {
      do {
        let result = try await WhisperTranscriber.shared.transcribe(audioData: capturedAudio)
        let normalized = Self.normalize(result.text)

        guard !normalized.isEmpty else { return }

        if let detection = detectWakeWord(in: normalized) {
          lastTriggeredAt = Date()
          shouldRemainListening = false
          SharedAudioEngine.shared.setConsumer(nil)
          state = .idle
          wakeSink?(detection)
        }
      } catch {
        print("Wake word transcription failed: \(error.localizedDescription)")
      }
    }
  }

  private func detectWakeWord(in transcript: String) -> Detection? {
    // Only accept "hey nicole" for always-on wake word detection.
    // Just "nicole" alone is too common in ambient conversation.
    let prefix = "hey nicole"

    guard transcript == prefix || transcript.hasPrefix(prefix + " ") else {
      return nil
    }

    let remainder = transcript
      .dropFirst(prefix.count)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if remainder.isEmpty {
      return .wakeOnly
    }

    return .command(String(remainder))
  }

  private static func normalize(_ text: String) -> String {
    text
      .lowercased()
      .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
