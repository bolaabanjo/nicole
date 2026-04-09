import Foundation

enum NicoleAPIError: LocalizedError {
  case invalidBaseURL
  case server(String, url: String?)
  case invalidResponse

  var errorDescription: String? {
    switch self {
    case .invalidBaseURL:
      return "The backend URL looks invalid."
    case let .server(message, url):
      if let url, !url.isEmpty {
        return "\(message) (\(url))"
      }
      return message
    case .invalidResponse:
      return "Nicole returned an unexpected response."
    }
  }
}

actor NicoleAPIClient {
  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  func fetchHistory(baseURLString: String) async throws -> [NicoleMessage] {
    let request = try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/history",
      method: "GET"
    )

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data, requestURL: request.url?.absoluteString)

    let decoder = JSONDecoder()
    let remoteMessages = try decoder.decode([RemoteNicoleMessage].self, from: data)
    return remoteMessages.map { $0.toMessage() }
  }

  func normalizedOriginString(baseURLString: String) -> String? {
    normalizedBaseURL(from: baseURLString)?.absoluteString
  }

  func historyURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/history",
      method: "GET"
    ).url?.absoluteString ?? ""
  }

  func streamURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/stream",
      method: "POST"
    ).url?.absoluteString ?? ""
  }

  func voiceURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice",
      method: "POST"
    ).url?.absoluteString ?? ""
  }

  func voicePrepareURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice/prepare",
      method: "POST"
    ).url?.absoluteString ?? ""
  }

  func voiceWarmURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice/warm",
      method: "POST"
    ).url?.absoluteString ?? ""
  }

  func warmVoiceRuntime(
    baseURLString: String,
    sessionId: String? = nil,
    surface: String? = nil,
    context: NicoleWorkspaceContextPayload? = nil
  ) async throws {
    let body = NicoleVoiceWarmRequestBody(
      sessionId: sessionId,
      surface: surface,
      context: context
    )
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice/warm",
      body: body
    )

    let (_, response) = try await session.data(for: request)
    try validate(response: response, data: nil, requestURL: request.url?.absoluteString)
  }

  func prepareVoiceTurn(
    baseURLString: String,
    transcript: String,
    sessionId: String? = nil,
    surface: String? = nil,
    isFinal: Bool,
    voiceTurnId: String? = nil,
    interruptedVoiceTurnId: String? = nil,
    context: NicoleWorkspaceContextPayload? = nil
  ) async throws -> NicoleVoicePreparedTurn {
    let body = NicoleVoicePrepareRequestBody(
      transcript: transcript,
      sessionId: sessionId,
      surface: surface,
      isFinal: isFinal,
      voiceTurnId: voiceTurnId,
      interruptedVoiceTurnId: interruptedVoiceTurnId,
      context: context
    )
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice/prepare",
      body: body
    )

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data, requestURL: request.url?.absoluteString)
    return try JSONDecoder().decode(NicoleVoicePreparedTurn.self, from: data)
  }

  func streamVoiceReplyEvents(
    baseURLString: String,
    message: String,
    context: NicoleWorkspaceContextPayload? = nil,
    sessionId: String? = nil,
    surface: String? = nil,
    voiceTurnId: String? = nil,
    interruptedVoiceTurnId: String? = nil,
    onEvent: @escaping @Sendable (NicoleStreamEventEnvelope) async -> Void
  ) async throws {
    let body = NicoleVoiceRequestBody(
      message: message,
      sessionId: sessionId,
      surface: surface,
      voiceTurnId: voiceTurnId,
      interruptedVoiceTurnId: interruptedVoiceTurnId,
      context: context
    )
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/voice",
      body: body
    )

    let (bytes, response) = try await session.bytes(for: request)
    try validate(response: response, data: nil, requestURL: request.url?.absoluteString)
    try await streamEventLines(bytes: bytes, onEvent: onEvent)
  }

  func ingestURLString(baseURLString: String) throws -> String {
    try makeRequest(
      baseURLString: baseURLString,
      path: "/api/ingest",
      method: "POST"
    ).url?.absoluteString ?? ""
  }

  func streamReply(
    baseURLString: String,
    message: String,
    context: NicoleWorkspaceContextPayload?,
    sessionId: String? = nil,
    voice: Bool = false,
    onChunk: @escaping @Sendable (String) async -> Void
  ) async throws {
    let body = NicoleChatRequestBody(
      message: message,
      context: context,
      sessionId: sessionId,
      voice: voice ? true : nil,
      eventStream: nil
    )
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/stream",
      body: body
    )

    let (bytes, response) = try await session.bytes(for: request)
    try validate(response: response, data: nil, requestURL: request.url?.absoluteString)

    var buffer = Data()

    for try await byte in bytes {
      buffer.append(byte)

      if let fragment = String(data: buffer, encoding: .utf8), !fragment.isEmpty {
        await onChunk(fragment)
        buffer.removeAll(keepingCapacity: true)
      }
    }

    if !buffer.isEmpty {
      let fragment = String(decoding: buffer, as: UTF8.self)
      if !fragment.isEmpty {
        await onChunk(fragment)
      }
    }
  }

  func streamReplyEvents(
    baseURLString: String,
    message: String,
    context: NicoleWorkspaceContextPayload?,
    sessionId: String? = nil,
    onEvent: @escaping @Sendable (NicoleStreamEventEnvelope) async -> Void
  ) async throws {
    let body = NicoleChatRequestBody(
      message: message,
      context: context,
      sessionId: sessionId,
      voice: nil,
      eventStream: true
    )
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/stream",
      body: body
    )

    let (bytes, response) = try await session.bytes(for: request)
    try validate(response: response, data: nil, requestURL: request.url?.absoluteString)
    try await streamEventLines(bytes: bytes, onEvent: onEvent)
  }

  func analyzeVision(
    baseURLString: String,
    imageBase64: String,
    question: String?
  ) async throws -> NicoleVisionAnalysis {
    let body = NicoleVisionRequestBody(image: imageBase64, question: question)
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/vision",
      body: body
    )

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data, requestURL: request.url?.absoluteString)

    return try JSONDecoder().decode(NicoleVisionAnalysisResponse.self, from: data).analysis
  }

  func ingestFile(baseURLString: String, fileURL: URL) async throws -> NicoleIngestResult {
    let fileExtension = fileURL.pathExtension.lowercased()
    let title = fileURL.deletingPathExtension().lastPathComponent

    switch fileExtension {
    case "pdf":
      let fileData = try Data(contentsOf: fileURL)
      let multipart = makeMultipartBody(
        fields: [
          ("type", "pdf"),
          ("title", title),
        ],
        fileField: (
          name: "file",
          filename: fileURL.lastPathComponent,
          mimeType: "application/pdf",
          data: fileData
        )
      )

      var request = try makeRequest(
        baseURLString: baseURLString,
        path: "/api/ingest",
        method: "POST"
      )
      request.setValue(
        "multipart/form-data; boundary=\(multipart.boundary)",
        forHTTPHeaderField: "Content-Type"
      )
      request.httpBody = multipart.data

      let (data, response) = try await session.data(for: request)
      try validate(response: response, data: data, requestURL: request.url?.absoluteString)
      return try JSONDecoder().decode(NicoleIngestResult.self, from: data)

    case "txt", "md", "markdown":
      let content = try String(contentsOf: fileURL, encoding: .utf8)
      let multipart = makeMultipartBody(
        fields: [
          ("type", "note"),
          ("title", title),
          ("content", content),
        ]
      )

      var request = try makeRequest(
        baseURLString: baseURLString,
        path: "/api/ingest",
        method: "POST"
      )
      request.setValue(
        "multipart/form-data; boundary=\(multipart.boundary)",
        forHTTPHeaderField: "Content-Type"
      )
      request.httpBody = multipart.data

      let (data, response) = try await session.data(for: request)
      try validate(response: response, data: data, requestURL: request.url?.absoluteString)
      return try JSONDecoder().decode(NicoleIngestResult.self, from: data)

    default:
      throw NicoleAPIError.server(
        "Unsupported file type. Right now Nicole can ingest PDF, TXT, and Markdown files from the Mac app.",
        url: try? ingestURLString(baseURLString: baseURLString)
      )
    }
  }

  private func makeJSONRequest<Body: Encodable>(
    baseURLString: String,
    path: String,
    body: Body
  ) throws -> URLRequest {
    var request = try makeRequest(
      baseURLString: baseURLString,
      path: path,
      method: "POST"
    )
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    return request
  }

  private func streamEventLines(
    bytes: URLSession.AsyncBytes,
    onEvent: @escaping @Sendable (NicoleStreamEventEnvelope) async -> Void
  ) async throws {
    let decoder = JSONDecoder()

    for try await line in bytes.lines {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }
      guard let data = trimmed.data(using: .utf8) else { continue }

      do {
        let event = try decoder.decode(NicoleStreamEventEnvelope.self, from: data)
        await onEvent(event)
      } catch {
        let fallback = NicoleStreamEventEnvelope(type: .textDelta, text: trimmed, metric: nil)
        await onEvent(fallback)
      }
    }
  }

  private func makeMultipartBody(
    fields: [(String, String)],
    fileField: (name: String, filename: String, mimeType: String, data: Data)? = nil
  ) -> (boundary: String, data: Data) {
    let boundary = "Boundary-\(UUID().uuidString)"
    var body = Data()

    for (name, value) in fields {
      body.append("--\(boundary)\r\n".data(using: .utf8)!)
      body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
      body.append("\(value)\r\n".data(using: .utf8)!)
    }

    if let fileField {
      body.append("--\(boundary)\r\n".data(using: .utf8)!)
      body.append(
        "Content-Disposition: form-data; name=\"\(fileField.name)\"; filename=\"\(fileField.filename)\"\r\n"
          .data(using: .utf8)!
      )
      body.append("Content-Type: \(fileField.mimeType)\r\n\r\n".data(using: .utf8)!)
      body.append(fileField.data)
      body.append("\r\n".data(using: .utf8)!)
    }

    body.append("--\(boundary)--\r\n".data(using: .utf8)!)
    return (boundary, body)
  }

  private func makeRequest(
    baseURLString: String,
    path: String,
  method: String
  ) throws -> URLRequest {
    guard let baseURL = normalizedBaseURL(from: baseURLString) else {
      throw NicoleAPIError.invalidBaseURL
    }

    let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
    let url = baseURL.appending(path: normalizedPath)

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 90
    request.setValue("macos", forHTTPHeaderField: "x-nicole-client-surface")
    return request
  }

  private func normalizedBaseURL(from rawValue: String) -> URL? {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
      return nil
    }

    // The native client always talks to Nicole at the backend origin root.
    // If someone pastes a full page or route URL here, strip it back to scheme + host + port.
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url
  }

  private func validate(
    response: URLResponse,
    data: Data?,
    requestURL: String? = nil
  ) throws {
    guard let httpResponse = response as? HTTPURLResponse else {
      throw NicoleAPIError.invalidResponse
    }

    guard (200 ... 299).contains(httpResponse.statusCode) else {
      if
        let data,
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let error = payload["error"] as? String
      {
        throw NicoleAPIError.server(error, url: requestURL)
      }

      throw NicoleAPIError.server(
        "Nicole returned status \(httpResponse.statusCode).",
        url: requestURL
      )
    }
  }
}
