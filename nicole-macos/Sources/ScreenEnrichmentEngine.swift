import AppKit
import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import Vision

actor ScreenEnrichmentEngine {
  static let shared = ScreenEnrichmentEngine()

  private init() {}

  /// Capture the current screen as a base64-encoded JPEG for vision model input.
  func captureScreenAsBase64() async -> String? {
    do {
      let content = try await shareableContent()
      guard let display = content.displays.first else { return nil }

      // Exclude Nicole's own windows
      let nicoleBundle = Bundle.main.bundleIdentifier ?? ""
      let otherApps = content.applications.filter { $0.bundleIdentifier != nicoleBundle }

      let filter = SCContentFilter(
        display: display,
        including: otherApps,
        exceptingWindows: []
      )

      let config = SCStreamConfiguration()
      config.showsCursor = false
      // Capture at 1x resolution to keep the image small for the vision model
      config.width = Int(display.width)
      config.height = Int(display.height)

      guard let cgImage = try await captureImage(filter: filter, configuration: config) else {
        return nil
      }

      // Convert to JPEG data at moderate quality
      let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
      guard let jpegData = bitmapRep.representation(
        using: .jpeg,
        properties: [.compressionFactor: 0.6]
      ) else {
        return nil
      }

      return jpegData.base64EncodedString()
    } catch {
      return nil
    }
  }

  func enrichAndStoreVisibleText(from fastSnapshot: FastWorkspaceSnapshot) async {
    // Don't gate on CGPreflightScreenCaptureAccess() — it returns false
    // for self-signed apps even when permission is granted. Just try to capture.
    do {
      guard let image = try await captureImage(for: fastSnapshot.target) else {
        await WorkspaceSnapshotStore.shared.storeEnrichedVisibleContent(
          nil,
          failureReason: "Nicole couldn't capture the current screen target, so hidden context is metadata only.",
          for: fastSnapshot.target
        )
        return
      }

      let visibleContent = try await recognizeVisibleText(in: image)
      await WorkspaceSnapshotStore.shared.storeEnrichedVisibleContent(
        visibleContent,
        failureReason: visibleContent == nil ? "OCR found no readable text in the captured screen region." : nil,
        for: fastSnapshot.target
      )
    } catch {
      await WorkspaceSnapshotStore.shared.storeEnrichedVisibleContent(
        nil,
        failureReason: "Local OCR failed, so Nicole is using metadata only.",
        for: fastSnapshot.target
      )
    }
  }

  func recognizeVisibleText(in imageData: Data) async -> String? {
    guard
      let imageSource = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
    else {
      return nil
    }

    do {
      return try await recognizeVisibleText(in: image)
    } catch {
      return nil
    }
  }

  private func captureImage(for target: WorkspaceCaptureTarget) async throws -> CGImage? {
    let content = try await shareableContent()

    if
      let windowID = target.windowID,
      let window = content.windows.first(where: { $0.windowID == windowID })
    {
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let config = SCStreamConfiguration()
      config.showsCursor = false
      config.width = max(1, Int(window.frame.width * 2))
      config.height = max(1, Int(window.frame.height * 2))
      return try await captureImage(filter: filter, configuration: config)
    }

    guard
      let display = preferredDisplay(for: target, content: content),
      let application = content.applications.first(where: { $0.processID == target.processID })
    else {
      return nil
    }

    let filter = SCContentFilter(
      display: display,
      including: [application],
      exceptingWindows: []
    )

    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.width = max(1, Int(display.width * 2))
    config.height = max(1, Int(display.height * 2))

    return try await captureImage(filter: filter, configuration: config)
  }

  private func preferredDisplay(
    for target: WorkspaceCaptureTarget,
    content: SCShareableContent
  ) -> SCDisplay? {
    if let bounds = target.windowBounds, !bounds.isEmpty {
      let windowMidPoint = CGPoint(x: bounds.midX, y: bounds.midY)
      if let match = content.displays.first(where: { $0.frame.contains(windowMidPoint) }) {
        return match
      }
    }

    return content.displays.first
  }

  private func recognizeVisibleText(in image: CGImage) async throws -> String? {
    try await withCheckedThrowingContinuation { continuation in
      let request = VNRecognizeTextRequest { request, error in
        if let error {
          continuation.resume(throwing: error)
          return
        }

        guard let observations = request.results as? [VNRecognizedTextObservation] else {
          continuation.resume(returning: nil)
          return
        }

        let sortedObservations = observations.sorted { lhs, rhs in
          if abs(lhs.boundingBox.midY - rhs.boundingBox.midY) > 0.025 {
            return lhs.boundingBox.midY > rhs.boundingBox.midY
          }

          return lhs.boundingBox.minX < rhs.boundingBox.minX
        }

        let lines = sortedObservations.compactMap { observation in
          observation.topCandidates(1).first?.string
        }

        let joined = lines.joined(separator: "\n")
          .trimmingCharacters(in: .whitespacesAndNewlines)

        if joined.isEmpty {
          continuation.resume(returning: nil)
          return
        }

        let collapsed = joined
          .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
          .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)

        continuation.resume(returning: String(collapsed.prefix(1500)))
      }

      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.minimumTextHeight = 0.012
      request.recognitionLanguages = ["en-US"]

      let handler = VNImageRequestHandler(cgImage: image, options: [:])

      do {
        try handler.perform([request])
      } catch {
        continuation.resume(throwing: error)
      }
    }
  }

  private func shareableContent() async throws -> SCShareableContent {
    try await withCheckedThrowingContinuation { continuation in
      SCShareableContent.getExcludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      ) { content, error in
        if let error {
          continuation.resume(throwing: error)
          return
        }

        guard let content else {
          continuation.resume(throwing: NSError(domain: "NicoleMacOS", code: 1))
          return
        }

        continuation.resume(returning: content)
      }
    }
  }

  private func captureImage(
    filter: SCContentFilter,
    configuration: SCStreamConfiguration
  ) async throws -> CGImage? {
    try await withCheckedThrowingContinuation { continuation in
      SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: configuration
      ) { image, error in
        if let error {
          continuation.resume(throwing: error)
          return
        }

        continuation.resume(returning: image)
      }
    }
  }
}
