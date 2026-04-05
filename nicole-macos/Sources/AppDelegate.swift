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
  }

  func configure(
    settings: AppSettings,
    viewModel: ChatViewModel,
    voiceController: NicoleVoiceController
  ) {
    self.settings = settings
    self.viewModel = viewModel
    self.voiceController = voiceController
    viewModel.attachVoiceController(voiceController)

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
    // Start streaming TTS — Nicole will begin speaking as soon as the first
    // sentence arrives, while the rest of the response is still generating.
    voiceController.beginStreamingTTS { [weak self] in
      Task { @MainActor in
        await self?.startConversationTurn()
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
