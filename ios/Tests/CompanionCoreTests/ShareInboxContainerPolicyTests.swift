import XCTest
@testable import CompanionCore

final class ShareInboxContainerPolicyTests: XCTestCase {
    func testProductionUsesAppGroupWhenPresent() {
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: true,
                storePreviewActive: false,
                debugBuild: false
            ),
            .appGroup
        )
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: true,
                storePreviewActive: true,
                debugBuild: true
            ),
            .appGroup
        )
    }

    func testProductionFailsClosedWhenAppGroupMissing() {
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: false,
                storePreviewActive: false,
                debugBuild: false
            ),
            .unavailable
        )
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: false,
                storePreviewActive: false,
                debugBuild: true
            ),
            .unavailable
        )
    }

    func testStorePreviewInboxIsDebugOnlyAndNeverCrossesIntoRelease() {
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: false,
                storePreviewActive: true,
                debugBuild: true
            ),
            .storePreviewInbox
        )
        XCTAssertEqual(
            ShareInboxContainerPolicy.resolution(
                appGroupAvailable: false,
                storePreviewActive: true,
                debugBuild: false
            ),
            .unavailable
        )
        XCTAssertFalse(
            ShareInboxContainerPolicy.allowsIsolatedPreviewInbox(
                storePreviewActive: true,
                debugBuild: false
            )
        )
        XCTAssertTrue(
            ShareInboxContainerPolicy.allowsIsolatedPreviewInbox(
                storePreviewActive: true,
                debugBuild: true
            )
        )
        XCTAssertFalse(
            ShareInboxContainerPolicy.allowsIsolatedPreviewInbox(
                storePreviewActive: false,
                debugBuild: true
            )
        )
    }

    func testPreviewInboxPathIsIsolatedFromTheAppGroup() {
        let support = URL(fileURLWithPath: "/tmp/Application Support", isDirectory: true)
        let preview = ShareInboxContainerPolicy.previewInboxURL(applicationSupport: support)
        XCTAssertEqual(preview.lastPathComponent, "StorePreviewShareInbox")
        XCTAssertTrue(preview.path.hasPrefix(support.path))
        XCTAssertFalse(preview.path.contains(ShareInbox.appGroup))
        XCTAssertNotEqual(ShareInboxContainerPolicy.previewDefaultsSuite, ShareInbox.appGroup)
        XCTAssertFalse(ShareInboxContainerPolicy.previewDefaultsSuite.hasPrefix("group."))
    }

    func testShareExtensionFailsClosedForUnavailableAppGroup() {
        let decision = ShareExtensionPostPolicy.decision(
            saving: ShareInboxError.appGroupUnavailable
        )
        XCTAssertEqual(decision, .failClosed(message: ShareExtensionPostPolicy.genericCopy))
        XCTAssertFalse(ShareExtensionPostPolicy.shouldOpenHost(after: ShareInboxError.appGroupUnavailable))
        XCTAssertFalse(ShareExtensionPostPolicy.shouldCompleteSuccess(after: ShareInboxError.appGroupUnavailable))
        XCTAssertTrue(ShareExtensionPostPolicy.leavesRequestRetryable(after: ShareInboxError.appGroupUnavailable))
        XCTAssertEqual(
            ShareInboxError.appGroupUnavailable.errorDescription,
            ShareExtensionPostPolicy.genericCopy
        )
    }
}
