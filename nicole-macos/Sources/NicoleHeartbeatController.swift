import AppKit
import UserNotifications

/// Polls Nicole's heartbeat endpoint and delivers proactive nudges
/// via macOS notifications and optional voice.
@MainActor
final class NicoleHeartbeatController: ObservableObject {
  struct Nudge: Decodable {
    let id: String
    let message: String
    let priority: String
    let speakable: Bool
    let timestamp: String
  }

  struct HeartbeatResponse: Decodable {
    let nudge: Nudge?
    let signalCount: Int?
    let skippedReason: String?
  }

  @Published private(set) var lastNudge: Nudge?
  @Published private(set) var lastCheckTime: Date?
  @Published private(set) var isRunning = false

  private let apiClient = NicoleAPIClient()
  private var pollTimer: Timer?
  private var deliveredNudgeIDs: Set<String> = []
  private let pollIntervalSeconds: TimeInterval = 300 // 5 minutes
  private weak var voiceController: NicoleVoiceController?
  private weak var settings: AppSettings?

  // MARK: - Lifecycle

  func start(
    settings: AppSettings,
    voiceController: NicoleVoiceController
  ) {
    self.settings = settings
    self.voiceController = voiceController

    guard !isRunning else { return }
    isRunning = true

    requestNotificationPermission()

    // Run first check after a short delay (let the app finish launching)
    pollTimer = Timer.scheduledTimer(
      withTimeInterval: pollIntervalSeconds,
      repeats: true
    ) { [weak self] _ in
      Task { @MainActor in
        await self?.runHeartbeatCheck()
      }
    }

    // Initial check after 30 seconds
    Task {
      try? await Task.sleep(for: .seconds(30))
      await runHeartbeatCheck()
    }
  }

  func stop() {
    pollTimer?.invalidate()
    pollTimer = nil
    isRunning = false
  }

  // MARK: - Heartbeat check

  private func runHeartbeatCheck() async {
    guard let settings else { return }

    let baseURL = settings.baseURLString
    guard !baseURL.isEmpty else { return }

    // Get the currently active app for screen time tracking
    let activeApp = NSWorkspace.shared.frontmostApplication?.localizedName

    do {
      let response = try await fetchHeartbeat(
        baseURLString: baseURL,
        activeApp: activeApp
      )

      lastCheckTime = Date()

      guard let nudge = response.nudge else { return }

      // Don't deliver the same nudge twice
      guard !deliveredNudgeIDs.contains(nudge.id) else { return }
      deliveredNudgeIDs.insert(nudge.id)

      // Keep the set from growing forever
      if deliveredNudgeIDs.count > 50 {
        deliveredNudgeIDs = Set(deliveredNudgeIDs.suffix(25))
      }

      lastNudge = nudge
      await deliverNudge(nudge)
    } catch {
      // Silent failure — heartbeat is best-effort
      #if DEBUG
      print("Heartbeat check failed: \(error.localizedDescription)")
      #endif
    }
  }

  // MARK: - Delivery

  private func deliverNudge(_ nudge: Nudge) async {
    // Always show a notification
    await showNotification(nudge)

    // Speak if voice mode is active and nudge is speakable
    if nudge.speakable, let settings, settings.voiceModeActive || settings.alwaysOnVoiceEnabled {
      speakNudge(nudge)
    }
  }

  private func showNotification(_ nudge: Nudge) async {
    let content = UNMutableNotificationContent()
    content.title = "Nicole"
    content.body = nudge.message
    content.sound = nudge.priority == "high" || nudge.priority == "urgent"
      ? .default
      : nil

    // Use a category for actionable notifications
    content.categoryIdentifier = "NICOLE_NUDGE"

    let request = UNNotificationRequest(
      identifier: "nicole-nudge-\(nudge.id)",
      content: content,
      trigger: nil // Deliver immediately
    )

    do {
      try await UNUserNotificationCenter.current().add(request)
    } catch {
      #if DEBUG
      print("Notification delivery failed: \(error.localizedDescription)")
      #endif
    }
  }

  private func speakNudge(_ nudge: Nudge) {
    voiceController?.stopSpeaking()
    let speaker = KokoroSpeaker.shared
    speaker.speak(text: nudge.message, onCompletion: nil)
  }

  // MARK: - Permissions

  private func requestNotificationPermission() {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { granted, error in
      #if DEBUG
      if let error {
        print("Notification permission error: \(error.localizedDescription)")
      } else if !granted {
        print("Notification permission denied")
      }
      #endif
    }
  }

  // MARK: - API

  private func fetchHeartbeat(
    baseURLString: String,
    activeApp: String?
  ) async throws -> HeartbeatResponse {
    guard let baseURL = normalizedBaseURL(from: baseURLString) else {
      throw URLError(.badURL)
    }

    var components = URLComponents(url: baseURL.appending(path: "api/nicole/heartbeat"), resolvingAgainstBaseURL: false)!

    if let activeApp, !activeApp.isEmpty {
      components.queryItems = [URLQueryItem(name: "activeApp", value: activeApp)]
    }

    guard let url = components.url else {
      throw URLError(.badURL)
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 30

    let (data, response) = try await URLSession.shared.data(for: request)

    guard let httpResponse = response as? HTTPURLResponse,
          (200...299).contains(httpResponse.statusCode) else {
      throw URLError(.badServerResponse)
    }

    return try JSONDecoder().decode(HeartbeatResponse.self, from: data)
  }

  private func normalizedBaseURL(from rawValue: String) -> URL? {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
      return nil
    }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url
  }
}
