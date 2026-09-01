import XCTest
@testable import CompanionCore

final class ConnectionResiliencePolicyTests: XCTestCase {
    func testInitialConnectingProjectsToHaloWithoutRosterText() {
        let banner = ConnectionResiliencePolicy.banner(
            previouslyLive: false,
            connecting: true
        )

        XCTAssertTrue(banner.showsConnectingHalo)
        XCTAssertFalse(banner.showsRosterText)
        XCTAssertTrue(banner.isVisible)
        XCTAssertEqual(banner.accessibilityLabel, ConnectionResiliencePolicy.connectingAccessibility)
    }

    func testOnlyHiddenBannersAreNotVisibleToLegacyCallers() {
        let hidden = ConnectionResiliencePolicy.banner(
            live: true,
            previouslyLive: false
        )

        XCTAssertEqual(hidden.kind, ConnectionResiliencePolicy.BannerKind.hidden)
        XCTAssertFalse(hidden.isVisible)
        XCTAssertFalse(hidden.showsRosterText)
    }

    func testReconnectOfflineAndUnauthorizedRemainActionableRosterBanners() {
        let reconnecting = ConnectionResiliencePolicy.banner(
            previouslyLive: true,
            connecting: true
        )
        XCTAssertFalse(reconnecting.showsConnectingHalo)
        XCTAssertTrue(reconnecting.showsRosterText)

        let offline = ConnectionResiliencePolicy.banner(
            previouslyLive: true,
            offlineReason: "No route to host secret.example"
        )
        XCTAssertTrue(offline.showsRosterText)
        XCTAssertEqual(offline.accessibilityLabel, ConnectionResiliencePolicy.offlineAccessibility)
        XCTAssertFalse(offline.accessibilityLabel.contains("secret.example"))

        let unauthorized = ConnectionResiliencePolicy.banner(
            unauthorized: true,
            previouslyLive: true
        )
        XCTAssertTrue(unauthorized.showsRosterText)
        XCTAssertFalse(unauthorized.showsConnectingHalo)
    }
}
