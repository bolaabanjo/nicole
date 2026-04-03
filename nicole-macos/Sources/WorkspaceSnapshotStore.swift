import Foundation

struct HiddenWorkspaceSnapshot: Sendable {
  let payload: NicoleWorkspaceContextPayload
  let target: WorkspaceCaptureTarget
  let capturedAt: Date
  let enrichedAt: Date?
  let lastOCRFailureReason: String?
}

struct HiddenWorkspaceSnapshotRead: Sendable {
  let payload: NicoleWorkspaceContextPayload?
  let target: WorkspaceCaptureTarget?
  let ageMilliseconds: Double?
  let isStale: Bool
}

actor WorkspaceSnapshotStore {
  static let shared = WorkspaceSnapshotStore()

  private var snapshot: HiddenWorkspaceSnapshot?

  private init() {}

  func storeFastSnapshot(_ fastSnapshot: FastWorkspaceSnapshot) {
    let preservedVisibleContent: String?
    let preservedEnrichedAt: Date?
    let preservedOCRReason: String?

    if
      let existing = snapshot,
      existing.target == fastSnapshot.target,
      let enrichedAt = existing.enrichedAt,
      Date().timeIntervalSince(enrichedAt) <= 3
    {
      preservedVisibleContent = existing.payload.visibleContent
      preservedEnrichedAt = existing.enrichedAt
      preservedOCRReason = existing.lastOCRFailureReason
    } else {
      preservedVisibleContent = nil
      preservedEnrichedAt = nil
      preservedOCRReason = nil
    }

    let payload = NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: fastSnapshot.payload.activeApp,
      windowTitle: fastSnapshot.payload.windowTitle,
      selectedText: fastSnapshot.payload.selectedText,
      clipboardText: nil,
      currentUrl: fastSnapshot.payload.currentUrl,
      currentFilePath: fastSnapshot.payload.currentFilePath,
      visibleContent: preservedVisibleContent,
      note: nil
    )

    snapshot = HiddenWorkspaceSnapshot(
      payload: payload,
      target: fastSnapshot.target,
      capturedAt: fastSnapshot.capturedAt,
      enrichedAt: preservedEnrichedAt,
      lastOCRFailureReason: preservedOCRReason
    )
  }

  func storeEnrichedVisibleContent(
    _ visibleContent: String?,
    failureReason: String?,
    for target: WorkspaceCaptureTarget,
    capturedAt: Date = Date()
  ) {
    guard let existing = snapshot, existing.target == target else {
      return
    }

    let normalizedVisibleContent = visibleContent?
      .trimmingCharacters(in: .whitespacesAndNewlines)

    let payload = NicoleWorkspaceContextPayload(
      surface: existing.payload.surface,
      activeApp: existing.payload.activeApp,
      windowTitle: existing.payload.windowTitle,
      selectedText: existing.payload.selectedText,
      clipboardText: nil,
      currentUrl: existing.payload.currentUrl,
      currentFilePath: existing.payload.currentFilePath,
      visibleContent: normalizedVisibleContent?.isEmpty == false ? normalizedVisibleContent : nil,
      note: nil
    )

    snapshot = HiddenWorkspaceSnapshot(
      payload: payload,
      target: target,
      capturedAt: existing.capturedAt,
      enrichedAt: normalizedVisibleContent?.isEmpty == false ? capturedAt : existing.enrichedAt,
      lastOCRFailureReason: failureReason
    )
  }

  func currentSnapshot(maxAge: TimeInterval) -> HiddenWorkspaceSnapshotRead {
    guard let snapshot else {
      return HiddenWorkspaceSnapshotRead(
        payload: nil,
        target: nil,
        ageMilliseconds: nil,
        isStale: true
      )
    }

    let age = Date().timeIntervalSince(snapshot.capturedAt)
    let ageMilliseconds = age * 1000
    let isStale = age > maxAge

    let note: String
    if let visibleContent = snapshot.payload.visibleContent, !visibleContent.isEmpty {
      note = "Hidden macOS workspace snapshot. OCR-backed screen text is available. Freshness: \(Int(ageMilliseconds))ms."
    } else if let lastOCRFailureReason = snapshot.lastOCRFailureReason {
      note = "Hidden macOS workspace snapshot. Using fast metadata only. \(lastOCRFailureReason)"
    } else {
      note = "Hidden macOS workspace snapshot. Using fast metadata while OCR warms or remains unavailable."
    }

    let payload = NicoleWorkspaceContextPayload(
      surface: snapshot.payload.surface,
      activeApp: snapshot.payload.activeApp,
      windowTitle: snapshot.payload.windowTitle,
      selectedText: snapshot.payload.selectedText,
      clipboardText: nil,
      currentUrl: snapshot.payload.currentUrl,
      currentFilePath: snapshot.payload.currentFilePath,
      visibleContent: snapshot.payload.visibleContent,
      note: note
    )

    return HiddenWorkspaceSnapshotRead(
      payload: payload,
      target: snapshot.target,
      ageMilliseconds: ageMilliseconds,
      isStale: isStale
    )
  }

  func waitForVisibleContent(
    target: WorkspaceCaptureTarget,
    timeoutNanoseconds: UInt64 = 450_000_000,
    pollIntervalNanoseconds: UInt64 = 40_000_000
  ) async -> NicoleWorkspaceContextPayload? {
    let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds

    while DispatchTime.now().uptimeNanoseconds < deadline {
      guard let snapshot, snapshot.target == target else {
        return nil
      }

      if let visibleContent = snapshot.payload.visibleContent,
         !visibleContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return currentSnapshot(maxAge: .greatestFiniteMagnitude).payload
      }

      try? await Task.sleep(nanoseconds: pollIntervalNanoseconds)
    }

    guard let snapshot, snapshot.target == target else {
      return nil
    }

    return currentSnapshot(maxAge: .greatestFiniteMagnitude).payload
  }
}
