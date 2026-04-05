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

  func fetchHistory(
    baseURLString: String,
    credentials: TrustedDeviceCredentials? = nil
  ) async throws -> [NicoleMessage] {
    let request = try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/history",
      method: "GET",
      credentials: credentials
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
    credentials: TrustedDeviceCredentials? = nil,
    onChunk: @escaping @Sendable (String) async -> Void
  ) async throws {
    let body = NicoleChatRequestBody(message: message, context: context)
    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/stream",
      body: body,
      credentials: credentials
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

  func ingestFile(
    baseURLString: String,
    fileURL: URL,
    credentials: TrustedDeviceCredentials? = nil
  ) async throws -> NicoleIngestResult {
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
        method: "POST",
        credentials: credentials
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
        method: "POST",
        credentials: credentials
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

  func registerTrustedDevice(
    baseURLString: String,
    pairingCode: String,
    deviceName: String
  ) async throws -> TrustedDeviceCredentials {
    struct RequestBody: Encodable {
      let pairingCode: String
      let deviceName: String
      let platform: String
    }

    let request = try makeJSONRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/devices/register",
      body: RequestBody(
        pairingCode: pairingCode,
        deviceName: deviceName,
        platform: "ios"
      ),
      credentials: nil
    )

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data, requestURL: request.url?.absoluteString)
    return try JSONDecoder().decode(TrustedDeviceCredentials.self, from: data)
  }

  func validateTrustedDevice(
    baseURLString: String,
    credentials: TrustedDeviceCredentials
  ) async throws -> TrustedDeviceValidationResponse {
    let request = try makeRequest(
      baseURLString: baseURLString,
      path: "/api/nicole/devices/validate",
      method: "GET",
      credentials: credentials
    )

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data, requestURL: request.url?.absoluteString)
    return try JSONDecoder().decode(TrustedDeviceValidationResponse.self, from: data)
  }

  private func makeJSONRequest<Body: Encodable>(
    baseURLString: String,
    path: String,
    body: Body,
    credentials: TrustedDeviceCredentials? = nil
  ) throws -> URLRequest {
    var request = try makeRequest(
      baseURLString: baseURLString,
      path: path,
      method: "POST",
      credentials: credentials
    )
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    return request
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
    method: String,
    credentials: TrustedDeviceCredentials? = nil
  ) throws -> URLRequest {
    guard let baseURL = normalizedBaseURL(from: baseURLString) else {
      throw NicoleAPIError.invalidBaseURL
    }

    let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
    let url = baseURL.appendingPathComponent(normalizedPath)

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 90
    applyTrustedDeviceHeaders(to: &request, credentials: credentials)
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

  private func applyTrustedDeviceHeaders(
    to request: inout URLRequest,
    credentials: TrustedDeviceCredentials?
  ) {
    request.setValue("ios", forHTTPHeaderField: "x-nicole-client-surface")

    guard let credentials else { return }

    request.setValue(credentials.deviceId, forHTTPHeaderField: "x-nicole-device-id")
    request.setValue(credentials.deviceToken, forHTTPHeaderField: "x-nicole-device-token")
  }
}
