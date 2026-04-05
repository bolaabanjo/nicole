import AVFoundation
import Foundation

actor WhisperTranscriber {
  static let shared = WhisperTranscriber()

  private let serverBaseURL: URL
  private let session: URLSession

  private init() {
    self.serverBaseURL = URL(string: "http://127.0.0.1:8200")!
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    self.session = URLSession(configuration: config)
  }

  struct TranscriptionResult: Sendable {
    let text: String
    let language: String?
  }

  func transcribe(audioData: Data, sampleRate: Double = 16000) async throws -> TranscriptionResult {
    let wavData = encodeWAV(pcmData: audioData, sampleRate: Int(sampleRate), channels: 1, bitsPerSample: 16)

    let boundary = UUID().uuidString
    let url = serverBaseURL.appendingPathComponent("inference")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

    var body = Data()

    // Audio file part
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
    body.append(wavData)
    body.append("\r\n".data(using: .utf8)!)

    // Temperature parameter
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"temperature\"\r\n\r\n".data(using: .utf8)!)
    body.append("0.0\r\n".data(using: .utf8)!)

    // Response format
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"response_format\"\r\n\r\n".data(using: .utf8)!)
    body.append("json\r\n".data(using: .utf8)!)

    body.append("--\(boundary)--\r\n".data(using: .utf8)!)

    request.httpBody = body

    let (data, response) = try await session.data(for: request)

    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
      throw WhisperError.serverError(statusCode: statusCode)
    }

    let decoded = try JSONDecoder().decode(WhisperResponse.self, from: data)
    let text = decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)

    return TranscriptionResult(text: text, language: decoded.language)
  }

  func isAvailable() async -> Bool {
    let url = serverBaseURL.appendingPathComponent("health")
    var request = URLRequest(url: url)
    request.timeoutInterval = 2

    do {
      let (_, response) = try await session.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }

  private func encodeWAV(pcmData: Data, sampleRate: Int, channels: Int, bitsPerSample: Int) -> Data {
    let byteRate = sampleRate * channels * bitsPerSample / 8
    let blockAlign = channels * bitsPerSample / 8
    let dataSize = pcmData.count
    let chunkSize = 36 + dataSize

    var wav = Data()

    // RIFF header
    wav.append("RIFF".data(using: .ascii)!)
    wav.append(withUnsafeBytes(of: UInt32(chunkSize).littleEndian) { Data($0) })
    wav.append("WAVE".data(using: .ascii)!)

    // fmt chunk
    wav.append("fmt ".data(using: .ascii)!)
    wav.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) })
    wav.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })  // PCM
    wav.append(withUnsafeBytes(of: UInt16(channels).littleEndian) { Data($0) })
    wav.append(withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Data($0) })
    wav.append(withUnsafeBytes(of: UInt32(byteRate).littleEndian) { Data($0) })
    wav.append(withUnsafeBytes(of: UInt16(blockAlign).littleEndian) { Data($0) })
    wav.append(withUnsafeBytes(of: UInt16(bitsPerSample).littleEndian) { Data($0) })

    // data chunk
    wav.append("data".data(using: .ascii)!)
    wav.append(withUnsafeBytes(of: UInt32(dataSize).littleEndian) { Data($0) })
    wav.append(pcmData)

    return wav
  }
}

enum WhisperError: LocalizedError {
  case serverError(statusCode: Int)
  case serverUnavailable

  var errorDescription: String? {
    switch self {
    case let .serverError(statusCode):
      return "Whisper server returned status \(statusCode)"
    case .serverUnavailable:
      return "Whisper server is not running on port 6100"
    }
  }
}

private struct WhisperResponse: Decodable {
  let text: String
  let language: String?
}
