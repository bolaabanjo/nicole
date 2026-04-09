import AVFoundation
import Speech

struct NicoleSpeechPermissionResult {
  let speechState: NicolePermissionState
  let microphoneState: NicolePermissionState
  let promptedDuringRequest: Bool
}

enum NicoleSpeechPermissionManager {
  @MainActor
  static func requestMicrophonePermission() async -> NicolePermissionState {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    return await requestMicrophoneAuthorization(currentStatus: status)
  }

  @MainActor
  static func requestPermissions() async -> NicoleSpeechPermissionResult {
    let speechStatus = SFSpeechRecognizer.authorizationStatus()
    let microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)

    let speechState = await requestSpeechAuthorization(currentStatus: speechStatus)
    let microphoneState = await requestMicrophoneAuthorization(currentStatus: microphoneStatus)

    return NicoleSpeechPermissionResult(
      speechState: speechState,
      microphoneState: microphoneState,
      promptedDuringRequest: speechStatus == .notDetermined || microphoneStatus == .notDetermined
    )
  }

  nonisolated private static func requestSpeechAuthorization(
    currentStatus: SFSpeechRecognizerAuthorizationStatus
  ) async -> NicolePermissionState {
    switch currentStatus {
    case .authorized:
      return .authorized
    case .denied:
      return .denied
    case .restricted:
      return .restricted
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { authorizationStatus in
          continuation.resume(
            returning: mapSpeechAuthorizationStatus(authorizationStatus)
          )
        }
      }
    @unknown default:
      return .unavailable("Speech recognition is unavailable right now.")
    }
  }

  nonisolated private static func requestMicrophoneAuthorization(
    currentStatus: AVAuthorizationStatus
  ) async -> NicolePermissionState {
    switch currentStatus {
    case .authorized:
      return .authorized
    case .denied:
      return .denied
    case .restricted:
      return .restricted
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          continuation.resume(returning: granted ? .authorized : .denied)
        }
      }
    @unknown default:
      return .unavailable("Microphone access is unavailable right now.")
    }
  }

  nonisolated private static func mapSpeechAuthorizationStatus(
    _ status: SFSpeechRecognizerAuthorizationStatus
  ) -> NicolePermissionState {
    switch status {
    case .authorized:
      return .authorized
    case .denied:
      return .denied
    case .restricted:
      return .restricted
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .unavailable("Speech recognition is unavailable right now.")
    }
  }
}
