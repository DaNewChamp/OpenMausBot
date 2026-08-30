import XCTest
@testable import CompanionCore

final class HomeRosterLayoutPolicyTests: XCTestCase {
    func testReferenceCanvasDimensions() {
        XCTAssertEqual(HomeRosterLayoutPolicy.referenceWidth, 590)
        XCTAssertEqual(HomeRosterLayoutPolicy.referenceHeight, 1280)
        XCTAssertEqual(HomeRosterLayoutPolicy.referenceFirstRowY, 400)
    }

    func testHeaderChromeMatchesReferenceControls() {
        XCTAssertEqual(HomeRosterLayoutPolicy.profileDiameter, 56)
        XCTAssertEqual(HomeRosterLayoutPolicy.chromeButtonDiameter, 58)
        XCTAssertEqual(HomeRosterLayoutPolicy.chromeButtonGap, 12)
        XCTAssertEqual(HomeRosterLayoutPolicy.headerChromeHeight, 56 + 8 + 12)
    }

    func testRowMetricsMatchReferenceCadence() {
        XCTAssertEqual(HomeRosterLayoutPolicy.rowAvatar, 58)
        XCTAssertEqual(HomeRosterLayoutPolicy.rowMinHeight, 104)
        XCTAssertEqual(HomeRosterLayoutPolicy.rowVerticalPadding, 11)
        XCTAssertEqual(
            HomeRosterLayoutPolicy.rowContentLeadingInset,
            HomeRosterLayoutPolicy.pagePadding
                + HomeRosterLayoutPolicy.rowAvatar
                + HomeRosterLayoutPolicy.rowAvatarSpacing
        )
    }

    func testTextColumnLeadingInsetTargetsReferenceBand() {
        XCTAssertEqual(HomeRosterLayoutPolicy.rowContentLeadingInset, 86)
        let scaled = HomeRosterLayoutPolicy.rowContentLeadingInset(
            paneWidth: HomeRosterLayoutPolicy.referenceWidth
        )
        XCTAssertEqual(scaled, HomeRosterLayoutPolicy.referenceTextColumnX, accuracy: 0.5)
    }

    func testPinnedHeroAvatarUsesReferenceSize() {
        let layout = PinnedChatShelfLayout.metrics(
            paneWidth: HomeRosterLayoutPolicy.referenceWidth,
            pinCount: 1
        )
        XCTAssertEqual(layout.mode, .hero)
        XCTAssertEqual(layout.avatar, 123, accuracy: 3)
        XCTAssertEqual(layout.spacing, 0)
    }

    func testPinnedHeroGroupCentersUpToThreePins() {
        let two = PinnedChatShelfLayout.metrics(
            paneWidth: HomeRosterLayoutPolicy.referenceWidth,
            pinCount: 2
        )
        XCTAssertEqual(two.mode, .hero)
        XCTAssertGreaterThan(two.spacing, 0)
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 3))
    }

    func testPinnedShelfOverflowsOnFourthPin() {
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 3))
        XCTAssertTrue(PinnedChatShelfLayout.overflows(pinCount: 4))
        let compact = PinnedChatShelfLayout.metrics(
            paneWidth: HomeRosterLayoutPolicy.referenceWidth,
            pinCount: 4
        )
        XCTAssertEqual(compact.mode, .compact)
        XCTAssertLessThan(compact.avatar, PinnedChatShelfLayout.heroAvatar)
    }

    func testPinnedShelfReservedHeightPlacesFirstRowNearReferenceY() {
        let reserved = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 13)
        )
        let firstRowY = HomeRosterLayoutPolicy.referenceSafeAreaTop
            + HomeRosterLayoutPolicy.headerChromeHeight
            + HomeRosterLayoutPolicy.shelfTopPadding
            + reserved
            + HomeRosterLayoutPolicy.shelfBottomPadding
        XCTAssertEqual(firstRowY, HomeRosterLayoutPolicy.referenceFirstRowY, accuracy: 2)
        XCTAssertGreaterThanOrEqual(reserved, PinnedChatShelfLayout.heroAvatar + 7 + 28)
    }

    func testPinnedShelfReservedHeightGrowsWithAccessibilityType() {
        let compact = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 11)
        )
        let large = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 22)
        )
        XCTAssertGreaterThanOrEqual(large, compact)
    }

    func testNarrowAccessibilityPaneKeepsReadableCompactPins() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 200, pinCount: 4)
        XCTAssertEqual(layout.mode, .compact)
        XCTAssertGreaterThanOrEqual(layout.avatar, PinnedChatShelfLayout.minimumAvatar)
    }
}
