import AVFoundation
import Speech

struct NicoleSpeechPermissionResult {
  let speechGranted: Bool
  let microphoneGranted: Bool
  let promptedDuringRequest: Bool
}

enum NicoleSpeechPermissionManager {
  @MainActor
  static func requestPermissions() async -> NicoleSpeechPermissionResult {
    let speechStatus = SFSpeechRecognizer.authorizationStatus()
    let microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)

    let speechGranted = await requestSpeechAuthorization(currentStatus: speechStatus)
    let microphoneGranted = await requestMicrophoneAuthorization(currentStatus: microphoneStatus)

    return NicoleSpeechPermissionResult(
      speechGranted: speechGranted,
      microphoneGranted: microphoneGranted,
      promptedDuringRequest: speechStatus == .notDetermined || microphoneStatus == .notDetermined
    )
  }

  @MainActor
  private static func requestSpeechAuthorization(currentStatus: SFSpeechRecognizerAuthorizationStatus) async -> Bool {
    switch currentStatus {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { authorizationStatus in
          continuation.resume(returning: authorizationStatus == .authorized)
        }
      }
    @unknown default:
      return false
    }
  }

  @MainActor
  private static func requestMicrophoneAuthorization(currentStatus: AVAuthorizationStatus) async -> Bool {
    switch currentStatus {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }
}
