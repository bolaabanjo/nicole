import Foundation

@MainActor
final class VoiceSessionManager: ObservableObject {
  static let shared = VoiceSessionManager()

  private struct SurfaceState {
    var sessionId: String
    var preparedTurn: NicoleVoicePreparedTurn?
    var lastPreparedTranscript: String?
    var prepareTask: Task<Void, Never>?
    var currentReplyVoiceTurnId: String?
    var interruptedVoiceTurnId: String?
    var lastWarmBaseURL: String?
  }

  private let apiClient = NicoleAPIClient()
  private var states: [NicoleVoiceController.Surface: SurfaceState] = [:]
  private var hasWarmedRuntime = false
  private var hasWarmedRemoteRuntime = false

  private init() {}

  func beginCapture(on surface: NicoleVoiceController.Surface) {
    prewarmRuntimeIfNeeded()
    cancelPendingPrepare(on: surface)
    VoiceLatencyTracker.shared.beginCapture(on: surface)
    let state = ensureState(for: surface)
    states[surface] = SurfaceState(
      sessionId: state.sessionId,
      preparedTurn: nil,
      lastPreparedTranscript: nil,
      prepareTask: nil,
      currentReplyVoiceTurnId: state.currentReplyVoiceTurnId,
      interruptedVoiceTurnId: state.interruptedVoiceTurnId,
      lastWarmBaseURL: state.lastWarmBaseURL
    )
  }

  func sessionId(for surface: NicoleVoiceController.Surface) -> String {
    ensureState(for: surface).sessionId
  }

  func surfaceName(for surface: NicoleVoiceController.Surface) -> String {
    switch surface {
    case .ambient:
      return "ambient"
    case .expanded:
      return "expanded"
    case .compact:
      return "compact"
    }
  }

  func updateProgressiveTranscript(
    _ transcript: String,
    on surface: NicoleVoiceController.Surface,
    baseURLString: String,
    context: NicoleWorkspaceContextPayload? = nil
  ) {
    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 4 else { return }
    prewarmRemoteRuntimeIfNeeded(on: surface, baseURLString: baseURLString, context: context)

    var state = ensureState(for: surface)
    if state.lastPreparedTranscript == trimmed {
      return
    }

    state.prepareTask?.cancel()
    state.prepareTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(80))
      guard !Task.isCancelled else { return }
      _ = await self?.prepare(
        transcript: trimmed,
        on: surface,
        baseURLString: baseURLString,
        isFinal: false,
        context: context
      )
    }
    states[surface] = state
  }

  func finalizePreparation(
    transcript: String,
    on surface: NicoleVoiceController.Surface,
    baseURLString: String,
    context: NicoleWorkspaceContextPayload? = nil
  ) async -> NicoleVoicePreparedTurn? {
    cancelPendingPrepare(on: surface)
    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    return await prepare(
      transcript: trimmed,
      on: surface,
      baseURLString: baseURLString,
      isFinal: true,
      context: context
    )
  }

  func preparedTurn(for surface: NicoleVoiceController.Surface) -> NicoleVoicePreparedTurn? {
    states[surface]?.preparedTurn
  }

  func markReplyStarted(
    on surface: NicoleVoiceController.Surface,
    voiceTurnId: String?
  ) {
    guard var state = states[surface] else { return }
    state.currentReplyVoiceTurnId = voiceTurnId
    state.interruptedVoiceTurnId = nil
    states[surface] = state
  }

  func markReplyCompleted(on surface: NicoleVoiceController.Surface) {
    guard var state = states[surface] else { return }
    state.currentReplyVoiceTurnId = nil
    state.interruptedVoiceTurnId = nil
    states[surface] = state
    VoiceLatencyTracker.shared.markReplyCompleted(on: surface)
  }

  func markReplyInterrupted(on surface: NicoleVoiceController.Surface) -> String? {
    guard var state = states[surface] else { return nil }
    state.interruptedVoiceTurnId = state.currentReplyVoiceTurnId
    state.currentReplyVoiceTurnId = nil
    states[surface] = state
    VoiceLatencyTracker.shared.markReplyInterrupted(on: surface)
    return state.interruptedVoiceTurnId
  }

  private func prepare(
    transcript: String,
    on surface: NicoleVoiceController.Surface,
    baseURLString: String,
    isFinal: Bool,
    context: NicoleWorkspaceContextPayload?
  ) async -> NicoleVoicePreparedTurn? {
    var state = ensureState(for: surface)
    VoiceLatencyTracker.shared.markPrepareRequested(
      transcript: transcript,
      on: surface,
      isFinal: isFinal
    )

    do {
      let prepared = try await apiClient.prepareVoiceTurn(
        baseURLString: baseURLString,
        transcript: transcript,
        sessionId: state.sessionId,
        surface: surfaceName(for: surface),
        isFinal: isFinal,
        voiceTurnId: state.preparedTurn?.voiceTurnId,
        interruptedVoiceTurnId: state.interruptedVoiceTurnId,
        context: context
      )

      state.preparedTurn = prepared
      state.lastPreparedTranscript = transcript
      state.prepareTask = nil
      states[surface] = state
      VoiceLatencyTracker.shared.markPrepareCompleted(
        prepared,
        on: surface,
        isFinal: isFinal
      )
      return prepared
    } catch {
      state.prepareTask = nil
      states[surface] = state
      return nil
    }
  }

  private func ensureState(
    for surface: NicoleVoiceController.Surface
  ) -> SurfaceState {
    if let state = states[surface] {
      return state
    }

    let state = SurfaceState(
      sessionId: "voice-\(surfaceName(for: surface))",
      preparedTurn: nil,
      lastPreparedTranscript: nil,
      prepareTask: nil,
      currentReplyVoiceTurnId: nil,
      interruptedVoiceTurnId: nil,
      lastWarmBaseURL: nil
    )
    states[surface] = state
    return state
  }

  private func cancelPendingPrepare(on surface: NicoleVoiceController.Surface) {
    guard var state = states[surface] else { return }
    state.prepareTask?.cancel()
    state.prepareTask = nil
    states[surface] = state
  }

  private func prewarmRuntimeIfNeeded() {
    guard !hasWarmedRuntime else { return }
    hasWarmedRuntime = true

    Task {
      _ = await WhisperTranscriber.shared.isAvailable()
      _ = await KokoroSpeaker.shared.isAvailable()
    }
  }

  private func prewarmRemoteRuntimeIfNeeded(
    on surface: NicoleVoiceController.Surface,
    baseURLString: String,
    context: NicoleWorkspaceContextPayload?
  ) {
    var state = ensureState(for: surface)
    if hasWarmedRemoteRuntime && state.lastWarmBaseURL == baseURLString {
      return
    }

    state.lastWarmBaseURL = baseURLString
    states[surface] = state
    hasWarmedRemoteRuntime = true
    let sessionId = state.sessionId
    let surfaceName = surfaceName(for: surface)

    Task { [apiClient] in
      try? await apiClient.warmVoiceRuntime(
        baseURLString: baseURLString,
        sessionId: sessionId,
        surface: surfaceName,
        context: context
      )
    }
  }
}
