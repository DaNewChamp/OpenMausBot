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
        XCTAssertEqual(layout.avatar, 590 * 0.22, accuracy: 1)
        XCTAssertEqual(layout.spacing, 0)
    }

    func testPinnedHeroAvatarTargetsPhoneWidthBand() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 402, pinCount: 1)
        XCTAssertEqual(layout.avatar, 88.44, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(layout.avatar / 402, 0.21)
        XCTAssertLessThanOrEqual(layout.avatar / 402, 0.23)
    }

    func testPinnedHeroGroupCentersUpToThreePins() {
        let two = PinnedChatShelfLayout.metrics(
            paneWidth: HomeRosterLayoutPolicy.referenceWidth,
            pinCount: 2
        )
        XCTAssertEqual(two.mode, .hero)
        XCTAssertGreaterThan(two.spacing, 0)
        XCTAssertFalse(PinnedChatShelfLayout.overflows(pinCount: 3))
        XCTAssertTrue(heroGroupFits(paneWidth: HomeRosterLayoutPolicy.referenceWidth, pinCount: 2))
        XCTAssertTrue(heroGroupFits(paneWidth: HomeRosterLayoutPolicy.referenceWidth, pinCount: 3))
    }

    func testSinglePinKeepsHeroAvatarOnNarrowPhone() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 390, pinCount: 1)
        XCTAssertEqual(layout.mode, .hero)
        XCTAssertEqual(layout.avatar, 85.8, accuracy: 0.5)
        XCTAssertEqual(layout.spacing, 0)
        XCTAssertTrue(heroGroupFits(paneWidth: 390, pinCount: 1))
    }

    func testTwoPinsKeepHeroAvatarWhenTheGroupFits() {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: 390, pinCount: 2)
        XCTAssertEqual(layout.mode, .hero)
        XCTAssertEqual(layout.avatar, 85.8, accuracy: 0.5)
        XCTAssertGreaterThan(layout.spacing, 0)
        XCTAssertTrue(heroGroupFits(paneWidth: 390, pinCount: 2))
    }

    func testThreePinsShrinkToFitNarrowPhoneWithoutClipping() {
        let pane: CGFloat = 190
        let layout = PinnedChatShelfLayout.metrics(paneWidth: pane, pinCount: 3)
        XCTAssertEqual(layout.mode, .hero)
        XCTAssertLessThan(layout.avatar, PinnedChatShelfLayout.heroAvatarSize(paneWidth: pane))
        XCTAssertGreaterThan(layout.avatar, 0)
        XCTAssertEqual(layout.avatar, layout.tile)
        XCTAssertTrue(heroGroupFits(paneWidth: pane, pinCount: 3))
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
        XCTAssertLessThan(compact.avatar, PinnedChatShelfLayout.heroAvatarSize(paneWidth: HomeRosterLayoutPolicy.referenceWidth))
    }

    func testPinnedShelfReservedHeightIsHeroContentNotStretchedBand() {
        let name = PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 13)
        let reserved = PinnedChatShelfLayout.reservedHeight(nameBlockHeight: name)
        XCTAssertEqual(reserved, PinnedChatShelfLayout.heroAvatar + 7 + name)
        XCTAssertEqual(reserved, 123.44, accuracy: 0.5)
        XCTAssertLessThan(reserved, 249)
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

    func testZeroPinAndLoadingShelfReserveNoHeight() {
        XCTAssertFalse(
            CalmSurfacePolicy.reservesPinnedShelfRegion(pinCount: 0, animatingCollapse: false)
        )
        XCTAssertEqual(
            PinnedChatShelfLayout.reservedHeight(
                pinCount: 0,
                rosterResolved: false,
                animatingCollapse: false,
                nameBlockHeight: PinnedChatShelfLayout.nameBlock
            ),
            0
        )
        XCTAssertEqual(
            PinnedChatShelfLayout.reservedHeight(
                pinCount: 0,
                rosterResolved: true,
                animatingCollapse: false,
                nameBlockHeight: PinnedChatShelfLayout.nameBlock
            ),
            0
        )
        let shown = PinnedChatShelfLayout.reservedHeight(
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 13)
        )
        XCTAssertEqual(shown, 123.44, accuracy: 0.5)
        XCTAssertNotEqual(
            PinnedChatShelfLayout.reservedHeight(
                pinCount: 0,
                rosterResolved: false,
                animatingCollapse: false,
                nameBlockHeight: PinnedChatShelfLayout.nameBlock
            ),
            shown
        )
    }

    func testResolvedPinnedShelfHeightIsStableAcrossHeroCounts() {
        let name = PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 13)
        let one = PinnedChatShelfLayout.reservedHeight(
            pinCount: 1,
            rosterResolved: true,
            animatingCollapse: false,
            nameBlockHeight: name
        )
        let three = PinnedChatShelfLayout.reservedHeight(
            pinCount: 3,
            rosterResolved: true,
            animatingCollapse: false,
            nameBlockHeight: name
        )
        XCTAssertEqual(one, three)
        XCTAssertEqual(one, 123.44, accuracy: 0.5)
        let collapsing = PinnedChatShelfLayout.reservedHeight(
            pinCount: 0,
            rosterResolved: true,
            animatingCollapse: true,
            nameBlockHeight: name
        )
        XCTAssertEqual(collapsing, one)
    }

    func testReferenceCanvasPlacesFirstRowNearY400() {
        let reserved = PinnedChatShelfLayout.reservedHeight(
            pinCount: 1,
            rosterResolved: true,
            animatingCollapse: false,
            nameBlockHeight: PinnedChatShelfLayout.nameBlockHeight(captionLineHeight: 13)
        )
        let firstRowPt = HomeRosterLayoutPolicy.referenceSafeAreaTop
            + HomeRosterLayoutPolicy.headerChromeHeight
            + HomeRosterLayoutPolicy.shelfTopPadding
            + reserved
            + HomeRosterLayoutPolicy.shelfBottomPadding
        let y590 = HomeRosterLayoutPolicy.screenshotY(
            pointY: firstRowPt,
            paneWidth: 402
        )
        // 88pt hero + 56pt chrome cannot land on image-y 400; do not stretch
        // empty shelf to fake it. Content-sized reservation sits in-band.
        XCTAssertEqual(firstRowPt, 274.44, accuracy: 2)
        XCTAssertEqual(y590, 403, accuracy: 12)
        XCTAssertGreaterThan(y590, 380)
        XCTAssertLessThan(y590, 430)
        XCTAssertEqual(HomeRosterLayoutPolicy.profileDiameter, 56)
        XCTAssertEqual(HomeRosterLayoutPolicy.chromeButtonDiameter, 58)
        XCTAssertEqual(HomeRosterLayoutPolicy.rowAvatar, 58)
        XCTAssertEqual(HomeRosterLayoutPolicy.rowMinHeight, 104)
        XCTAssertEqual(
            HomeRosterLayoutPolicy.referenceCanvasY(400, paneWidth: 402),
            272.5,
            accuracy: 0.5
        )
    }

    private func heroGroupFits(paneWidth: CGFloat, pinCount: Int) -> Bool {
        let layout = PinnedChatShelfLayout.metrics(paneWidth: paneWidth, pinCount: pinCount)
        let inner = paneWidth - PinnedChatShelfLayout.pagePadding * 2
        let width = CGFloat(pinCount) * layout.tile + CGFloat(max(pinCount - 1, 0)) * layout.spacing
        return width <= inner + 0.5
    }
}
