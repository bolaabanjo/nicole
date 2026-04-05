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
    let reactivity = normalizedReactivity
    let baseSize: CGFloat = 140

    return ZStack {
      // Outer glow layer 3 — very diffuse
      Circle()
        .fill(orbGradient.opacity(0.08))
        .frame(width: baseSize * 2.8, height: baseSize * 2.8)
        .blur(radius: 60)
        .scaleEffect(1.0 + breathePhase * 0.06 + reactivity * 0.15)

      // Outer glow layer 2
      Circle()
        .fill(orbGradient.opacity(0.14))
        .frame(width: baseSize * 2.0, height: baseSize * 2.0)
        .blur(radius: 40)
        .scaleEffect(1.0 + breathePhase * 0.05 + reactivity * 0.12)

      // Outer glow layer 1
      Circle()
        .fill(orbGradient.opacity(0.22))
        .frame(width: baseSize * 1.5, height: baseSize * 1.5)
        .blur(radius: 24)
        .scaleEffect(1.0 + breathePhase * 0.04 + reactivity * 0.1)

      // Main orb body
      Circle()
        .fill(
          RadialGradient(
            colors: orbColors,
            center: .center,
            startRadius: 0,
            endRadius: baseSize * 0.6
          )
        )
        .frame(width: baseSize, height: baseSize)
        .blur(radius: 1)
        .scaleEffect(1.0 + breathePhase * 0.03 + reactivity * 0.08)

      // Inner bright core
      Circle()
        .fill(
          RadialGradient(
            colors: [Color.white.opacity(0.6), Color.white.opacity(0)],
            center: .center,
            startRadius: 0,
            endRadius: baseSize * 0.25
          )
        )
        .frame(width: baseSize * 0.5, height: baseSize * 0.5)
        .scaleEffect(1.0 + breathePhase * 0.05 + reactivity * 0.15)

      // Rotating accent highlight
      Ellipse()
        .fill(orbAccentGradient)
        .frame(width: baseSize * 0.7, height: baseSize * 0.3)
        .blur(radius: 18)
        .offset(y: -baseSize * 0.15)
        .rotationEffect(.degrees(rotationAngle))
        .opacity(0.3 + reactivity * 0.2)
    }
    .animation(.easeOut(duration: 0.08), value: reactivity)
    .contentShape(Circle().scale(2.0))
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
        Color(red: 0.3, green: 0.5, blue: 0.95),
        Color(red: 0.15, green: 0.3, blue: 0.75),
        Color(red: 0.08, green: 0.15, blue: 0.5),
      ]
    case .listening:
      return [
        Color(red: 0.2, green: 0.7, blue: 1.0),
        Color(red: 0.1, green: 0.5, blue: 0.9),
        Color(red: 0.05, green: 0.25, blue: 0.65),
      ]
    case .thinking:
      return [
        Color(red: 0.55, green: 0.35, blue: 0.95),
        Color(red: 0.35, green: 0.2, blue: 0.75),
        Color(red: 0.18, green: 0.1, blue: 0.5),
      ]
    case .speaking:
      return [
        Color(red: 0.15, green: 0.8, blue: 0.7),
        Color(red: 0.1, green: 0.55, blue: 0.65),
        Color(red: 0.05, green: 0.3, blue: 0.45),
      ]
    }
  }

  private var orbGradient: RadialGradient {
    RadialGradient(
      colors: orbColors.map { $0.opacity(0.8) },
      center: .center,
      startRadius: 0,
      endRadius: 200
    )
  }

  private var orbAccentGradient: RadialGradient {
    RadialGradient(
      colors: [
        Color.white.opacity(0.3),
        orbColors.first?.opacity(0.1) ?? Color.clear,
      ],
      center: .center,
      startRadius: 0,
      endRadius: 40
    )
  }

  private func handleOrbTap() {
    switch orbState {
    case .idle:
      voiceController.startAmbientCapture { transcript in
        Task { @MainActor in
          let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else { return }

          voiceController.beginStreamingTTS(onAllComplete: {})

          let response = await viewModel.sendVoiceMessage(
            trimmed,
            baseURLString: settings.baseURLString,
            settings: settings
          )

          if response == nil {
            voiceController.cancelStreamingTTS()
          }
        }
      }
    case .listening:
      voiceController.stopListeningIfActive(on: .ambient)
    case .speaking:
      voiceController.stopSpeaking()
    case .thinking:
      break
    }
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
