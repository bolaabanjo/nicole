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

  func streamReply(
    baseURLString: String,
    message: String,
    context: NicoleWorkspaceContextPayload?,
    onChunk: @escaping @Sendable (String) async -> Void
  ) async throws {
    let body = NicoleChatRequestBody(message: message, context: context)
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
