import Foundation

@MainActor
final class VoiceLatencyTracker: ObservableObject {
  static let shared = VoiceLatencyTracker()

  private struct SurfaceState {
    var localTurnID = UUID().uuidString
    var transcriptPreview: String?
    var captureStartedAt: TimeInterval?
    var firstSpeechDetectedAt: TimeInterval?
    var endpointDetectedAt: TimeInterval?
    var finalTranscriptReadyAt: TimeInterval?
    var firstPrepareRequestedAt: TimeInterval?
    var firstPrepareCompletedAt: TimeInterval?
    var finalPrepareRequestedAt: TimeInterval?
    var finalPrepareCompletedAt: TimeInterval?
    var replyRequestStartedAt: TimeInterval?
    var firstStatusAt: TimeInterval?
    var firstActivityAt: TimeInterval?
    var firstTextAt: TimeInterval?
    var firstSpeechBoundaryAt: TimeInterval?
    var firstPlaybackStartedAt: TimeInterval?
    var completedAt: TimeInterval?
    var voiceTurnId: String?
    var prepareLatency: NicoleVoicePrepareLatency?
    var serverMetrics: [NicoleLatencyMetric] = []
    var interruptionCount = 0
  }

  private struct LoggedSummary: Codable {
    let timestamp: String
    let surface: String
    let localTurnID: String
    let voiceTurnId: String?
    let transcriptPreview: String?
    let interruptionCount: Int
    let captureToSpeechMs: Double?
    let speechToEndpointMs: Double?
    let endpointToTranscriptMs: Double?
    let firstPrepareRoundTripMs: Double?
    let finalPrepareRoundTripMs: Double?
    let finalTranscriptToReplyRequestMs: Double?
    let replyToFirstStatusMs: Double?
    let replyToFirstActivityMs: Double?
    let replyToFirstTextMs: Double?
    let replyToFirstSpeechBoundaryMs: Double?
    let replyToFirstPlaybackMs: Double?
    let totalTurnMs: Double?
    let prepareServerLatency: NicoleVoicePrepareLatency?
    let serverMetrics: [NicoleLatencyMetric]
  }

  private var states: [NicoleVoiceController.Surface: SurfaceState] = [:]
  private let formatter = ISO8601DateFormatter()

  private init() {}

  func beginCapture(on surface: NicoleVoiceController.Surface) {
    var state = SurfaceState()
    state.captureStartedAt = now()
    states[surface] = state
  }

  func markSpeechDetected(on surface: NicoleVoiceController.Surface) {
    updateState(for: surface) { state in
      state.firstSpeechDetectedAt = state.firstSpeechDetectedAt ?? now()
    }
  }

  func markEndpointDetected(on surface: NicoleVoiceController.Surface) {
    updateState(for: surface) { state in
      state.endpointDetectedAt = state.endpointDetectedAt ?? now()
    }
  }

  func markFinalTranscriptReady(
    _ transcript: String,
    on surface: NicoleVoiceController.Surface
  ) {
    updateState(for: surface) { state in
      state.finalTranscriptReadyAt = state.finalTranscriptReadyAt ?? now()
      if state.transcriptPreview == nil {
        state.transcriptPreview = preview(transcript)
      }
    }
  }

  func markPrepareRequested(
    transcript: String,
    on surface: NicoleVoiceController.Surface,
    isFinal: Bool
  ) {
    updateState(for: surface) { state in
      if state.transcriptPreview == nil {
        state.transcriptPreview = preview(transcript)
      }
      if isFinal {
        state.finalPrepareRequestedAt = now()
      } else {
        state.firstPrepareRequestedAt = state.firstPrepareRequestedAt ?? now()
      }
    }
  }

  func markPrepareCompleted(
    _ prepared: NicoleVoicePreparedTurn,
    on surface: NicoleVoiceController.Surface,
    isFinal: Bool
  ) {
    updateState(for: surface) { state in
      state.voiceTurnId = prepared.voiceTurnId
      state.prepareLatency = prepared.latency ?? state.prepareLatency
      if isFinal {
        state.finalPrepareCompletedAt = now()
      } else {
        state.firstPrepareCompletedAt = state.firstPrepareCompletedAt ?? now()
      }
    }
  }

  func markReplyRequestStarted(
    on surface: NicoleVoiceController.Surface,
    voiceTurnId: String?,
    transcript: String
  ) {
    updateState(for: surface) { state in
      state.replyRequestStartedAt = now()
      state.voiceTurnId = voiceTurnId ?? state.voiceTurnId
      if state.transcriptPreview == nil {
        state.transcriptPreview = preview(transcript)
      }
    }
  }

  func recordStreamEvent(
    _ event: NicoleStreamEventEnvelope,
    on surface: NicoleVoiceController.Surface
  ) {
    updateState(for: surface) { state in
      switch event.type {
      case .status:
        state.firstStatusAt = state.firstStatusAt ?? now()
      case .tool, .activity:
        state.firstActivityAt = state.firstActivityAt ?? now()
      case .text, .textDelta:
        state.firstTextAt = state.firstTextAt ?? now()
      case .speechBoundary:
        state.firstSpeechBoundaryAt = state.firstSpeechBoundaryAt ?? now()
      case .latency:
        if let metric = event.metric {
          state.serverMetrics.append(metric)
        }
      case .preface, .done, .error:
        break
      }
    }
  }

  func markPlaybackStarted(on surface: NicoleVoiceController.Surface) {
    updateState(for: surface) { state in
      state.firstPlaybackStartedAt = state.firstPlaybackStartedAt ?? now()
    }
  }

  func markReplyInterrupted(on surface: NicoleVoiceController.Surface) {
    updateState(for: surface) { state in
      state.interruptionCount += 1
    }
  }

  func markReplyCompleted(
    on surface: NicoleVoiceController.Surface,
    reason _: String = "completed"
  ) {
    guard var state = states[surface] else { return }
    state.completedAt = state.completedAt ?? now()
    states[surface] = state

    let summary = LoggedSummary(
      timestamp: formatter.string(from: Date()),
      surface: surfaceName(for: surface),
      localTurnID: state.localTurnID,
      voiceTurnId: state.voiceTurnId,
      transcriptPreview: state.transcriptPreview,
      interruptionCount: state.interruptionCount,
      captureToSpeechMs: diff(state.captureStartedAt, state.firstSpeechDetectedAt),
      speechToEndpointMs: diff(state.firstSpeechDetectedAt, state.endpointDetectedAt),
      endpointToTranscriptMs: diff(state.endpointDetectedAt, state.finalTranscriptReadyAt),
      firstPrepareRoundTripMs: diff(state.firstPrepareRequestedAt, state.firstPrepareCompletedAt),
      finalPrepareRoundTripMs: diff(state.finalPrepareRequestedAt, state.finalPrepareCompletedAt),
      finalTranscriptToReplyRequestMs: diff(state.finalTranscriptReadyAt, state.replyRequestStartedAt),
      replyToFirstStatusMs: diff(state.replyRequestStartedAt, state.firstStatusAt),
      replyToFirstActivityMs: diff(state.replyRequestStartedAt, state.firstActivityAt),
      replyToFirstTextMs: diff(state.replyRequestStartedAt, state.firstTextAt),
      replyToFirstSpeechBoundaryMs: diff(state.replyRequestStartedAt, state.firstSpeechBoundaryAt),
      replyToFirstPlaybackMs: diff(state.replyRequestStartedAt, state.firstPlaybackStartedAt),
      totalTurnMs: diff(state.captureStartedAt, state.completedAt),
      prepareServerLatency: state.prepareLatency,
      serverMetrics: dedupeMetrics(state.serverMetrics)
    )

    log(summary)
    states.removeValue(forKey: surface)
  }

  private func updateState(
    for surface: NicoleVoiceController.Surface,
    mutate: (inout SurfaceState) -> Void
  ) {
    var state = states[surface] ?? {
      var state = SurfaceState()
      state.captureStartedAt = now()
      return state
    }()
    mutate(&state)
    states[surface] = state
  }

  private func dedupeMetrics(_ metrics: [NicoleLatencyMetric]) -> [NicoleLatencyMetric] {
    var seen: Set<String> = []
    var ordered: [NicoleLatencyMetric] = []

    for metric in metrics.reversed() {
      if seen.insert(metric.key).inserted {
        ordered.append(metric)
      }
    }

    return ordered.reversed()
  }

  private func log(_ summary: LoggedSummary) {
    let total = formatMilliseconds(summary.totalTurnMs)
    let firstText = formatMilliseconds(summary.replyToFirstTextMs)
    let firstAudio = formatMilliseconds(summary.replyToFirstPlaybackMs)
    let endpoint = formatMilliseconds(summary.speechToEndpointMs)
    let transcript = formatMilliseconds(summary.endpointToTranscriptMs)
    let prepare = formatMilliseconds(summary.finalPrepareRoundTripMs ?? summary.firstPrepareRoundTripMs)

    print(
      "[VoiceLatency][\(summary.surface)] total=\(total) endpoint=\(endpoint) transcript=\(transcript) prepare=\(prepare) firstText=\(firstText) firstAudio=\(firstAudio)"
    )

    do {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let data = try encoder.encode(summary)
      let line = data + Data("\n".utf8)
      let url = try logFileURL()

      if FileManager.default.fileExists(atPath: url.path) {
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
        try handle.close()
      } else {
        try line.write(to: url)
      }
    } catch {
      print("[VoiceLatency] Failed to persist summary: \(error.localizedDescription)")
    }
  }

  private func logFileURL() throws -> URL {
    let appSupport = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = appSupport
      .appendingPathComponent("Nicole", isDirectory: true)
      .appendingPathComponent("Logs", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("voice-latency.ndjson")
  }

  private func now() -> TimeInterval {
    ProcessInfo.processInfo.systemUptime
  }

  private func diff(_ start: TimeInterval?, _ end: TimeInterval?) -> Double? {
    guard let start, let end else { return nil }
    return max(0, (end - start) * 1000)
  }

  private func preview(_ value: String) -> String {
    let collapsed = value
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if collapsed.count <= 120 {
      return collapsed
    }
    return String(collapsed.prefix(120)) + "…"
  }

  private func formatMilliseconds(_ value: Double?) -> String {
    guard let value else { return "n/a" }
    return String(format: "%.0fms", value)
  }

  private func surfaceName(for surface: NicoleVoiceController.Surface) -> String {
    switch surface {
    case .ambient:
      return "ambient"
    case .expanded:
      return "expanded"
    case .compact:
      return "compact"
    }
  }
}
