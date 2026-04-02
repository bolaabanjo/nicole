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

    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)

    let userMessage = NicoleMessage(role: .user, content: trimmed)
    messages.append(userMessage)
    input = ""

    let assistantID = UUID().uuidString
    messages.append(
      NicoleMessage(id: assistantID, role: .assistant, content: "", isStreaming: true, isThoughtOpen: true)
    )

    do {
      try await apiClient.streamReply(
        baseURLString: baseURLString,
        message: trimmed,
        context: WorkspaceContextProvider.currentContext(settings: settings)
      ) { [weak self] chunk in
        await self?.appendAssistantChunk(chunk, assistantID: assistantID)
      }

      finishAssistantMessage(id: assistantID)
      await loadHistory(baseURLString: baseURLString)
    } catch {
      replaceAssistantPlaceholder(
        id: assistantID,
        content: "I can't reach Nicole right now."
      )
      errorText = error.localizedDescription
      connectionState = .failed(error.localizedDescription)
      isSending = false
      return false
    }

    isSending = false
    return true
  }

  private var thoughtStartTimes: [String: Date] = [:]

  private func appendAssistantChunk(_ chunk: String, assistantID: String) {
    guard let index = messages.firstIndex(where: { $0.id == assistantID }) else {
      return
    }

    var message = messages[index]
    
    let rawContent = (message.thoughtContent ?? "") + message.content + chunk
    
    // Timer handling
    if thoughtStartTimes[assistantID] == nil {
        thoughtStartTimes[assistantID] = Date()
    }
    
    // Extremely basic <thought> parser for streaming
    if let thoughtStart = rawContent.range(of: "<thought>") {
        message.isThoughtOpen = true
        let afterStart = String(rawContent[thoughtStart.upperBound...])
        
        if let thoughtEnd = afterStart.range(of: "</thought>") {
            // Thought finished
            if let start = thoughtStartTimes[assistantID] {
                message.thoughtDuration = Int(Date().timeIntervalSince(start))
            }
            message.thoughtContent = String(afterStart[..<thoughtEnd.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            message.content = String(afterStart[thoughtEnd.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            // Still in thought
            message.thoughtContent = afterStart.trimmingCharacters(in: .whitespacesAndNewlines)
            message.content = ""
            // Update duration if possible (optional: could also use a separate @Published duration)
            if let start = thoughtStartTimes[assistantID] {
                message.thoughtDuration = Int(Date().timeIntervalSince(start))
            }
        }
    } else {
        // No thought tag found yet or at all
        message.content = rawContent
    }
    
    messages[index] = message
  }

  private func finishAssistantMessage(id: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].isStreaming = false
    
    // Auto-close thought when finished if it was open
    if messages[index].thoughtContent != nil {
        messages[index].isThoughtOpen = false
    }
    thoughtStartTimes.removeValue(forKey: id)
  }

  private func replaceAssistantPlaceholder(id: String, content: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].content = content
    messages[index].isStreaming = false
  }
}
