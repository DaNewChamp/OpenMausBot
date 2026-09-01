import XCTest
@testable import CompanionCore

final class HomeActivityArbitrationPolicyTests: XCTestCase {
    func testExpandedActivityOwnsSurfaceAndSuppressesIslandAndDismissalLayer() {
        let state = HomeActivityArbitrationPolicy.State(
            activityExpanded: true,
            needsYouAvailable: true
        )

        XCTAssertEqual(state.surface, .activity)
        XCTAssertFalse(state.islandPresentationAllowed)
        XCTAssertFalse(state.islandDismissalLayerAllowed)
    }

    func testNeedsYouOwnsSurfaceWhenActivityIsCollapsed() {
        let state = HomeActivityArbitrationPolicy.State(
            activityExpanded: false,
            needsYouAvailable: true
        )

        XCTAssertEqual(state.surface, .needsYouIsland)
        XCTAssertTrue(state.islandPresentationAllowed)
        XCTAssertTrue(state.islandDismissalLayerAllowed)
    }

    func testIdleSurfaceKeepsCollapsedIslandButNoDismissalLayer() {
        let state = HomeActivityArbitrationPolicy.State(
            activityExpanded: false,
            needsYouAvailable: false
        )

        XCTAssertEqual(state.surface, .idle)
        XCTAssertTrue(state.islandPresentationAllowed)
        XCTAssertFalse(state.islandDismissalLayerAllowed)
    }

    func testActivityExpansionTransitionReleasesIslandForPendingNeedsYou() {
        var state = HomeActivityArbitrationPolicy.State(
            activityExpanded: false,
            needsYouAvailable: true
        )

        state = state.settingActivityExpanded(true)
        XCTAssertEqual(state.surface, .activity)
        XCTAssertFalse(state.islandPresentationAllowed)
        XCTAssertFalse(state.islandDismissalLayerAllowed)

        state = state.settingActivityExpanded(false)
        XCTAssertEqual(state.surface, .needsYouIsland)
        XCTAssertTrue(state.islandPresentationAllowed)
        XCTAssertTrue(state.islandDismissalLayerAllowed)
    }
}
