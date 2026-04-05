import CoreGraphics
import Foundation

@MainActor
enum WorkspaceContextProvider {
  private static let nicoleBundleIdentifier = Bundle.main.bundleIdentifier
  private static let staleThresholdSeconds: TimeInterval = 1.5
  private static let compactVisibleContentWaitNanoseconds: UInt64 = 1_200_000_000

  static func captureExternalContext() async {
    guard let fastSnapshot = freshExternalSnapshot() else { return }
    await storeAndWarm(snapshot: fastSnapshot)
  }

  static func compactContext(settings _: AppSettings) async -> NicoleWorkspaceContextPayload? {
    let retrievalStartedAt = CFAbsoluteTimeGetCurrent()

    if let freshSnapshot = freshExternalSnapshot() {
      await storeAndWarm(snapshot: freshSnapshot)

      let payload = await resolvedPayload(
        for: freshSnapshot.target,
        timeoutNanoseconds: compactVisibleContentWaitNanoseconds
      )
      logRetrievalIfNeeded(startedAt: retrievalStartedAt)
      return payload
    }

    let cached = await WorkspaceSnapshotStore.shared.currentSnapshot(maxAge: staleThresholdSeconds)
    if let payload = cached.payload,
       let target = cached.target,
       needsVisibleContentRefresh(payload: payload)
    {
      let refreshSeed = makeRefreshSeed(from: payload, target: target)
      Task {
        await ScreenEnrichmentEngine.shared.enrichAndStoreVisibleText(from: refreshSeed)
      }

      if let refreshedPayload = await resolvedPayload(
        for: target,
        timeoutNanoseconds: compactVisibleContentWaitNanoseconds
      ) {
        logRetrievalIfNeeded(startedAt: retrievalStartedAt)
        return refreshedPayload
      }
    }

    if let payload = cached.payload {
      logRetrievalIfNeeded(startedAt: retrievalStartedAt)
      return payload
    }

    logRetrievalIfNeeded(startedAt: retrievalStartedAt)
    return nil
  }

  static func compactSeedContext() async -> NicoleWorkspaceContextPayload? {
    if let freshSnapshot = freshExternalSnapshot() {
      await storeAndWarm(snapshot: freshSnapshot)
      return await WorkspaceSnapshotStore.shared.currentSnapshot(
        maxAge: .greatestFiniteMagnitude
      ).payload
    }

    return await WorkspaceSnapshotStore.shared.currentSnapshot(
      maxAge: staleThresholdSeconds
    ).payload
  }

  private static func freshExternalSnapshot() -> FastWorkspaceSnapshot? {
    FastWorkspaceProbe.captureExternalWorkspace(excluding: nicoleBundleIdentifier)
  }

  private static func storeAndWarm(snapshot: FastWorkspaceSnapshot) async {
    await WorkspaceSnapshotStore.shared.storeFastSnapshot(snapshot)
    Task {
      await ScreenEnrichmentEngine.shared.enrichAndStoreVisibleText(from: snapshot)
    }
  }

  private static func resolvedPayload(
    for target: WorkspaceCaptureTarget,
    timeoutNanoseconds: UInt64
  ) async -> NicoleWorkspaceContextPayload? {
    let current = await WorkspaceSnapshotStore.shared.currentSnapshot(maxAge: .greatestFiniteMagnitude)
    if let payload = current.payload, !needsVisibleContentRefresh(payload: payload) {
      return payload
    }

    if let awaited = await WorkspaceSnapshotStore.shared.waitForVisibleContent(
      target: target,
      timeoutNanoseconds: timeoutNanoseconds
    ) {
      return awaited
    }

    return await WorkspaceSnapshotStore.shared.currentSnapshot(
      maxAge: .greatestFiniteMagnitude
    ).payload
  }

  private static func needsVisibleContentRefresh(payload: NicoleWorkspaceContextPayload) -> Bool {
    payload.visibleContent?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
  }

  private static func makeRefreshSeed(
    from payload: NicoleWorkspaceContextPayload,
    target: WorkspaceCaptureTarget
  ) -> FastWorkspaceSnapshot {
    FastWorkspaceSnapshot(
      payload: NicoleWorkspaceContextPayload(
        surface: "macos",
        activeApp: payload.activeApp ?? target.applicationName,
        windowTitle: payload.windowTitle,
        selectedText: payload.selectedText,
        clipboardText: nil,
        currentUrl: payload.currentUrl,
        currentFilePath: payload.currentFilePath,
        visibleContent: nil,
        note: nil
      ),
      capturedAt: Date(),
      target: target
    )
  }

  private static func logRetrievalIfNeeded(startedAt: CFAbsoluteTime) {
    let retrievalMilliseconds = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000
    if retrievalMilliseconds > 5 {
      print("Nicole hidden workspace snapshot fetch took \(retrievalMilliseconds)ms")
    }
  }
}
