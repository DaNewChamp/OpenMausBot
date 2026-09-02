import XCTest
@testable import CompanionCore

final class HermesConnectionCardPolicyTests: XCTestCase {
    func testShowsConnectableHermesOfferAfterPairUntilDismissed() {
        let ready = HermesSetupStatus(state: .ready)
        XCTAssertTrue(HermesConnectionCardPolicy.shouldShow(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: ready,
            isLoading: false
        )))
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(.init(
            isPending: true,
            isDismissed: true,
            hermesStatus: ready,
            isLoading: false
        )))
    }

    func testHidesCardWhenHermesIsAlreadyConnectedOrUnavailable() {
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: HermesSetupStatus(state: .connected),
            isLoading: false
        )))
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: HermesSetupStatus(state: .unavailable, reason: .missingCLI),
            isLoading: false
        )))
    }

    func testPendingMarkerSurvivesLoadingThenClearsWhenHermesCannotConnect() {
        XCTAssertTrue(HermesConnectionCardPolicy.shouldKeepPending(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: nil,
            isLoading: true
        )))
        XCTAssertFalse(HermesConnectionCardPolicy.shouldKeepPending(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: HermesSetupStatus(state: .unavailable, reason: .missingCLI),
            isLoading: false
        )))
        XCTAssertFalse(HermesConnectionCardPolicy.shouldKeepPending(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: HermesSetupStatus(state: .connected),
            isLoading: false
        )))
    }

    func testCardPresentationUsesSafeSetupCopyWithoutSecrets() {
        let presentation = HermesConnectionCardPolicy.presentation(
            status: HermesSetupStatus(state: .ready),
            isLoading: false
        )
        XCTAssertEqual(presentation.title, "Connect Hermes")
        XCTAssertEqual(presentation.primaryActionTitle, "Connect Hermes")
        XCTAssertFalse(presentation.detail?.localizedCaseInsensitiveContains("token") ?? false)
    }

    func testDismissPersistsPerComputerWithoutBlockingChatsRoute() {
        let connectionID = "studio-mac"
        let key = CompanionOnboardingPreferences.dismissedHermesConnectionCardKey(connectionID: connectionID)
        XCTAssertEqual(
            key,
            "companion.onboarding.hermesCardDismissed.studio-mac"
        )
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(.init(
            isPending: false,
            isDismissed: true,
            hermesStatus: HermesSetupStatus(state: .ready),
            isLoading: false
        )))
    }
}
