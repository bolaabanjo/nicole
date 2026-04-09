import SwiftUI

struct VoiceModeView: View {
  @ObservedObject var settings: AppSettings
  @ObservedObject var viewModel: ChatViewModel
  @ObservedObject var voiceController: NicoleVoiceController
  @ObservedObject private var speaker = KokoroSpeaker.shared

  let onExit: () -> Void

  @State private var breathePhase: CGFloat = 0
  @State private var rotationAngle: Double = 0

  private var orbState: OrbState {
    if speaker.isSpeaking {
      return .speaking
    }
    if viewModel.isSending {
      return .thinking
    }
    if case .listening = voiceController.inputState {
      return .listening
    }
    if case .transcribing = voiceController.inputState {
      return .thinking
    }
    return .idle
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      VStack(spacing: 0) {
        voiceModeHeader
        Spacer()
        orbView
        Spacer()
        statusLabel
          .padding(.bottom, 60)
      }
    }
    .frame(
      minWidth: AppSettings.WindowMode.expanded.minimumWidth,
      idealWidth: AppSettings.WindowMode.expanded.idealWidth,
      minHeight: AppSettings.WindowMode.expanded.minimumHeight
    )
    .preferredColorScheme(.dark)
    .onAppear {
      withAnimation(.easeInOut(duration: 3.0).repeatForever(autoreverses: true)) {
        breathePhase = 1.0
      }
      withAnimation(.linear(duration: 12.0).repeatForever(autoreverses: false)) {
        rotationAngle = 360
      }
    }
  }

  private var voiceModeHeader: some View {
    HStack {
      Spacer()
      HStack(alignment: .center, spacing: 0) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Nicole")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Color.white)

          Text("Voice Mode")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.42))
        }

        Spacer()

        Button {
          onExit()
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.58))
            .frame(width: 28, height: 28)
            .background(Color.white.opacity(0.08))
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Exit Voice Mode")
      }
      .frame(maxWidth: 760)
      .padding(.horizontal, 20)
      Spacer()
    }
    .padding(.vertical, 8)
  }

  private var orbView: some View {
    FluidOrbView(
      colors: orbColors,
      reactivity: normalizedReactivity
    )
    .animation(.easeInOut(duration: 0.8), value: orbColors)
    .contentShape(Circle().scale(1.5))
    .onTapGesture {
      handleOrbTap()
    }
  }

  private var normalizedReactivity: CGFloat {
    switch orbState {
    case .idle:
      return 0
    case .listening:
      // Map dB level (-60..0) to 0..1
      let db = CGFloat(voiceController.currentAudioLevel)
      return max(0, min(1, (db + 55) / 45))
    case .speaking:
      // Map speaker output dB (-60..0) to 0..1
      let db = CGFloat(speaker.currentOutputLevel)
      return max(0, min(1, (db + 50) / 40))
    case .thinking:
      return 0.3 + breathePhase * 0.15
    }
  }

  private var orbColors: [Color] {
    switch orbState {
    case .idle:
      return [
        Color(red: 0.25, green: 0.35, blue: 0.9),  // Deep Blue
        Color(red: 0.45, green: 0.25, blue: 0.85), // Soft Violet
        Color(red: 0.1, green: 0.15, blue: 0.45),  // Indigo Shadow
      ]
    case .listening:
      return [
        Color(red: 0.15, green: 0.85, blue: 1.0),  // Bright Cyan
        Color(red: 0.2, green: 0.5, blue: 0.95),   // Azure
        Color(red: 0.1, green: 0.9, blue: 0.6),    // Emerald hit
      ]
    case .thinking:
      return [
        Color(red: 0.65, green: 0.3, blue: 1.0),   // Vibrant Purple
        Color(red: 1.0, green: 0.4, blue: 0.7),    // Hot Pink
        Color(red: 0.3, green: 0.2, blue: 0.8),    // Deep Navy
      ]
    case .speaking:
      return [
        Color(red: 0.1, green: 0.95, blue: 0.75),  // Mint/Teal
        Color(red: 0.05, green: 0.7, blue: 0.9),   // Sky Blue
        Color(red: 1.0, green: 1.0, blue: 1.0),    // Pure White Core
      ]
    }
  }

  private func handleOrbTap() {
    switch orbState {
    case .idle:
      VoiceSessionManager.shared.beginCapture(on: .ambient)
      voiceController.startAmbientCapture(
        onProgressiveTranscript: { partial in
          VoiceSessionManager.shared.updateProgressiveTranscript(
            partial,
            on: .ambient,
            baseURLString: settings.baseURLString
          )
        },
        onFinalTranscript: { transcript in
        Task { @MainActor in
          let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else { return }

          let preparedTurn = await VoiceSessionManager.shared.finalizePreparation(
            transcript: trimmed,
            on: .ambient,
            baseURLString: settings.baseURLString
          )

          voiceController.beginStreamingTTS(on: .ambient) {
            VoiceSessionManager.shared.markReplyCompleted(on: .ambient)
          }
          VoiceSessionManager.shared.markReplyStarted(
            on: .ambient,
            voiceTurnId: preparedTurn?.voiceTurnId
          )

          let response: NicoleMessage?

          if Self.isVisionRequest(trimmed) {
            response = await viewModel.sendVisionMessage(
              question: trimmed,
              baseURLString: settings.baseURLString,
              settings: settings,
              voiceSurface: .ambient,
              preparedTurn: preparedTurn
            )
          } else {
            response = await viewModel.sendVoiceMessage(
              trimmed,
              baseURLString: settings.baseURLString,
              settings: settings,
              surface: .ambient,
              preparedTurn: preparedTurn
            )
          }

          if response == nil {
            VoiceSessionManager.shared.markReplyCompleted(on: .ambient)
            voiceController.cancelStreamingTTS()
          }
        }
      })
    case .listening:
      voiceController.stopListeningIfActive(on: .ambient)
    case .speaking:
      voiceController.stopSpeaking()
      VoiceSessionManager.shared.markReplyCompleted(on: .ambient)
    case .thinking:
      break
    }
  }

  private static let visionTriggers = [
    "look at", "what's on my screen", "what do you see", "what is this",
    "what's this", "read this", "read my screen", "what am i looking at",
    "explain this", "what's wrong", "check this", "see my screen",
    "look at my screen", "what does this say", "can you see", "do you see",
    "screen",
  ]

  private static func isVisionRequest(_ text: String) -> Bool {
    let lower = text.lowercased()
    return visionTriggers.contains(where: { lower.contains($0) })
  }

  private var statusLabel: some View {
    Group {
      switch orbState {
      case .idle:
        Text("Say \"Hey Nicole\" or tap the orb")
          .foregroundStyle(Color.white.opacity(0.4))
      case .listening:
        Text("Listening…")
          .foregroundStyle(Color.cyan.opacity(0.8))
      case .thinking:
        Text("Thinking…")
          .foregroundStyle(Color.purple.opacity(0.7))
      case .speaking:
        Text("Speaking…")
          .foregroundStyle(Color.teal.opacity(0.7))
      }
    }
    .font(.system(size: 14, weight: .medium))
    .animation(.easeInOut(duration: 0.3), value: orbState)
  }
}

private enum OrbState: Equatable {
  case idle
  case listening
  case thinking
  case speaking
}
