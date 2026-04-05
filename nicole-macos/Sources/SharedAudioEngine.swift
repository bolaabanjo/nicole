import AVFoundation

/// A single shared audio engine that both the wake word controller and voice
/// controller use. This prevents mic handoff issues (and orange dot blinking)
/// that occur when two separate AVAudioEngine instances fight over the mic.
@MainActor
final class SharedAudioEngine {
  static let shared = SharedAudioEngine()

  let engine = AVAudioEngine()

  /// 16kHz mono Int16 — what Whisper expects
  let whisperFormat: AVAudioFormat? = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16000,
    channels: 1,
    interleaved: true
  )

  private var converter: AVAudioConverter?
  private var activeConsumer: AudioConsumer?
  private var isRunning = false

  private init() {}

  /// Start the audio engine if it isn't already running.
  /// Returns false if the engine couldn't be started.
  func ensureRunning() throws {
    guard !isRunning else { return }

    let inputNode = engine.inputNode
    let nativeFormat = inputNode.outputFormat(forBus: 0)

    guard let whisperFormat else {
      throw AudioEngineError.formatCreationFailed
    }

    guard let newConverter = AVAudioConverter(from: nativeFormat, to: whisperFormat) else {
      throw AudioEngineError.converterCreationFailed
    }
    converter = newConverter

    inputNode.removeTap(onBus: 0)

    nonisolated(unsafe) let unsafeConverter = newConverter
    nonisolated(unsafe) let unsafeFormat = whisperFormat
    nonisolated(unsafe) var conversionError: NSError?

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: nativeFormat) { @Sendable [weak self] buffer, _ in
      let frameCapacity = AVAudioFrameCount(
        Double(buffer.frameLength) * 16000.0 / buffer.format.sampleRate
      )
      guard frameCapacity > 0 else { return }

      guard let convertedBuffer = AVAudioPCMBuffer(
        pcmFormat: unsafeFormat,
        frameCapacity: frameCapacity
      ) else { return }

      let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        outStatus.pointee = .haveData
        return buffer
      }

      conversionError = nil
      unsafeConverter.convert(to: convertedBuffer, error: &conversionError, withInputFrom: inputBlock)

      guard conversionError == nil, convertedBuffer.frameLength > 0 else { return }

      let channelData = convertedBuffer.int16ChannelData!
      let frameLength = Int(convertedBuffer.frameLength)

      // Calculate energy for VAD
      var sumSquares: Float = 0
      for i in 0..<frameLength {
        let sample = Float(channelData[0][i]) / Float(Int16.max)
        sumSquares += sample * sample
      }
      let rms = sqrtf(sumSquares / Float(frameLength))
      let dB = 20 * log10f(max(rms, 1e-10))

      let byteCount = frameLength * 2
      let data = Data(bytes: channelData[0], count: byteCount)

      Task { @MainActor [weak self] in
        self?.activeConsumer?.receiveAudio(data: data, energyDB: dB)
      }
    }

    engine.prepare()
    try engine.start()
    isRunning = true
  }

  /// Stop the audio engine completely. Only call when no one needs the mic.
  func stop() {
    activeConsumer = nil

    if engine.isRunning {
      engine.stop()
    }
    engine.inputNode.removeTap(onBus: 0)
    converter = nil
    isRunning = false
  }

  /// Set which consumer receives audio chunks. Only one consumer at a time.
  /// Pass nil to pause delivery without stopping the engine.
  func setConsumer(_ consumer: AudioConsumer?) {
    activeConsumer = consumer
  }
}

protocol AudioConsumer: AnyObject, Sendable {
  @MainActor func receiveAudio(data: Data, energyDB: Float)
}

enum AudioEngineError: LocalizedError {
  case formatCreationFailed
  case converterCreationFailed

  var errorDescription: String? {
    switch self {
    case .formatCreationFailed:
      return "Failed to create 16kHz audio format."
    case .converterCreationFailed:
      return "Failed to create audio format converter."
    }
  }
}
