import AppKit
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit
import VideoToolbox

@MainActor
final class CompactScreenCaptureController: NSObject, ObservableObject {
  enum CaptureState: Equatable {
    case idle
    case requestingPermission
    case starting
    case active
    case permissionRequired
    case unavailable(String)
  }

  static let shared = CompactScreenCaptureController()

  @Published private(set) var permissionState: NicolePermissionState = .notDetermined
  @Published private(set) var captureState: CaptureState = .idle

  var inlineStatusText: String? {
    switch captureState {
    case .idle, .active:
      return nil
    case .requestingPermission:
      return "Requesting screen access…"
    case .starting:
      return "Starting screen capture…"
    case .permissionRequired:
      return "Screen access required for compact vision."
    case let .unavailable(message):
      return message
    }
  }

  var showsOpenSystemSettingsButton: Bool {
    captureState == .permissionRequired
  }

  private let frameStore: LatestFrameStore
  private let outputQueue = DispatchQueue(label: "nicole.compact.capture.output")
  private let outputHandler: StreamOutputHandler
  private var stream: SCStream?
  private var activeScreenFrame: CGRect?
  private let maxCaptureDimension: CGFloat = 1728

  private override init() {
    let frameStore = LatestFrameStore()
    self.frameStore = frameStore
    self.outputHandler = StreamOutputHandler(frameStore: frameStore)
    super.init()
  }

  func startIfNeeded(for screen: NSScreen) {
    Task { @MainActor in
      await start(for: screen)
    }
  }

  func stop() {
    frameStore.clear()
    activeScreenFrame = nil
    captureState = .idle

    guard let stream else { return }
    self.stream = nil

    Task.detached(priority: .userInitiated) {
      try? await stream.stopCapture()
    }
  }

  func latestFrameBase64(timeoutNanoseconds: UInt64 = 1_000_000_000) async -> String? {
    if let data = await latestFrameJPEGData(timeoutNanoseconds: timeoutNanoseconds) {
      return data.base64EncodedString()
    }

    return nil
  }

  func latestFrameJPEGData(timeoutNanoseconds: UInt64 = 1_000_000_000) async -> Data? {
    let deadline = Date().addingTimeInterval(Double(timeoutNanoseconds) / 1_000_000_000)

    while Date() < deadline {
      if let data = frameStore.latestJPEGData(maxAge: 3.0) {
        return data
      }

      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    return frameStore.latestJPEGData(maxAge: 3.0)
  }

  func openSystemSettings() {
    ScreenCapturePermissionManager.openSystemSettings()
  }

  private func start(for screen: NSScreen) async {
    let currentPermissionState = await ScreenCapturePermissionManager.currentState()
    permissionState = currentPermissionState

    switch currentPermissionState {
    case .authorized:
      await beginStream(for: screen)
    case .notDetermined:
      captureState = .requestingPermission
      permissionState = await ScreenCapturePermissionManager.requestAccessIfNeeded()

      if permissionState == .authorized {
        await beginStream(for: screen)
      } else if case let .unavailable(message) = permissionState {
        frameStore.clear()
        captureState = .unavailable(message)
      } else {
        frameStore.clear()
        captureState = .permissionRequired
      }
    case .denied, .restricted:
      frameStore.clear()
      captureState = .permissionRequired
    case let .unavailable(message):
      frameStore.clear()
      captureState = .unavailable(message)
    }
  }

  private func beginStream(for screen: NSScreen) async {
    let targetFrame = screen.frame
    if captureState == .active, activeScreenFrame == targetFrame {
      return
    }

    captureState = .starting
    frameStore.clear()

    if let existingStream = stream {
      self.stream = nil
      try? await existingStream.stopCapture()
    }

    do {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      guard let display = matchingDisplay(for: targetFrame, in: content) else {
        captureState = .unavailable("Nicole couldn't find a display to capture.")
        return
      }

      let nicoleBundle = Bundle.main.bundleIdentifier ?? ""
      let includedApplications = content.applications.filter {
        $0.bundleIdentifier != nicoleBundle
      }

      let filter = SCContentFilter(
        display: display,
        including: includedApplications,
        exceptingWindows: []
      )

      let configuration = SCStreamConfiguration()
      configuration.showsCursor = false
      let scaledSize = scaledCaptureSize(
        width: CGFloat(display.width),
        height: CGFloat(display.height)
      )
      configuration.width = Int(scaledSize.width)
      configuration.height = Int(scaledSize.height)
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
      configuration.queueDepth = 2

      let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
      try stream.addStreamOutput(
        outputHandler,
        type: .screen,
        sampleHandlerQueue: outputQueue
      )
      try await stream.startCapture()

      self.stream = stream
      activeScreenFrame = targetFrame
      captureState = .active
      permissionState = .authorized
    } catch {
      captureState = .unavailable("Nicole couldn't start screen capture.")
    }
  }

  private func matchingDisplay(
    for targetFrame: CGRect,
    in content: SCShareableContent
  ) -> SCDisplay? {
    let midpoint = CGPoint(x: targetFrame.midX, y: targetFrame.midY)

    if let display = content.displays.first(where: { $0.frame.contains(midpoint) }) {
      return display
    }

    return content.displays.first
  }

  private func scaledCaptureSize(width: CGFloat, height: CGFloat) -> CGSize {
    guard width > 0, height > 0 else {
      return CGSize(width: 1280, height: 720)
    }

    let longestSide = max(width, height)
    guard longestSide > maxCaptureDimension else {
      return CGSize(width: width, height: height)
    }

    let scale = maxCaptureDimension / longestSide
    return CGSize(
      width: max(1, floor(width * scale)),
      height: max(1, floor(height * scale))
    )
  }
}

private final class LatestFrameStore {
  private let lock = NSLock()
  private var jpegData: Data?
  private var capturedAt: Date?

  func store(jpegData: Data) {
    lock.lock()
    defer { lock.unlock() }
    self.jpegData = jpegData
    self.capturedAt = Date()
  }

  func latestJPEGData(maxAge: TimeInterval) -> Data? {
    lock.lock()
    defer { lock.unlock() }

    guard
      let jpegData,
      let capturedAt,
      Date().timeIntervalSince(capturedAt) <= maxAge
    else {
      return nil
    }

    return jpegData
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    jpegData = nil
    capturedAt = nil
  }
}

private final class StreamOutputHandler: NSObject, SCStreamOutput {
  private let frameStore: LatestFrameStore

  init(frameStore: LatestFrameStore) {
    self.frameStore = frameStore
  }

  func stream(
    _: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of _: SCStreamOutputType
  ) {
    guard
      CMSampleBufferIsValid(sampleBuffer),
      let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else {
      return
    }

    var cgImage: CGImage?
    let status = VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &cgImage)
    guard status == noErr, let cgImage else {
      return
    }

    let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
    guard
      let jpegData = bitmapRep.representation(
        using: .jpeg,
        properties: [.compressionFactor: 0.55]
      )
    else {
      return
    }

    frameStore.store(jpegData: jpegData)
  }
}
