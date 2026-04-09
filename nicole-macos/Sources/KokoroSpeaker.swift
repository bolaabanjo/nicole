import AVFoundation
import Foundation

/// Speaks text using the local Kokoro TTS server, falling back to
/// AVSpeechSynthesizer if the server isn't available.
@MainActor
final class KokoroSpeaker: NSObject, ObservableObject, AVAudioPlayerDelegate {
  static let shared = KokoroSpeaker()

  private let serverBaseURL = URL(string: "http://127.0.0.1:8201")!
  private let session: URLSession
  private let fallbackSynthesizer = AVSpeechSynthesizer()

  private var audioPlayer: AVAudioPlayer?
  private var pendingCompletion: (() -> Void)?
  private var isFallbackMode = false
  private var meteringTimer: Timer?
  @Published private(set) var currentOutputLevel: Float = -60.0
  var onPlaybackStart: (() -> Void)?

  override init() {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    self.session = URLSession(configuration: config)
    super.init()
    fallbackSynthesizer.delegate = self
  }

  // Streaming queue
  private var sentenceQueue: [String] = []
  private var prefetchedAudio: [Data] = []
  private var isSynthesizing = false
  private var isStreamingMode = false
  private var streamFinished = false
  private var streamingCompletion: (() -> Void)?
  private var targetPrefetchCount = 1
  private var queueUnderflowCount = 0

  var isSpeaking: Bool {
    audioPlayer?.isPlaying == true || fallbackSynthesizer.isSpeaking
  }

  // MARK: - Single-shot speech (non-streaming)

  func speak(text: String, onCompletion: (() -> Void)? = nil) {
    // Stop any current playback without firing the old completion
    audioPlayer?.stop()
    audioPlayer = nil
    fallbackSynthesizer.stopSpeaking(at: .immediate)
    isFallbackMode = false
    pendingCompletion = onCompletion


    Task {
      let wavData = await synthesize(text: text)

      if let wavData {
        do {
          let player = try AVAudioPlayer(data: wavData)
          player.delegate = self
          player.isMeteringEnabled = true
          player.prepareToPlay()
          self.audioPlayer = player
          self.startMetering()
          _ = player.play()
          self.onPlaybackStart?()
        } catch {
          firePendingCompletion()
        }
      } else {
        isFallbackMode = true
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = 0.48
        utterance.pitchMultiplier = 1.02
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")
        fallbackSynthesizer.speak(utterance)
      }
    }
  }

  func stopSpeaking() {
    stopMetering()
    stopStreamingState()
    audioPlayer?.stop()
    audioPlayer = nil
    fallbackSynthesizer.stopSpeaking(at: .immediate)
    isFallbackMode = false
    firePendingCompletion()
  }

  // MARK: - Streaming speech (sentence-by-sentence)

  func beginStreamingSpeech(onAllComplete: (() -> Void)?) {
    stopMetering()
    audioPlayer?.stop()
    audioPlayer = nil
    fallbackSynthesizer.stopSpeaking(at: .immediate)
    isFallbackMode = false
    pendingCompletion = nil

    sentenceQueue = []
    prefetchedAudio = []
    isSynthesizing = false
    isStreamingMode = true
    streamFinished = false
    streamingCompletion = onAllComplete
    targetPrefetchCount = 1
    queueUnderflowCount = 0
  }

  func enqueueSentence(_ text: String) {
    guard isStreamingMode else { return }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    sentenceQueue.append(trimmed)
    processStreamingQueue()
  }

  func finishStreamingSpeech(remainingText: String? = nil) {
    guard isStreamingMode else { return }

    if let remaining = remainingText?.trimmingCharacters(in: .whitespacesAndNewlines),
       !remaining.isEmpty {
      sentenceQueue.append(remaining)
    }

    streamFinished = true
    processStreamingQueue()
  }

  private func processStreamingQueue() {
    guard isStreamingMode else { return }

    if !streamFinished, !isSpeaking, prefetchedAudio.isEmpty, sentenceQueue.isEmpty == false {
      queueUnderflowCount += 1
      targetPrefetchCount = min(3, max(1, queueUnderflowCount + 1))
    }

    // Keep a small adaptive buffer ahead so Nicole doesn't stall between clauses.
    if !isSynthesizing, prefetchedAudio.count < targetPrefetchCount, !sentenceQueue.isEmpty {
      synthesizeNextSentence()
    }

    // Start playing if idle and there's audio ready
    if !isSpeaking, !prefetchedAudio.isEmpty {
      playNextFromQueue()
    }

    // Check if we're completely done
    if streamFinished, sentenceQueue.isEmpty, prefetchedAudio.isEmpty, !isSpeaking, !isSynthesizing {
      completeStreaming()
    }
  }

  private func synthesizeNextSentence() {
    guard !sentenceQueue.isEmpty else { return }
    isSynthesizing = true
    let sentence = sentenceQueue.removeFirst()

    Task {
      let wavData = await synthesize(text: sentence)
      self.isSynthesizing = false

      if let wavData {
        self.prefetchedAudio.append(wavData)
      }

      self.processStreamingQueue()
    }
  }

  private func playNextFromQueue() {
    guard !prefetchedAudio.isEmpty else { return }
    let wavData = prefetchedAudio.removeFirst()

    // Skip near-empty WAVs (just headers, no real audio) — prevents ghost playback
    // WAV header is 44 bytes; anything under ~500 bytes is < 5ms of audio
    guard wavData.count > 500 else {
      processStreamingQueue()
      return
    }

    do {
      let player = try AVAudioPlayer(data: wavData)
      player.delegate = self
      player.isMeteringEnabled = true
      player.prepareToPlay()
      self.audioPlayer = player
      self.startMetering()
      player.play()
      onPlaybackStart?()
    } catch {
      processStreamingQueue()
    }
  }

  private func completeStreaming() {
    let completion = streamingCompletion
    stopStreamingState()
    completion?()
  }

  private func stopStreamingState() {
    isStreamingMode = false
    streamFinished = false
    sentenceQueue = []
    prefetchedAudio = []
    isSynthesizing = false
    streamingCompletion = nil
    targetPrefetchCount = 1
    queueUnderflowCount = 0
  }

  func isAvailable() async -> Bool {
    let url = serverBaseURL.appendingPathComponent("health")
    var request = URLRequest(url: url)
    request.timeoutInterval = 2

    do {
      let (_, response) = try await session.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }

  private func synthesize(text: String) async -> Data? {
    let url = serverBaseURL.appendingPathComponent("tts")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body: [String: Any] = [
      "text": text,
      "voice": "af_sky",
      "speed": 1.2,
    ]

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (data, response) = try await session.data(for: request)

      guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
        return nil
      }

      return data
    } catch {
      return nil
    }
  }

  private func startMetering() {
    stopMetering()
    meteringTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, let player = self.audioPlayer, player.isPlaying else { return }
        player.updateMeters()
        self.currentOutputLevel = player.averagePower(forChannel: 0)
      }
    }
  }

  private func stopMetering() {
    meteringTimer?.invalidate()
    meteringTimer = nil
    currentOutputLevel = -60.0
  }

  private func firePendingCompletion() {
    let completion = pendingCompletion
    pendingCompletion = nil
    completion?()
  }

  // MARK: - AVAudioPlayerDelegate

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      self.stopMetering()
      self.audioPlayer = nil

      if self.isStreamingMode {
        self.processStreamingQueue()
      } else {
        self.firePendingCompletion()
      }
    }
  }
}

// MARK: - AVSpeechSynthesizerDelegate (fallback)

extension KokoroSpeaker: AVSpeechSynthesizerDelegate {
  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in
      self.isFallbackMode = false
      self.firePendingCompletion()
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in
      self.isFallbackMode = false
      self.firePendingCompletion()
    }
  }
}
