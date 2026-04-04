import AVFoundation
import Speech

@MainActor
final class NicoleWakeWordController: NSObject, ObservableObject {
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

  private let audioEngine = AVAudioEngine()
  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) ?? SFSpeechRecognizer()

  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var shouldRemainListening = false
  private var wakeSink: ((Detection) -> Void)?
  private var lastTriggeredAt: Date?

  func start(onWakeWord: @escaping (Detection) -> Void) {
    stop()
    wakeSink = onWakeWord
    shouldRemainListening = true

    Task {
      await beginWakeListening()
    }
  }

  func stop() {
    shouldRemainListening = false
    teardown(clearState: true)
  }

  private func beginWakeListening() async {
    guard shouldRemainListening else { return }
    guard let speechRecognizer else {
      state = .failed("Speech recognition isn’t available on this Mac.")
      return
    }

    teardown(clearState: false)
    state = .requestingPermissions

    let permissions = await NicoleSpeechPermissionManager.requestPermissions()
    guard permissions.microphoneGranted else {
      state = .failed("Microphone access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    guard permissions.speechGranted else {
      state = .failed("Speech recognition access is blocked. Enable it for Nicole or Xcode in Privacy & Security.")
      return
    }

    if permissions.promptedDuringRequest {
      state = .requestingPermissions
      try? await Task.sleep(for: .milliseconds(900))
    }

    do {
      let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
      recognitionRequest.shouldReportPartialResults = true
      if speechRecognizer.supportsOnDeviceRecognition {
        recognitionRequest.requiresOnDeviceRecognition = true
      }

      self.recognitionRequest = recognitionRequest
      self.state = .listening

      let inputNode = audioEngine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.removeTap(onBus: 0)
      nonisolated(unsafe) let tapRequest = recognitionRequest
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in
        tapRequest.append(buffer)
      }

      audioEngine.prepare()
      try audioEngine.start()

      recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { @Sendable [weak self] result, error in
        if let result {
          let normalizedTranscript = Self.normalize(result.bestTranscription.formattedString)
          let isFinal = result.isFinal

          Task { @MainActor [weak self] in
            guard let self else { return }

            if let wakeDetection = self.detectWakeWord(in: normalizedTranscript, isFinal: isFinal) {
              self.lastTriggeredAt = Date()
              self.shouldRemainListening = false
              self.teardown(clearState: true)
              self.wakeSink?(wakeDetection)
              return
            }

            if isFinal, self.shouldRemainListening {
              await self.restartAfterDelay()
            }
          }
          return
        }

        if let error {
          let message = error.localizedDescription
          Task { @MainActor [weak self] in
            guard let self else { return }
            if self.shouldRemainListening {
              self.state = .failed("Wake word: \(message)")
              await self.restartAfterDelay()
            } else {
              self.teardown(clearState: true)
            }
          }
        }
      }
    } catch {
      teardown(clearState: false)
      state = .failed("Nicole couldn’t start wake word listening: \(error.localizedDescription)")
    }
  }

  private func restartAfterDelay() async {
    guard shouldRemainListening else { return }
    try? await Task.sleep(for: .milliseconds(450))
    await restartRecognitionOnly()
  }

  /// Restart just the speech recognition task while keeping the audio engine
  /// (and therefore the microphone) running. This prevents the orange mic
  /// indicator from blinking on every recognition cycle.
  private func restartRecognitionOnly() async {
    guard shouldRemainListening else { return }
    guard let speechRecognizer else { return }

    // Tear down only the recognition side, keep audio engine alive
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest?.endAudio()
    recognitionRequest = nil

    // Ensure the audio engine is still running (it should be)
    guard audioEngine.isRunning else {
      // If the engine died for some reason, do a full restart
      await beginWakeListening()
      return
    }

    do {
      let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
      recognitionRequest.shouldReportPartialResults = true
      if speechRecognizer.supportsOnDeviceRecognition {
        recognitionRequest.requiresOnDeviceRecognition = true
      }

      self.recognitionRequest = recognitionRequest
      self.state = .listening

      // Re-install the tap so the new request receives audio buffers
      let inputNode = audioEngine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.removeTap(onBus: 0)
      nonisolated(unsafe) let tapRequest = recognitionRequest
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in
        tapRequest.append(buffer)
      }

      recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { @Sendable [weak self] result, error in
        if let result {
          let normalizedTranscript = Self.normalize(result.bestTranscription.formattedString)
          let isFinal = result.isFinal

          Task { @MainActor [weak self] in
            guard let self else { return }

            if let wakeDetection = self.detectWakeWord(in: normalizedTranscript, isFinal: isFinal) {
              self.lastTriggeredAt = Date()
              self.shouldRemainListening = false
              self.teardown(clearState: true)
              self.wakeSink?(wakeDetection)
              return
            }

            if isFinal, self.shouldRemainListening {
              await self.restartAfterDelay()
            }
          }
          return
        }

        if let error {
          let message = error.localizedDescription
          Task { @MainActor [weak self] in
            guard let self else { return }
            if self.shouldRemainListening {
              self.state = .failed("Wake word: \(message)")
              await self.restartAfterDelay()
            } else {
              self.state = .idle
            }
          }
        }
      }
    } catch {
      // If re-creating the recognition task fails, try a full restart
      await beginWakeListening()
    }
  }

  private func teardown(clearState: Bool) {
    recognitionTask?.cancel()
    recognitionTask = nil

    recognitionRequest?.endAudio()
    recognitionRequest = nil

    if audioEngine.isRunning {
      audioEngine.stop()
    }

    audioEngine.inputNode.removeTap(onBus: 0)

    if clearState {
      state = .idle
    }
  }

  private func detectWakeWord(in transcript: String, isFinal: Bool) -> Detection? {
    guard !transcript.isEmpty else { return nil }

    if let lastTriggeredAt, Date().timeIntervalSince(lastTriggeredAt) < 1.8 {
      return nil
    }

    let prefixes = ["hey nicole", "nicole"]

    for prefix in prefixes {
      guard transcript == prefix || transcript.hasPrefix(prefix + " ") else { continue }

      let remainder = transcript
        .dropFirst(prefix.count)
        .trimmingCharacters(in: .whitespacesAndNewlines)

      if remainder.isEmpty {
        return transcript == prefix ? .wakeOnly : nil
      }

      if isFinal {
        return .command(String(remainder))
      }
    }

    return nil
  }

  private static func normalize(_ text: String) -> String {
    text
      .lowercased()
      .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
