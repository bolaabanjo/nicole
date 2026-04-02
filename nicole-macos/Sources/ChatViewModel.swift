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

  func send(baseURLString: String, settings: AppSettings) async {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !isSending else { return }

    errorText = nil
    isSending = true
    connectionState = .syncing
    backendOrigin = await apiClient.normalizedOriginString(baseURLString: baseURLString)
    lastRequestURL = try? await apiClient.streamURLString(baseURLString: baseURLString)

    let userMessage = NicoleMessage(role: .user, content: trimmed)
    messages.append(userMessage)
    input = ""

    let assistantID = UUID().uuidString
    messages.append(
      NicoleMessage(id: assistantID, role: .assistant, content: "", isStreaming: true)
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
    }

    isSending = false
  }

  private func appendAssistantChunk(_ chunk: String, assistantID: String) {
    guard let index = messages.firstIndex(where: { $0.id == assistantID }) else {
      return
    }

    messages[index].content += chunk
  }

  private func finishAssistantMessage(id: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].isStreaming = false
  }

  private func replaceAssistantPlaceholder(id: String, content: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].content = content
    messages[index].isStreaming = false
  }
}
