import Foundation

/// Where the share inbox may write. Production never leaves the app group;
/// an isolated preview inbox exists only for DEBUG `-store-preview`.
public enum ShareInboxContainerPolicy: Sendable {
    public enum Resolution: Equatable, Sendable {
        case appGroup
        case storePreviewInbox
        case unavailable
    }

    public static let previewDirectoryName = "StorePreviewShareInbox"
    public static let previewDefaultsSuite = "com.posival.openmausmobile.store-preview.share-inbox"

    public static func resolution(
        appGroupAvailable: Bool,
        storePreviewActive: Bool,
        debugBuild: Bool
    ) -> Resolution {
        if appGroupAvailable { return .appGroup }
        if allowsIsolatedPreviewInbox(storePreviewActive: storePreviewActive, debugBuild: debugBuild) {
            return .storePreviewInbox
        }
        return .unavailable
    }

    public static func allowsIsolatedPreviewInbox(
        storePreviewActive: Bool,
        debugBuild: Bool
    ) -> Bool {
        debugBuild && storePreviewActive
    }

    public static func previewInboxURL(applicationSupport: URL) -> URL {
        applicationSupport.appendingPathComponent(previewDirectoryName, isDirectory: true)
    }
}
