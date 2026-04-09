import Foundation

enum NicoleMessageRole: String, Codable, Sendable {
  case system
  case user
  case assistant
}

struct NicoleMessage: Identifiable, Equatable, Sendable {
  let id: String
  let role: NicoleMessageRole
  var content: String
  let createdAt: String?
  var isStreaming: Bool
  var thoughtContent: String?
  var isThoughtOpen: Bool
  var thoughtDuration: Int?
  var preActionText: String?
  var liveStatusText: String?
  var activityItems: [NicoleActivityItem]

  init(
    id: String = UUID().uuidString,
    role: NicoleMessageRole,
    content: String,
    createdAt: String? = nil,
    isStreaming: Bool = false,
    thoughtContent: String? = nil,
    isThoughtOpen: Bool = false,
    thoughtDuration: Int? = nil,
    preActionText: String? = nil,
    liveStatusText: String? = nil,
    activityItems: [NicoleActivityItem] = []
  ) {
    self.id = id
    self.role = role
    self.content = content
    self.createdAt = createdAt
    self.isStreaming = isStreaming
    self.thoughtContent = thoughtContent
    self.isThoughtOpen = isThoughtOpen
    self.thoughtDuration = thoughtDuration
    self.preActionText = preActionText
    self.liveStatusText = liveStatusText
    self.activityItems = activityItems
  }
}

struct NicoleActivityItem: Identifiable, Equatable, Sendable {
  let id: String
  let text: String

  init(id: String = UUID().uuidString, text: String) {
    self.id = id
    self.text = text
  }
}

struct RemoteNicoleMessage: Decodable, Sendable {
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

struct NicoleWorkspaceContextPayload: Encodable, Sendable {
  let surface: String
  let activeApp: String?
  let windowTitle: String?
  let selectedText: String?
  let clipboardText: String?
  let currentUrl: String?
  let currentFilePath: String?
  let visibleContent: String?
  let visualSummary: String?
  let visualElements: [String]?
  let visualIssues: [String]?
  let visualConfidence: String?
  let captureNotes: String?
  let note: String?

  init(
    surface: String,
    activeApp: String?,
    windowTitle: String?,
    selectedText: String?,
    clipboardText: String?,
    currentUrl: String?,
    currentFilePath: String?,
    visibleContent: String?,
    visualSummary: String? = nil,
    visualElements: [String]? = nil,
    visualIssues: [String]? = nil,
    visualConfidence: String? = nil,
    captureNotes: String? = nil,
    note: String?
  ) {
    self.surface = surface
    self.activeApp = activeApp
    self.windowTitle = windowTitle
    self.selectedText = selectedText
    self.clipboardText = clipboardText
    self.currentUrl = currentUrl
    self.currentFilePath = currentFilePath
    self.visibleContent = visibleContent
    self.visualSummary = visualSummary
    self.visualElements = visualElements
    self.visualIssues = visualIssues
    self.visualConfidence = visualConfidence
    self.captureNotes = captureNotes
    self.note = note
  }
}

extension NicoleWorkspaceContextPayload {
  var hasMeaningfulWorkspaceContext: Bool {
    activeApp != nil ||
      windowTitle != nil ||
      selectedText != nil ||
      clipboardText != nil ||
      currentUrl != nil ||
      currentFilePath != nil ||
      visibleContent != nil ||
      visualSummary != nil ||
      visualElements != nil ||
      visualIssues != nil
  }

  var summaryTitle: String {
    if let activeApp, !activeApp.isEmpty {
      return activeApp
    }

    return "Current workspace"
  }

  var summaryDetail: String? {
    if let windowTitle, !windowTitle.isEmpty {
      return windowTitle
    }

    if let currentUrl, !currentUrl.isEmpty {
      return currentUrl
    }

    if let currentFilePath, !currentFilePath.isEmpty {
      return currentFilePath
    }

    return nil
  }

  var selectedTextPreview: String? {
    let preview = selectedText ?? clipboardText
    guard let preview, !preview.isEmpty else { return nil }

    let collapsed = preview.replacingOccurrences(
      of: "\\s+",
      with: " ",
      options: .regularExpression
    )

    if collapsed.count <= 140 {
      return collapsed
    }

    return String(collapsed.prefix(140)) + "…"
  }
}

struct NicoleChatRequestBody: Encodable, Sendable {
  let message: String
  let context: NicoleWorkspaceContextPayload?
  let sessionId: String?
  var voice: Bool?
  var eventStream: Bool?
}

struct NicoleVoiceRequestBody: Encodable, Sendable {
  let message: String
  let sessionId: String?
  let surface: String?
  let voiceTurnId: String?
  let interruptedVoiceTurnId: String?
  let context: NicoleWorkspaceContextPayload?
}

struct NicoleVoicePrepareRequestBody: Encodable, Sendable {
  let transcript: String
  let sessionId: String?
  let surface: String?
  let isFinal: Bool
  let voiceTurnId: String?
  let interruptedVoiceTurnId: String?
  let context: NicoleWorkspaceContextPayload?
}

struct NicoleVoiceWarmRequestBody: Encodable, Sendable {
  let sessionId: String?
  let surface: String?
  let context: NicoleWorkspaceContextPayload?
}

struct NicoleVoicePreparedTurn: Decodable, Equatable, Sendable {
  let voiceTurnId: String
  let intentClass: String
  let topicKind: String?
  let ackPolicy: String
  let deterministicMode: Bool
  let preActionText: String?
  let statusText: String?
  let toolPlan: [String]
  let replyToTurnId: String?
  let groundedArtifactIds: [String]
  let interruptedByTurnId: String?
  let isFinal: Bool
  let latency: NicoleVoicePrepareLatency?
}

struct NicoleVoicePrepareLatency: Codable, Equatable, Sendable {
  let totalMilliseconds: Double
  let authMilliseconds: Double
  let contextMilliseconds: Double
  let planMilliseconds: Double
}

struct NicoleLatencyMetric: Codable, Equatable, Sendable {
  let key: String
  let milliseconds: Double
  let sinceStartMilliseconds: Double?
  let detail: String?
}

struct NicoleVisionRequestBody: Encodable, Sendable {
  let image: String
  let question: String?
}

struct NicoleVisionAnalysis: Codable, Equatable, Sendable {
  let summary: String
  let visibleText: String?
  let appOrSurface: String?
  let importantElements: [String]
  let possibleIssues: [String]
  let confidence: String?
  let captureNotes: String?
}

struct NicoleVisionAnalysisResponse: Decodable, Sendable {
  let analysis: NicoleVisionAnalysis
}

enum NicoleStreamEventType: String, Decodable, Sendable {
  case preface
  case status
  case tool
  case activity
  case latency
  case text
  case textDelta = "text_delta"
  case speechBoundary = "speech_boundary"
  case done
  case error
}

struct NicoleStreamEventEnvelope: Decodable, Sendable {
  let type: NicoleStreamEventType
  let text: String
  let metric: NicoleLatencyMetric?
}

struct NicoleIngestResult: Decodable, Sendable {
  let sourceId: String
  let title: String
  let chunkCount: Int
  let embeddingsGenerated: Bool
}
