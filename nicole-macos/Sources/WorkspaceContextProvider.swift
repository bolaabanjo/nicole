import Foundation

@MainActor
enum WorkspaceContextProvider {
  private static let nicoleBundleIdentifier = Bundle.main.bundleIdentifier
  private static let staleThresholdSeconds: TimeInterval = 1.5

  static func captureExternalContext() async {
    guard
      let fastSnapshot = FastWorkspaceProbe.captureExternalWorkspace(
        excluding: nicoleBundleIdentifier
      )
    else {
      return
    }

    await WorkspaceSnapshotStore.shared.storeFastSnapshot(fastSnapshot)

    Task {
      await ScreenEnrichmentEngine.shared.enrichAndStoreVisibleText(from: fastSnapshot)
    }
  }

  static func currentContext(settings _: AppSettings) async -> NicoleWorkspaceContextPayload {
    let retrievalStartedAt = CFAbsoluteTimeGetCurrent()
    let cached = await WorkspaceSnapshotStore.shared.currentSnapshot(
      maxAge: staleThresholdSeconds
    )
    let retrievalMilliseconds = (CFAbsoluteTimeGetCurrent() - retrievalStartedAt) * 1000

    if retrievalMilliseconds > 5 {
      print("Nicole hidden workspace snapshot fetch took \(retrievalMilliseconds)ms")
    }

    if cached.isStale, let target = cached.target {
      Task {
        let refreshSeed = FastWorkspaceSnapshot(
          payload: NicoleWorkspaceContextPayload(
            surface: "macos",
            activeApp: target.applicationName,
            windowTitle: cached.payload?.windowTitle,
            selectedText: cached.payload?.selectedText,
            clipboardText: nil,
            currentUrl: cached.payload?.currentUrl,
            currentFilePath: cached.payload?.currentFilePath,
            visibleContent: nil,
            note: nil
          ),
          capturedAt: Date(),
          target: target
        )
        await ScreenEnrichmentEngine.shared.enrichAndStoreVisibleText(from: refreshSeed)
      }
    }

    if let payload = cached.payload {
      return payload
    }

    return NicoleWorkspaceContextPayload(
      surface: "macos",
      activeApp: nil,
      windowTitle: nil,
      selectedText: nil,
      clipboardText: nil,
      currentUrl: nil,
      currentFilePath: nil,
      visibleContent: nil,
      note: "No hidden macOS workspace snapshot was available yet."
    )
  }
}
