import AppKit
import Carbon.HIToolbox
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var hotKeyRef: EventHotKeyRef?
  private var hotKeyHandler: EventHandlerRef?
  private static let summonHotKeyID: UInt32 = 1
  private let wakeWordController = NicoleWakeWordController()
  private var settingsCancellable: AnyCancellable?
  weak var settings: AppSettings?
  weak var viewModel: ChatViewModel?
  weak var voiceController: NicoleVoiceController?
  weak var heartbeatController: NicoleHeartbeatController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    installGlobalHotKey()
    ScreenCapturePermissionManager.requestOnLaunch()
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let hotKeyRef {
      UnregisterEventHotKey(hotKeyRef)
    }

    if let hotKeyHandler {
      RemoveEventHandler(hotKeyHandler)
    }

    settingsCancellable?.cancel()
    wakeWordController.stop()
    heartbeatController?.stop()
  }

  func configure(
    settings: AppSettings,
    viewModel: ChatViewModel,
    voiceController: NicoleVoiceController,
    heartbeatController: NicoleHeartbeatController
  ) {
    self.settings = settings
    self.viewModel = viewModel
    self.voiceController = voiceController
    self.heartbeatController = heartbeatController
    viewModel.attachVoiceController(voiceController)

    // Start the heartbeat — Nicole checks in proactively
    heartbeatController.start(settings: settings, voiceController: voiceController)

    settingsCancellable?.cancel()
    settingsCancellable = settings.$alwaysOnVoiceEnabled
      .removeDuplicates()
      .sink { [weak self] enabled in
        Task { @MainActor in
          await self?.setAlwaysOnVoiceEnabled(enabled)
        }
      }

    Task { @MainActor in
      await setAlwaysOnVoiceEnabled(settings.alwaysOnVoiceEnabled)
    }
  }

  func toggleNicolePanel() {
    Task { @MainActor in
      await WorkspaceContextProvider.captureExternalContext()
      CompactWindowManager.shared.togglePanel()

      // Update context indicator after capture
      if CompactWindowManager.shared.isPanelVisible {
        CompactWindowManager.shared.panelState.refreshContextLabel()
      }
    }
  }

  private func setAlwaysOnVoiceEnabled(_ enabled: Bool) async {
    guard settings != nil else { return }

    if enabled {
      wakeWordController.start { [weak self] detectedCommand in
        guard let self else { return }
        Task { @MainActor in
          await self.handleWakeWordDetection(initialCommand: detectedCommand)
        }
      }
    } else {
      wakeWordController.stop()
    }
  }

  /// Acknowledgments Nicole says when summoned. Shuffled so she doesn't repeat.
  private var wakeAcknowledgmentQueue: [String] = []

  private static let allAcknowledgments = [
    // Casual
    "Yes, Roy?",
    "Hey, what's up?",
    "Yeah?",
    "What's good?",
    "Hmm?",
    "I'm here.",
    "Go ahead.",
    "What do you need?",
    "Talk to me.",
    // Playful
    "You called?",
    "At your service.",
    "I was just thinking about something, but go ahead.",
    "Perfect timing.",
    "What's on your mind?",
    "I'm all ears.",
    // Warm
    "Hey Roy.",
    "I'm listening.",
    "Right here.",
    "What can I do for you?",
  ]

  private func nextAcknowledgment() -> String {
    if wakeAcknowledgmentQueue.isEmpty {
      wakeAcknowledgmentQueue = Self.allAcknowledgments.shuffled()
    }
    return wakeAcknowledgmentQueue.removeFirst()
  }

  private func handleWakeWordDetection(initialCommand: NicoleWakeWordController.Detection) async {
    guard let settings, let viewModel, let voiceController else { return }

    // Auto-switch to voice mode on wake word and bring window forward
    if !settings.voiceModeActive {
      settings.voiceModeActive = true
    }
    NSApp.activate(ignoringOtherApps: true)

    voiceController.stopSpeaking()
    voiceController.stopListeningIfActive(on: .expanded)
    voiceController.stopListeningIfActive(on: .compact)

    switch initialCommand {
    case .command(let command):
      let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmedCommand.isEmpty else {
        await resumeWakeWordListeningIfNeeded()
        return
      }
      await sendAmbientVoiceCommand(trimmedCommand, settings: settings, viewModel: viewModel, voiceController: voiceController)
      return
    case .wakeOnly:
      break
    }

    // Nicole acknowledges she heard the wake word before listening
    let ack = nextAcknowledgment()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      KokoroSpeaker.shared.speak(text: ack) {
        continuation.resume()
      }
    }

    voiceController.startAmbientCapture { [weak self] transcript in
      guard let self else { return }

      Task { @MainActor in
        let trimmedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTranscript.isEmpty else {
          await self.resumeWakeWordListeningIfNeeded()
          return
        }

        await self.sendAmbientVoiceCommand(
          trimmedTranscript,
          settings: settings,
          viewModel: viewModel,
          voiceController: voiceController
        )
      }
    }
  }

  // MARK: - Voice status phrases (spoken while tools execute)

  /// Lightweight intent detection for voice — determines if a tool will run
  /// and what status phrase to speak while waiting.
  private static func voiceStatusPhrase(for message: String) -> String? {
    let lower = message.lowercased()

    // Web search
    if lower.hasPrefix("who is ") || lower.hasPrefix("who are ") ||
       lower.hasPrefix("what is ") || lower.hasPrefix("what are ") ||
       lower.hasPrefix("where is ") || lower.hasPrefix("when is ") ||
       lower.hasPrefix("tell me about ") || lower.hasPrefix("what do you know about ") ||
       lower.contains("search") || lower.contains("look up") || lower.contains("google") {
      return [
        "Let me look that up.",
        "One sec, searching now.",
        "Let me find that for you.",
        "Searching...",
        "Hold on, let me check.",
      ].randomElement()!
    }

    // Calendar
    if lower.contains("calendar") || lower.contains("schedule") || lower.contains("meeting") ||
       lower.contains("am i free") || lower.contains("what do i have") {
      return [
        "Let me check your calendar.",
        "Checking your schedule.",
        "One sec, pulling up your calendar.",
      ].randomElement()!
    }

    // Reminders
    if lower.contains("remind me") || lower.contains("set a reminder") || lower.contains("reminder") {
      return [
        "Setting that up for you.",
        "On it.",
        "Got it, one moment.",
      ].randomElement()!
    }

    // Email
    if lower.contains("email") || lower.contains("inbox") || lower.contains("send") {
      return [
        "Let me check on that.",
        "One moment.",
      ].randomElement()!
    }

    // Sources / notes
    if lower.contains("notes") || lower.contains("pdf") || lower.contains("document") ||
       lower.contains("source") || lower.contains("paper") {
      return [
        "Let me check your notes.",
        "Looking through your sources.",
        "One sec.",
      ].randomElement()!
    }

    // Current info keywords
    if lower.contains("latest") || lower.contains("news") || lower.contains("today") ||
       lower.contains("weather") || lower.contains("price") || lower.contains("score") ||
       lower.contains("update") || lower.contains("recent") {
      return [
        "Let me check on that.",
        "One sec, looking that up.",
        "Searching for the latest info.",
      ].randomElement()!
    }

    // Long questions probably need processing time
    if lower.hasSuffix("?") && lower.count > 30 {
      return [
        "Let me think about that.",
        "Good question, give me a second.",
        "Hmm, let me think.",
      ].randomElement()!
    }

    // Short/casual — no status needed, response will be fast
    return nil
  }

  private static let visionTriggers = [
    "look at", "what's on my screen", "what do you see", "what is this",
    "what's this", "read this", "read my screen", "what am i looking at",
    "explain this", "explain what", "what's wrong", "check this",
    "see my screen", "look at my screen", "what does this say",
    "can you see", "do you see", "screen",
  ]

  private static func isVisionRequest(_ text: String) -> Bool {
    let lower = text.lowercased()
    return visionTriggers.contains(where: { lower.contains($0) })
  }

  private func sendAmbientVoiceCommand(
    _ command: String,
    settings: AppSettings,
    viewModel: ChatViewModel,
    voiceController: NicoleVoiceController
  ) async {
    // Check if this command will trigger tools — if so, speak a status phrase
    // while the server processes (runs in parallel with the server request)
    if let statusPhrase = Self.voiceStatusPhrase(for: command) {
      // Speak the status phrase and wait for it to finish before starting streaming TTS
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        KokoroSpeaker.shared.speak(text: statusPhrase) {
          continuation.resume()
        }
      }
    }

    // Start streaming TTS — Nicole will begin speaking as soon as the first
    // sentence arrives, while the rest of the response is still generating.
    voiceController.beginStreamingTTS { [weak self] in
      Task { @MainActor in
        // TTS finished naturally — stop interrupt monitoring and start next turn
        voiceController.stopInterruptMonitoring()
        await self?.startConversationTurn()
      }
    }

    // Monitor the mic while Nicole speaks — if the user talks over her, interrupt
    voiceController.startInterruptMonitoring { [weak self] capturedAudio in
      guard let self else { return }

      Task { @MainActor in
        // User interrupted — stop Nicole mid-sentence
        voiceController.cancelStreamingTTS()
        KokoroSpeaker.shared.stopSpeaking()

        // Now capture the rest of what the user is saying
        voiceController.startAmbientCapture { [weak self] transcript in
          guard let self else { return }

          Task { @MainActor in
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
              await self.startConversationTurn()
              return
            }

            await self.sendAmbientVoiceCommand(
              trimmed,
              settings: settings,
              viewModel: viewModel,
              voiceController: voiceController
            )
          }
        }
      }
    }

    let response: NicoleMessage?

    if Self.isVisionRequest(command) {
      // Vision request — capture screen and send to vision model
      response = await viewModel.sendVisionMessage(
        question: command,
        baseURLString: settings.baseURLString,
        settings: settings
      )
    } else {
      response = await viewModel.sendVoiceMessage(
        command,
        baseURLString: settings.baseURLString,
        settings: settings
      )
    }

    if response == nil {
      voiceController.stopInterruptMonitoring()
      voiceController.cancelStreamingTTS()
      await resumeWakeWordListeningIfNeeded()
    }
  }

  private var conversationModeStartedAt: Date?

  private func startConversationTurn() async {
    guard let settings, let viewModel, let voiceController else {
      await resumeWakeWordListeningIfNeeded()
      return
    }

    guard settings.alwaysOnVoiceEnabled else {
      return
    }

    if conversationModeStartedAt == nil {
      conversationModeStartedAt = Date()
    }

    // Exit conversation mode after 30 minutes of inactivity
    if let started = conversationModeStartedAt,
       Date().timeIntervalSince(started) > 1800 {
      conversationModeStartedAt = nil
      await resumeWakeWordListeningIfNeeded()
      return
    }

    voiceController.startAmbientCapture { [weak self] transcript in
      guard let self else { return }

      Task { @MainActor in
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()

        // Empty transcript (noise/silence) — stay in conversation mode
        if trimmed.isEmpty {
          await self.startConversationTurn()
          return
        }

        // Explicit exit phrases — go back to wake word
        let exitPhrases = ["bye", "goodbye", "that's all", "thats all", "nevermind", "never mind", "stop listening"]
        if exitPhrases.contains(where: { lower == $0 || lower.hasPrefix($0 + " ") }) {
          self.conversationModeStartedAt = nil
          await self.resumeWakeWordListeningIfNeeded()
          return
        }

        // Reset the 30-minute timer on each successful turn
        self.conversationModeStartedAt = Date()

        // User spoke — continue the conversation
        await self.sendAmbientVoiceCommand(
          trimmed,
          settings: settings,
          viewModel: viewModel,
          voiceController: voiceController
        )
      }
    }
  }

  private func resumeWakeWordListeningIfNeeded() async {
    guard let settings else { return }
    guard settings.alwaysOnVoiceEnabled else { return }

    wakeWordController.start { [weak self] detectedCommand in
      guard let self else { return }
      Task { @MainActor in
        await self.handleWakeWordDetection(initialCommand: detectedCommand)
      }
    }
  }

  private func installGlobalHotKey() {
    let eventSpec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )

    let selfPointer = Unmanaged.passUnretained(self).toOpaque()

    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, eventRef, userData in
        guard let userData else {
          return noErr
        }

        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
          eventRef,
          EventParamName(kEventParamDirectObject),
          EventParamType(typeEventHotKeyID),
          nil,
          MemoryLayout<EventHotKeyID>.size,
          nil,
          &hotKeyID
        )

        guard status == noErr, hotKeyID.id == AppDelegate.summonHotKeyID else {
          return noErr
        }

        let appDelegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
        appDelegate.toggleNicolePanel()

        return noErr
      },
      1,
      [eventSpec],
      selfPointer,
      &hotKeyHandler
    )

    let hotKeyID = EventHotKeyID(
      signature: OSType(0x4E49434C), // "NICL"
      id: Self.summonHotKeyID
    )

    RegisterEventHotKey(
      UInt32(kVK_ANSI_N),
      UInt32(controlKey),
      hotKeyID,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )
  }
}
