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

    func testDestinationRowsExcludeSkeletonWhileLoading() {
        XCTAssertFalse(CalmSurfacePolicy.showsDestinationRows(isLoading: true, instanceResolved: false))
        XCTAssertTrue(CalmSurfacePolicy.showsDestinationRows(isLoading: true, instanceResolved: true))
        XCTAssertTrue(CalmSurfacePolicy.showsDestinationRows(isLoading: false, instanceResolved: false))
    }

    func testUnknownInstancesStayUntappableUntilResolved() {
        XCTAssertFalse(CalmSurfacePolicy.destinationsSelectable(isLoading: true, instanceResolved: false))
        XCTAssertFalse(CalmSurfacePolicy.destinationsSelectable(isLoading: true, instanceResolved: true))
        XCTAssertFalse(CalmSurfacePolicy.destinationsSelectable(isLoading: false, instanceResolved: false))
        XCTAssertTrue(CalmSurfacePolicy.destinationsSelectable(isLoading: false, instanceResolved: true))
    }

    func testPinnedShelfReservationSkipsColdRoster() {
        XCTAssertFalse(CalmSurfacePolicy.reservesPinnedShelfRegion(pinCount: 0, animatingCollapse: false))
        XCTAssertTrue(CalmSurfacePolicy.reservesPinnedShelfRegion(pinCount: 1, animatingCollapse: false))
        XCTAssertTrue(CalmSurfacePolicy.reservesPinnedShelfRegion(pinCount: 0, animatingCollapse: true))
    }

    func testPinnedShelfHeroMetricsOnPhoneWidth() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 390, pinCount: 1)
        XCTAssertEqual(layout.mode, .hero)
        XCTAssertEqual(layout.avatar, PinnedChatShelfLayout.heroAvatar)
        XCTAssertEqual(layout.spacing, 0)
    }

    func testPinnedShelfDoesNotOverflowUntilTheFourthPin() {
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 0))
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 3))
        XCTAssertTrue(PinnedChatShelfLayout.overflows(pinCount: 4))
    }

    func testPinnedShelfKeepsAReadableAvatarOnNarrowPanes() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 200, pinCount: 4)
        XCTAssertEqual(layout.mode, .compact)
        XCTAssertEqual(layout.avatar, PinnedChatShelfLayout.minimumAvatar)
        XCTAssertEqual(layout.tile, layout.avatar)
    }

    func testPinnedShelfReservedHeightDoesNotDependOnPinCount() {
        let reserved = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlock
        )
        XCTAssertEqual(
            reserved,
            HomeRosterLayoutPolicy.pinnedShelfReservedHeight(nameBlockHeight: PinnedChatShelfLayout.nameBlock)
        )
    }

    func testPinnedShelfReservedHeightGrowsWithDynamicType() {
        let compact = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 11)
        )
        let large = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 22)
        )
        XCTAssertGreaterThanOrEqual(large, compact)
        XCTAssertEqual(large, HomeRosterLayoutPolicy.pinnedShelfReservedHeight(nameBlockHeight: 44))
    }
}
