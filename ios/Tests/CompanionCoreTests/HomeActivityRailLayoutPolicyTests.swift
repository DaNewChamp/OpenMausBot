import XCTest
@testable import CompanionCore

final class HomeActivityRailLayoutPolicyTests: XCTestCase {
    func testRegularCollapsedRailRetainsCompactPremiumMetrics() {
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedTitleLineLimit(isAccessibilitySize: false),
            1
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedSubtitleLineLimit(isAccessibilitySize: false),
            1
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedMinimumHeight(isAccessibilitySize: false),
            44
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedVerticalPadding(isAccessibilitySize: false),
            0
        )
    }

    func testAccessibilityCollapsedRailUsesCompactSingleLineLabels() {
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedTitleLineLimit(isAccessibilitySize: true),
            1
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedSubtitleLineLimit(isAccessibilitySize: true),
            1
        )
        XCTAssertTrue(
            HomeActivityRailLayoutPolicy.usesCompactCopy(isAccessibilitySize: true)
        )
        XCTAssertFalse(
            HomeActivityRailLayoutPolicy.usesCompactCopy(isAccessibilitySize: false)
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedMinimumHeight(isAccessibilitySize: true),
            112
        )
        XCTAssertEqual(
            HomeActivityRailLayoutPolicy.collapsedVerticalPadding(isAccessibilitySize: true),
            8
        )
    }

    func testAccessibilityRailIsTallerThanRegularRail() {
        XCTAssertGreaterThan(
            HomeActivityRailLayoutPolicy.collapsedMinimumHeight(isAccessibilitySize: true),
            HomeActivityRailLayoutPolicy.collapsedMinimumHeight(isAccessibilitySize: false)
        )
    }
}
