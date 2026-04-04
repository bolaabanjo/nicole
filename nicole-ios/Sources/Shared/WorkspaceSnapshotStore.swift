#if os(macOS)
import Foundation

// These types are macOS-only. 
// If they are needed for the macOS app to build from this shared file, 
// they must be defined or imported here under #if os(macOS).
// However, since this is a standalone folder for iOS, we can just stub them.

struct HiddenWorkspaceSnapshotRead: Sendable {
  let payload: NicoleWorkspaceContextPayload?
  let isStale: Bool
}

actor WorkspaceSnapshotStore {
  static let shared = WorkspaceSnapshotStore()
  private init() {}
  
  func currentSnapshot(maxAge: TimeInterval) -> HiddenWorkspaceSnapshotRead {
    return HiddenWorkspaceSnapshotRead(payload: nil, isStale: true)
  }
  
  func waitForVisibleContent(target: Any, timeoutNanoseconds: UInt64 = 0) async -> NicoleWorkspaceContextPayload? {
    return nil
  }
}

#else
import Foundation

// Clean iOS implementation: No capture logic at all.
struct HiddenWorkspaceSnapshotRead: Sendable {
    let payload: NicoleWorkspaceContextPayload?
    let isStale: Bool
}

actor WorkspaceSnapshotStore {
    static let shared = WorkspaceSnapshotStore()
    private init() {}
    
    func currentSnapshot(maxAge: TimeInterval) -> HiddenWorkspaceSnapshotRead {
        return HiddenWorkspaceSnapshotRead(payload: nil, isStale: true)
    }
}
#endif
