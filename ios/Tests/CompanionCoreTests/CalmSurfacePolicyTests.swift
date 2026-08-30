import XCTest
@testable import CompanionCore

final class CalmSurfacePolicyTests: XCTestCase {
    func testReconnectCopyIsStable() {
        XCTAssertEqual(CalmSurfacePolicy.reconnectToEdit, "Reconnect to edit.")
    }

    func testEditingRequiresALivePairedConnection() {
        XCTAssertTrue(CalmSurfacePolicy.canEditRemoteContent(isLive: true, hasConnection: true))
        XCTAssertFalse(CalmSurfacePolicy.canEditRemoteContent(isLive: false, hasConnection: true))
        XCTAssertFalse(CalmSurfacePolicy.canEditRemoteContent(isLive: true, hasConnection: false))
        XCTAssertFalse(CalmSurfacePolicy.canEditRemoteContent(isLive: false, hasConnection: false))
    }

    func testSkeletonYieldsToCachedRows() {
        XCTAssertTrue(CalmSurfacePolicy.showsSkeleton(isLoading: true, hasCachedRows: false))
        XCTAssertFalse(CalmSurfacePolicy.showsSkeleton(isLoading: true, hasCachedRows: true))
        XCTAssertFalse(CalmSurfacePolicy.showsSkeleton(isLoading: false, hasCachedRows: false))
        XCTAssertFalse(CalmSurfacePolicy.showsSkeleton(isLoading: false, hasCachedRows: true))
    }

    func testFailedCatalogReloadKeepsCache() {
        XCTAssertEqual(
            CalmSurfacePolicy.selectCatalog(cached: ["a", "b"], incoming: [], failed: true),
            ["a", "b"]
        )
        XCTAssertEqual(
            CalmSurfacePolicy.selectCatalog(cached: ["a"], incoming: ["x"], failed: false),
            ["x"]
        )
        XCTAssertEqual(
            CalmSurfacePolicy.selectCatalog(cached: ["a"], incoming: [] as [String], failed: false),
            []
        )
    }

    func testPinnedShelfMetricsStayThreeAcrossOnPhoneWidth() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 390)
        XCTAssertEqual(layout.avatar, 80)
        XCTAssertEqual(layout.spacing, 20)
        XCTAssertGreaterThanOrEqual(layout.tile, layout.avatar)
        XCTAssertEqual(PinnedChatShelfLayout.reservedHeight, 116)
    }

    func testPinnedShelfDoesNotOverflowUntilTheFourthPin() {
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 0))
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 3))
        XCTAssertTrue(PinnedChatShelfLayout.overflows(pinCount: 4))
    }

    func testPinnedShelfKeepsAReadableAvatarOnNarrowPanes() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 200)
        XCTAssertEqual(layout.avatar, PinnedChatShelfLayout.minimumAvatar)
        XCTAssertEqual(layout.tile, layout.avatar)
    }

    func testPinnedShelfReservedHeightDoesNotDependOnPinCount() {
        XCTAssertEqual(PinnedChatShelfLayout.reservedHeight, 80 + 36)
    }
}
