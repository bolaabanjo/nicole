import Foundation

@MainActor
final class ChatViewModel: ObservableObject {
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
    settings: AppSettings,
    attachmentURL: URL? = nil
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
      settings: settings,
      clearInputOnSuccess: true
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

    return await beginStreamSend(
      message: trimmed,
      baseURLString: baseURLString,
      settings: settings,
      clearInputOnSuccess: false
    )
  }

  private var thoughtStartTimes: [String: Date] = [:]

  private func beginStreamSend(
    message: String,
    baseURLString: String,
    settings: AppSettings,
    clearInputOnSuccess: Bool
  ) async -> String? {
    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)

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
        isThoughtOpen: true
      )
    )

    let context = await WorkspaceContextProvider.currentContext(settings: settings)

    Task { @MainActor [weak self] in
      await self?.performStreamSend(
        baseURLString: baseURLString,
        message: message,
        assistantID: assistantID,
        context: context
      )
    }

    return assistantID
  }

  private func performStreamSend(
    baseURLString: String,
    message: String,
    assistantID: String,
    context: NicoleWorkspaceContextPayload
  ) async {
    do {
      try await apiClient.streamReply(
        baseURLString: baseURLString,
        message: message,
        context: context
      ) { [weak self] chunk in
        await self?.appendAssistantChunk(chunk, assistantID: assistantID)
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
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
      isSending = false
    }
  }

  private func appendAssistantChunk(_ chunk: String, assistantID: String) {
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

    if parsed.isThoughtOpen || parsed.thoughtContent != nil {
      message.isThoughtOpen = parsed.isThoughtOpen
      message.thoughtContent = parsed.thoughtContent

      if let start = thoughtStartTimes[assistantID] {
        message.thoughtDuration = Int(Date().timeIntervalSince(start))
      }
    } else {
      message.isThoughtOpen = false
      message.thoughtContent = nil
    }

    message.content = parsed.visibleContent
    messages[index] = message
  }

  private func finishAssistantMessage(id: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].isStreaming = false

    let finalRaw = rawAssistantBuffers[id] ?? messages[index].content
    let parsed = parseAssistantBuffer(finalRaw)
    messages[index].content = parsed.visibleContent
    messages[index].thoughtContent = parsed.thoughtContent

    if messages[index].thoughtContent != nil {
      messages[index].isThoughtOpen = false
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
