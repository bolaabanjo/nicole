import Foundation

actor LocalVisionAnalyzer {
  static let shared = LocalVisionAnalyzer()

  private let session: URLSession
  private let baseURL: URL?
  private let keepAlive: String
  private var cachedModelName: String?

  private init(session: URLSession = .shared) {
    self.session = session

    let environment = ProcessInfo.processInfo.environment
    let rawBaseURL =
      environment["NICOLE_LOCAL_OLLAMA_BASE_URL"] ??
      environment["OLLAMA_BASE_URL"] ??
      "http://127.0.0.1:11434"
    self.baseURL = URL(string: rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines))
    self.keepAlive = environment["OLLAMA_KEEP_ALIVE"] ?? "30m"
    self.cachedModelName = environment["NICOLE_LOCAL_VISION_MODEL"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func analyzeScreen(
    imageBase64: String,
    question: String,
    contextHint: NicoleWorkspaceContextPayload?
  ) async -> NicoleVisionAnalysis? {
    guard let baseURL else { return nil }

    do {
      let modelName = try await resolveVisionModel(baseURL: baseURL)
      let request = try makeAnalyzeRequest(
        baseURL: baseURL,
        modelName: modelName,
        imageBase64: imageBase64,
        question: question,
        contextHint: contextHint
      )

      let (data, response) = try await session.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse, (200 ... 299).contains(httpResponse.statusCode) else {
        return nil
      }

      guard
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let message = payload["message"] as? [String: Any],
        let content = message["content"] as? String
      else {
        return nil
      }

      return decodeVisionAnalysis(from: content)
    } catch {
      return nil
    }
  }

  private func resolveVisionModel(baseURL: URL) async throws -> String {
    if let cachedModelName, !cachedModelName.isEmpty {
      return cachedModelName
    }

    let tagsURL = baseURL.appending(path: "api/tags")
    let (data, response) = try await session.data(from: tagsURL)
    guard let httpResponse = response as? HTTPURLResponse, (200 ... 299).contains(httpResponse.statusCode) else {
      throw LocalVisionAnalyzerError.noVisionModel
    }

    guard
      let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let models = payload["models"] as? [[String: Any]]
    else {
      throw LocalVisionAnalyzerError.noVisionModel
    }

    let names = models.compactMap { ($0["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }

    let preferredPrefixes = [
      "gemma4",
      "qwen2.5vl",
      "qwen3-vl",
      "llava",
      "bakllava",
      "moondream",
    ]

    for prefix in preferredPrefixes {
      if let match = names.first(where: { $0.lowercased().contains(prefix) }) {
        cachedModelName = match
        return match
      }
    }

    throw LocalVisionAnalyzerError.noVisionModel
  }

  private func makeAnalyzeRequest(
    baseURL: URL,
    modelName: String,
    imageBase64: String,
    question: String,
    contextHint: NicoleWorkspaceContextPayload?
  ) throws -> URLRequest {
    let systemPrompt = """
    You are Nicole's local vision subsystem. Analyze a screenshot from Roy's Mac.

    Respond with JSON only. No markdown. No prose before or after the JSON.

    Required JSON shape:
    {
      "summary": "one short sentence about what is on screen",
      "visibleText": "important visible text relevant to the question, or null",
      "appOrSurface": "the app or surface shown, or null",
      "importantElements": ["short bullet-like element", "another"],
      "possibleIssues": ["likely issue if any"],
      "confidence": "high | medium | low",
      "captureNotes": "brief note about uncertainty, occlusion, or readability"
    }

    Keep fields concise. Avoid personality, relationship language, and assistant-style filler.
    """

    let metadataHint = makeMetadataHint(from: contextHint)
    let userPrompt = """
    User question: \(question)

    Metadata hint:
    \(metadataHint)

    Analyze the screenshot and answer using the JSON shape only.
    """

    let body: [String: Any] = [
      "model": modelName,
      "messages": [
        [
          "role": "system",
          "content": systemPrompt,
        ],
        [
          "role": "user",
          "content": userPrompt,
          "images": [imageBase64],
        ],
      ],
      "stream": false,
      "think": false,
      "keep_alive": keepAlive,
    ]

    var request = URLRequest(url: baseURL.appending(path: "api/chat"))
    request.httpMethod = "POST"
    request.timeoutInterval = 90
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    return request
  }

  private func makeMetadataHint(from contextHint: NicoleWorkspaceContextPayload?) -> String {
    guard let contextHint else {
      return "No metadata hint available."
    }

    let lines = [
      contextHint.activeApp.map { "Active app: \($0)" },
      contextHint.windowTitle.map { "Window title: \($0)" },
      contextHint.currentUrl.map { "Current URL: \($0)" },
      contextHint.currentFilePath.map { "Current file path: \($0)" },
      contextHint.selectedText.map { "Selected text: \($0)" },
    ].compactMap { $0 }

    return lines.isEmpty ? "No metadata hint available." : lines.joined(separator: "\n")
  }

  private func decodeVisionAnalysis(from raw: String) -> NicoleVisionAnalysis {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)

    if let direct = decodeVisionAnalysisObject(from: trimmed) {
      return direct
    }

    if
      let openBrace = trimmed.firstIndex(of: "{"),
      let closeBrace = trimmed.lastIndex(of: "}"),
      openBrace <= closeBrace
    {
      let candidate = String(trimmed[openBrace ... closeBrace])
      if let extracted = decodeVisionAnalysisObject(from: candidate) {
        return extracted
      }
    }

    return NicoleVisionAnalysis(
      summary: trimmed.isEmpty ? "The screen is visible, but the local vision read was incomplete." : trimmed,
      visibleText: nil,
      appOrSurface: nil,
      importantElements: [],
      possibleIssues: [],
      confidence: "low",
      captureNotes: "The local vision model returned an unstructured answer."
    )
  }

  private func decodeVisionAnalysisObject(from jsonString: String) -> NicoleVisionAnalysis? {
    guard
      let data = jsonString.data(using: .utf8),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return nil
    }

    let summary = (payload["summary"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let visibleText = (payload["visibleText"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let appOrSurface = (payload["appOrSurface"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let importantElements = (payload["importantElements"] as? [String] ?? [])
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let possibleIssues = (payload["possibleIssues"] as? [String] ?? [])
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let confidence = (payload["confidence"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let captureNotes = (payload["captureNotes"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard let summary, !summary.isEmpty else {
      return nil
    }

    return NicoleVisionAnalysis(
      summary: summary,
      visibleText: visibleText?.isEmpty == false ? visibleText : nil,
      appOrSurface: appOrSurface?.isEmpty == false ? appOrSurface : nil,
      importantElements: importantElements,
      possibleIssues: possibleIssues,
      confidence: confidence?.isEmpty == false ? confidence : nil,
      captureNotes: captureNotes?.isEmpty == false ? captureNotes : nil
    )
  }
}

enum LocalVisionAnalyzerError: Error {
  case noVisionModel
}
