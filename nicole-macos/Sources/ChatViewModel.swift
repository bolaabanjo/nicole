import Foundation

@MainActor
final class ChatViewModel: ObservableObject {
  enum SessionScope: String {
    case expanded
    case compact
    case voice
  }

  enum ConnectionState {
    case idle
    case connecting
    case connected(messageCount: Int)
    case syncing
    case failed(String)
  }

  @Published var messages: [NicoleMessage] = []
  @Published var input = ""
  @Published var isLoadingHistory = false
  @Published var isSending = false
  @Published var connectionState: ConnectionState = .idle
  @Published var errorText: String?
  @Published var infoText: String?
  @Published var backendOrigin: String?
  @Published var lastRequestURL: String?

  private let apiClient = NicoleAPIClient()
  private var rawAssistantBuffers: [String: String] = [:]
  private var completionContinuations: [String: CheckedContinuation<NicoleMessage?, Never>] = [:]
  private var completedAssistantResults: [String: NicoleMessage?] = [:]
  private weak var voiceController: NicoleVoiceController?
  private var voiceStreamingIDs: Set<String> = []
  private var voiceReplySurfaces: [String: NicoleVoiceController.Surface] = [:]
  private var lastCompactVisualContext: CompactVisualContextSnapshot?

  private struct CompactVisualContextSnapshot {
    let context: NicoleWorkspaceContextPayload
    let createdAt: Date
  }

  func attachVoiceController(_ controller: NicoleVoiceController) {
    voiceController = controller
  }

  func loadHistory(baseURLString: String) async {
    guard !baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      errorText = "Set Nicole's server URL in Settings first."
      connectionState = .idle
      return
    }

    isLoadingHistory = true
    errorText = nil
    connectionState = .connecting
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)
    lastRequestURL = try? await apiClient.historyURLString(baseURLString: baseURLString)

    do {
      let loadedMessages = try await apiClient.fetchHistory(baseURLString: baseURLString)
      messages = loadedMessages.filter { $0.role != .system }
      connectionState = .connected(messageCount: messages.count)
    } catch {
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
    }

    isLoadingHistory = false
  }

  func send(
    baseURLString: String,
    settings _: AppSettings,
    attachmentURL: URL? = nil,
    sessionScope: SessionScope = .expanded
  ) async -> Bool {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (!trimmed.isEmpty || attachmentURL != nil), !isSending else { return false }

    errorText = nil
    infoText = nil
    isSending = true
    connectionState = .syncing
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)

    if let attachmentURL {
      lastRequestURL = try? await apiClient.ingestURLString(baseURLString: baseURLString)

      do {
        let result = try await apiClient.ingestFile(
          baseURLString: baseURLString,
          fileURL: attachmentURL
        )
        infoText = "Added \(result.title) to Nicole's library."

        if trimmed.isEmpty {
          await loadHistory(baseURLString: baseURLString)
          isSending = false
          return true
        }
      } catch {
        errorText = error.localizedDescription
        connectionState = .failed(error.localizedDescription)
        isSending = false
        return false
      }
    }

    guard let assistantID = await beginStreamSend(
      message: trimmed,
      baseURLString: baseURLString,
      clearInputOnSuccess: true,
      sessionScope: sessionScope
    ) else {
      isSending = false
      return false
    }

    return !assistantID.isEmpty
  }

  func sendCompactMessage(
    _ message: String,
    baseURLString: String,
    settings: AppSettings
  ) async -> String? {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !isSending else { return nil }

    errorText = nil
    infoText = nil
    isSending = true
    connectionState = .syncing
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)
    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)

    let assistantID = enqueueAssistantExchange(
      message: trimmed,
      clearInputOnSuccess: false,
      isThoughtOpen: true
    )

    Task { @MainActor [weak self] in
      await self?.performVisionBackedStreamSend(
        baseURLString: baseURLString,
        settings: settings,
        message: trimmed,
        assistantID: assistantID,
        sessionScope: .compact
      )
    }

    return assistantID
  }

  func sendVisionMessage(
    question: String,
    baseURLString: String,
    settings: AppSettings,
    voiceSurface: NicoleVoiceController.Surface? = nil,
    preparedTurn: NicoleVoicePreparedTurn? = nil
  ) async -> NicoleMessage? {
    guard !isSending else { return nil }

    errorText = nil
    isSending = true
    connectionState = .syncing
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)
    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)

    let assistantID = enqueueAssistantExchange(
      message: question,
      clearInputOnSuccess: false,
      isThoughtOpen: true
    )

    let useStreamingTTS = voiceController?.isStreamingTTS == true
    if useStreamingTTS {
      voiceStreamingIDs.insert(assistantID)
      if let voiceSurface {
        voiceReplySurfaces[assistantID] = voiceSurface
      }
    }

    await performVisionBackedStreamSend(
      baseURLString: baseURLString,
      settings: settings,
      message: question,
      assistantID: assistantID,
      sessionScope: .voice,
      voiceSurface: voiceSurface,
      preparedTurn: preparedTurn
    )

    return currentAssistantMessage(id: assistantID)
  }

  func sendVoiceMessage(
    _ message: String,
    baseURLString: String,
    settings _: AppSettings,
    surface: NicoleVoiceController.Surface,
    preparedTurn: NicoleVoicePreparedTurn? = nil,
    context: NicoleWorkspaceContextPayload? = nil
  ) async -> NicoleMessage? {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let useStreamingTTS = voiceController?.isStreamingTTS == true

    errorText = nil
    isSending = true
    connectionState = .syncing
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)
    lastRequestURL = try? await apiClient.voiceURLString(baseURLString: baseURLString)

    let userMessage = NicoleMessage(role: .user, content: trimmed)
    messages.append(userMessage)

    let assistantID = UUID().uuidString
    rawAssistantBuffers[assistantID] = ""
    messages.append(
      NicoleMessage(
        id: assistantID,
        role: .assistant,
        content: "",
        isStreaming: true,
        thoughtContent: nil,
        isThoughtOpen: false
      )
    )

    if useStreamingTTS {
      voiceStreamingIDs.insert(assistantID)
      voiceReplySurfaces[assistantID] = surface
    }
    VoiceLatencyTracker.shared.markReplyRequestStarted(
      on: surface,
      voiceTurnId: preparedTurn?.voiceTurnId,
      transcript: trimmed
    )

    do {
      try await apiClient.streamVoiceReplyEvents(
        baseURLString: baseURLString,
        message: trimmed,
        context: context,
        sessionId: VoiceSessionManager.shared.sessionId(for: surface),
        surface: VoiceSessionManager.shared.surfaceName(for: surface),
        voiceTurnId: preparedTurn?.voiceTurnId,
        interruptedVoiceTurnId: preparedTurn?.interruptedByTurnId
      ) { [weak self] event in
        await self?.handleAssistantStreamEvent(event, assistantID: assistantID)
      }

      finishAssistantMessage(id: assistantID)
      connectionState = .connected(
        messageCount: messages.filter { $0.role != .system }.count
      )
      isSending = false

      if let index = messages.firstIndex(where: { $0.id == assistantID }) {
        return messages[index]
      }
      return nil
    } catch {
      replaceAssistantPlaceholder(id: assistantID, content: "I'm unavailable right now.")
      voiceStreamingIDs.remove(assistantID)
      voiceReplySurfaces.removeValue(forKey: assistantID)
      VoiceSessionManager.shared.markReplyCompleted(on: surface)
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
      isSending = false
      return nil
    }
  }

  private var thoughtStartTimes: [String: Date] = [:]

  private func beginStreamSend(
    message: String,
    baseURLString: String,
    clearInputOnSuccess: Bool,
    sessionScope: SessionScope
  ) async -> String? {
    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)
    let assistantID = enqueueAssistantExchange(
      message: message,
      clearInputOnSuccess: clearInputOnSuccess,
      isThoughtOpen: true
    )

    Task { @MainActor [weak self] in
      await self?.performStreamSend(
        baseURLString: baseURLString,
        message: message,
        assistantID: assistantID,
        context: nil,
        sessionScope: sessionScope
      )
    }

    return assistantID
  }

  private func enqueueAssistantExchange(
    message: String,
    clearInputOnSuccess: Bool,
    isThoughtOpen: Bool
  ) -> String {
    let userMessage = NicoleMessage(role: .user, content: message)
    messages.append(userMessage)

    if clearInputOnSuccess {
      input = ""
    }

    let assistantID = UUID().uuidString
    rawAssistantBuffers[assistantID] = ""
    messages.append(
      NicoleMessage(
        id: assistantID,
        role: .assistant,
        content: "",
        isStreaming: true,
        thoughtContent: nil,
        isThoughtOpen: isThoughtOpen
      )
    )

    return assistantID
  }

  private func performVisionBackedStreamSend(
    baseURLString: String,
    settings: AppSettings,
    message: String,
    assistantID: String,
    sessionScope: SessionScope,
    voiceSurface: NicoleVoiceController.Surface? = nil,
    preparedTurn: NicoleVoicePreparedTurn? = nil
  ) async {
    if sessionScope == .compact,
       let cachedContext = reusableCompactVisualContext(for: message)
    {
      await performStreamSend(
        baseURLString: baseURLString,
        message: message,
        assistantID: assistantID,
        context: cachedContext,
        sessionScope: sessionScope
      )
      return
    }

    async let seedContextTask = WorkspaceContextProvider.compactSeedContext()
    async let latestFrameTask = CompactScreenCaptureController.shared.latestFrameJPEGData(
      timeoutNanoseconds: 250_000_000
    )

    let seedContext = await seedContextTask
    let latestFrameData = await latestFrameTask
    let imageBase64 = latestFrameData?.base64EncodedString()

    var context: NicoleWorkspaceContextPayload?

    if let imageBase64 {
      let analysis = await LocalVisionAnalyzer.shared.analyzeScreen(
        imageBase64: imageBase64,
        question: message,
        contextHint: seedContext
      )

      if let analysis {
        context = makeVisionBackedContext(
          seedContext: seedContext,
          analysis: analysis
        )
      }
    }

    if context == nil,
       let latestFrameData,
       let visibleText = await ScreenEnrichmentEngine.shared.recognizeVisibleText(
         in: latestFrameData
       )
    {
      context = makeOCRFallbackContext(
        seedContext: seedContext,
        visibleText: visibleText
      )
    }

    if context == nil {
      context = await WorkspaceContextProvider.compactContext(settings: settings) ?? seedContext
    }

    if sessionScope == .compact, let context {
      cacheCompactVisualContextIfUseful(context)
    }

    if sessionScope == .voice, let voiceSurface {
      await performVoiceStreamSend(
        baseURLString: baseURLString,
        message: message,
        assistantID: assistantID,
        context: context,
        surface: voiceSurface,
        preparedTurn: preparedTurn
      )
    } else {
      await performStreamSend(
        baseURLString: baseURLString,
        message: message,
        assistantID: assistantID,
        context: context,
        sessionScope: sessionScope
      )
    }
  }

  private func makeVisionBackedContext(
    seedContext: NicoleWorkspaceContextPayload?,
    analysis: NicoleVisionAnalysis
  ) -> NicoleWorkspaceContextPayload {
    NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: seedContext?.activeApp ?? analysis.appOrSurface,
      windowTitle: seedContext?.windowTitle,
      selectedText: seedContext?.selectedText,
      clipboardText: nil,
      currentUrl: seedContext?.currentUrl,
      currentFilePath: seedContext?.currentFilePath,
      visibleContent: analysis.visibleText ?? seedContext?.visibleContent,
      visualSummary: analysis.summary,
      visualElements: analysis.importantElements.isEmpty ? nil : analysis.importantElements,
      visualIssues: analysis.possibleIssues.isEmpty ? nil : analysis.possibleIssues,
      visualConfidence: analysis.confidence,
      captureNotes: analysis.captureNotes,
      note: "Fresh local compact screenshot analysis. Use this visual reading as the primary workspace grounding."
    )
  }

  private func makeOCRFallbackContext(
    seedContext: NicoleWorkspaceContextPayload?,
    visibleText: String
  ) -> NicoleWorkspaceContextPayload {
    NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: seedContext?.activeApp,
      windowTitle: seedContext?.windowTitle,
      selectedText: seedContext?.selectedText,
      clipboardText: nil,
      currentUrl: seedContext?.currentUrl,
      currentFilePath: seedContext?.currentFilePath,
      visibleContent: visibleText,
      visualSummary: seedContext?.visualSummary,
      visualElements: seedContext?.visualElements,
      visualIssues: seedContext?.visualIssues,
      visualConfidence: "low",
      captureNotes: "Nicole fell back to OCR on the current compact capture because visual analysis was unavailable.",
      note: "Compact vision fallback used OCR from the latest local capture. If the answer sounds cautious, the visual read may be incomplete."
    )
  }

  private func reusableCompactVisualContext(
    for message: String
  ) -> NicoleWorkspaceContextPayload? {
    guard let snapshot = lastCompactVisualContext else {
      return nil
    }

    guard Date().timeIntervalSince(snapshot.createdAt) <= 15 else {
      lastCompactVisualContext = nil
      return nil
    }

    let normalized = message
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()

    guard looksLikeCompactVisualFollowUp(normalized) else {
      return nil
    }

    return NicoleWorkspaceContextPayload(
      surface: snapshot.context.surface,
      activeApp: snapshot.context.activeApp,
      windowTitle: snapshot.context.windowTitle,
      selectedText: snapshot.context.selectedText,
      clipboardText: snapshot.context.clipboardText,
      currentUrl: snapshot.context.currentUrl,
      currentFilePath: snapshot.context.currentFilePath,
      visibleContent: snapshot.context.visibleContent,
      visualSummary: snapshot.context.visualSummary,
      visualElements: snapshot.context.visualElements,
      visualIssues: snapshot.context.visualIssues,
      visualConfidence: snapshot.context.visualConfidence,
      captureNotes: snapshot.context.captureNotes,
      note: "Reusing the latest compact visual context from a moment ago. Stay anchored to the same on-screen topic unless Roy clearly changed subjects."
    )
  }

  private func cacheCompactVisualContextIfUseful(
    _ context: NicoleWorkspaceContextPayload
  ) {
    guard
      context.visualSummary != nil ||
      context.visibleContent != nil ||
      context.currentFilePath != nil ||
      context.windowTitle != nil
    else {
      return
    }

    lastCompactVisualContext = CompactVisualContextSnapshot(
      context: context,
      createdAt: Date()
    )
  }

  private func looksLikeCompactVisualFollowUp(_ normalized: String) -> Bool {
    guard !normalized.isEmpty else {
      return false
    }

    let refreshPatterns = [
      #"^what do you see"#,
      #"^look at"#,
      #"^check (?:the|my) screen"#,
      #"^read (?:the|this) screen"#,
      #"^scan (?:the|this)"#,
      #"^summarize (?:the|this) page"#,
      #"^what'?s on (?:the|my) screen"#,
    ]

    if refreshPatterns.contains(where: { normalized.range(of: $0, options: .regularExpression) != nil }) {
      return false
    }

    let followUpPatterns = [
      #"^(?:yes|yeah|yep|continue|go on|keep going)[.!?]*$"#,
      #"^(?:explain|clarify|simplify|summarize|break down|teach|walk me through)\b"#,
      #"^(?:what does that mean|why|how|so|then)\b"#,
      #"^(?:quiz me|test me|help me understand|make it simpler)\b"#,
      #"^(?:explain|solve|answer) (?:this|that|it)\b"#,
    ]

    return followUpPatterns.contains {
      normalized.range(of: $0, options: .regularExpression) != nil
    }
  }

  private func currentAssistantMessage(id: String) -> NicoleMessage? {
    guard let index = messages.firstIndex(where: { $0.id == id }) else {
      return nil
    }

    return messages[index]
  }

  private func performStreamSend(
    baseURLString: String,
    message: String,
    assistantID: String,
    context: NicoleWorkspaceContextPayload?,
    sessionScope: SessionScope
  ) async {
    do {
      try await apiClient.streamReplyEvents(
        baseURLString: baseURLString,
        message: message,
        context: context,
        sessionId: sessionScope.rawValue
      ) { [weak self] event in
        await self?.handleAssistantStreamEvent(event, assistantID: assistantID)
      }

      finishAssistantMessage(id: assistantID)
      connectionState = .connected(
        messageCount: messages.filter { $0.role != .system }.count
      )
      isSending = false
    } catch {
      replaceAssistantPlaceholder(
        id: assistantID,
        content: "I'm unavailable right now."
      )
      voiceStreamingIDs.remove(assistantID)
      if let continuation = completionContinuations.removeValue(forKey: assistantID) {
        continuation.resume(returning: nil)
      } else {
        completedAssistantResults[assistantID] = nil
      }
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
      isSending = false
    }
  }

  private func performVoiceStreamSend(
    baseURLString: String,
    message: String,
    assistantID: String,
    context: NicoleWorkspaceContextPayload?,
    surface: NicoleVoiceController.Surface,
    preparedTurn: NicoleVoicePreparedTurn?
  ) async {
    VoiceLatencyTracker.shared.markReplyRequestStarted(
      on: surface,
      voiceTurnId: preparedTurn?.voiceTurnId,
      transcript: message
    )

    do {
      try await apiClient.streamVoiceReplyEvents(
        baseURLString: baseURLString,
        message: message,
        context: context,
        sessionId: VoiceSessionManager.shared.sessionId(for: surface),
        surface: VoiceSessionManager.shared.surfaceName(for: surface),
        voiceTurnId: preparedTurn?.voiceTurnId,
        interruptedVoiceTurnId: preparedTurn?.interruptedByTurnId
      ) { [weak self] event in
        await self?.handleAssistantStreamEvent(event, assistantID: assistantID)
      }

      finishAssistantMessage(id: assistantID)
      connectionState = .connected(
        messageCount: messages.filter { $0.role != .system }.count
      )
      isSending = false
    } catch {
      replaceAssistantPlaceholder(
        id: assistantID,
        content: "I'm unavailable right now."
      )
      voiceStreamingIDs.remove(assistantID)
      voiceReplySurfaces.removeValue(forKey: assistantID)
      VoiceSessionManager.shared.markReplyCompleted(on: surface)
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
      isSending = false
    }
  }

  private func handleAssistantStreamEvent(
    _ event: NicoleStreamEventEnvelope,
    assistantID: String
  ) {
    guard let index = messages.firstIndex(where: { $0.id == assistantID }) else {
      return
    }

    if let surface = voiceReplySurfaces[assistantID] {
      VoiceLatencyTracker.shared.recordStreamEvent(event, on: surface)
    }

    switch event.type {
    case .preface:
      messages[index].preActionText = event.text
    case .status:
      if messages[index].preActionText?.isEmpty != false &&
        messages[index].content.isEmpty &&
        messages[index].activityItems.isEmpty
      {
        messages[index].preActionText = event.text
      } else {
        messages[index].liveStatusText = event.text
      }
    case .tool, .activity:
      let trimmed = event.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      if messages[index].activityItems.last?.text != trimmed {
        messages[index].activityItems.append(NicoleActivityItem(text: trimmed))
      }
    case .textDelta:
      appendAssistantChunk(event.text, assistantID: assistantID, feedStreamingTTS: true)
    case .text:
      appendAssistantChunk(event.text, assistantID: assistantID, feedStreamingTTS: false)
    case .speechBoundary:
      if voiceStreamingIDs.contains(assistantID) {
        voiceController?.handleSpeechBoundary(event.text)
      }
    case .latency:
      break
    case .done:
      break
    case .error:
      messages[index].liveStatusText = nil
    }
  }

  private func appendAssistantChunk(
    _ chunk: String,
    assistantID: String,
    feedStreamingTTS: Bool
  ) {
    guard let index = messages.firstIndex(where: { $0.id == assistantID }) else {
      return
    }

    var message = messages[index]

    let rawContent = (rawAssistantBuffers[assistantID] ?? "") + chunk
    rawAssistantBuffers[assistantID] = rawContent

    if thoughtStartTimes[assistantID] == nil {
      thoughtStartTimes[assistantID] = Date()
    }

    let parsed = parseAssistantBuffer(rawContent)
    message.isThoughtOpen = false
    message.thoughtContent = nil
    message.content = parsed.visibleContent
    messages[index] = message

    // Feed streaming content to voice controller for sentence-by-sentence TTS
    if feedStreamingTTS,
      voiceStreamingIDs.contains(assistantID),
      !parsed.visibleContent.isEmpty
    {
      voiceController?.handleStreamingContent(parsed.visibleContent)
    }
  }

  private func finishAssistantMessage(id: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].isStreaming = false
    messages[index].liveStatusText = nil

    let finalRaw = rawAssistantBuffers[id] ?? messages[index].content
    let parsed = parseAssistantBuffer(finalRaw)
    messages[index].content = parsed.visibleContent
    messages[index].thoughtContent = nil
    messages[index].isThoughtOpen = false

    let usedStreamingTTS = voiceStreamingIDs.remove(id) != nil

    if usedStreamingTTS {
      // Streaming TTS — send any remaining text and signal completion
      voiceController?.finishStreamingTTS(remainingContent: messages[index].content)
    } else if !messages[index].content.isEmpty {
      voiceController?.handleCompletedAssistantMessage(messages[index])
    }
    if let surface = voiceReplySurfaces.removeValue(forKey: id), !usedStreamingTTS {
      VoiceSessionManager.shared.markReplyCompleted(on: surface)
    }

    if let continuation = completionContinuations.removeValue(forKey: id) {
      continuation.resume(returning: messages[index])
    } else {
      completedAssistantResults[id] = messages[index]
    }

    thoughtStartTimes.removeValue(forKey: id)
    rawAssistantBuffers.removeValue(forKey: id)
  }

  private func replaceAssistantPlaceholder(id: String, content: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].content = sanitizeVisibleAssistantContent(content)
    messages[index].thoughtContent = nil
    messages[index].isThoughtOpen = false
    messages[index].isStreaming = false
    messages[index].liveStatusText = nil
    rawAssistantBuffers.removeValue(forKey: id)
    thoughtStartTimes.removeValue(forKey: id)
  }
}

private struct ParsedAssistantBuffer {
  let thoughtContent: String?
  let visibleContent: String
  let isThoughtOpen: Bool
}

private func parseAssistantBuffer(_ raw: String) -> ParsedAssistantBuffer {
  let thinkOpenTag = "<think>"
  let thinkCloseTag = "</think>"
  let thoughtOpenTag = "<thought>"
  let thoughtCloseTag = "</thought>"

  if let range = raw.range(of: thinkOpenTag) {
    return parseTaggedAssistantBuffer(
      raw,
      openRange: range,
      closeTag: thinkCloseTag
    )
  }

  if let range = raw.range(of: thoughtOpenTag) {
    return parseTaggedAssistantBuffer(
      raw,
      openRange: range,
      closeTag: thoughtCloseTag
    )
  }

  return ParsedAssistantBuffer(
    thoughtContent: nil,
    visibleContent: sanitizeVisibleAssistantContent(raw),
    isThoughtOpen: false
  )
}

private func parseTaggedAssistantBuffer(
  _ raw: String,
  openRange: Range<String.Index>,
  closeTag: String
) -> ParsedAssistantBuffer {
  let before = String(raw[..<openRange.lowerBound])
  let afterOpen = String(raw[openRange.upperBound...])

  if let closeRange = afterOpen.range(of: closeTag) {
    let thought = String(afterOpen[..<closeRange.lowerBound])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let afterClose = String(afterOpen[closeRange.upperBound...])
    let visible = sanitizeVisibleAssistantContent(before + afterClose)

    return ParsedAssistantBuffer(
      thoughtContent: thought.isEmpty ? nil : thought,
      visibleContent: visible,
      isThoughtOpen: false
    )
  }

  return ParsedAssistantBuffer(
    thoughtContent: afterOpen.trimmingCharacters(in: .whitespacesAndNewlines),
    visibleContent: sanitizeVisibleAssistantContent(before),
    isThoughtOpen: true
  )
}

private func sanitizeVisibleAssistantContent(_ text: String) -> String {
  text
    .replacingOccurrences(of: "<think>", with: "")
    .replacingOccurrences(of: "</think>", with: "")
    .replacingOccurrences(of: "<thought>", with: "")
    .replacingOccurrences(of: "</thought>", with: "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}
