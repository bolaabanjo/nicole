import Foundation

enum NicoleMessageRole: String, Codable {
  case system
  case user
  case assistant
}

struct NicoleMessage: Identifiable, Equatable {
  let id: String
  let role: NicoleMessageRole
  var content: String
  let createdAt: String?
  var isStreaming: Bool

  init(
    id: String = UUID().uuidString,
    role: NicoleMessageRole,
    content: String,
    createdAt: String? = nil,
    isStreaming: Bool = false
  ) {
    self.id = id
    self.role = role
    self.content = content
    self.createdAt = createdAt
    self.isStreaming = isStreaming
  }
}

struct RemoteNicoleMessage: Decodable {
  let id: String
  let role: String
  let content: String
  let createdAt: String?

  func toMessage() -> NicoleMessage {
    NicoleMessage(
      id: id,
      role: NicoleMessageRole(rawValue: role) ?? .assistant,
      content: content,
      createdAt: createdAt
    )
  }
}

struct NicoleWorkspaceContextPayload: Encodable {
  let surface: String
  let activeApp: String?
  let windowTitle: String?
  let selectedText: String?
  let clipboardText: String?
  let currentUrl: String?
  let currentFilePath: String?
  let visibleContent: String?
  let note: String?
}

struct NicoleChatRequestBody: Encodable {
  let message: String
  let context: NicoleWorkspaceContextPayload?
}
