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
        XCTAssertTrue(HermesConnectionCardPolicy.shouldKeepPending(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: nil,
            isLoading: false,
            hasAttemptedStatusFetch: false
        )))
        XCTAssertFalse(HermesConnectionCardPolicy.shouldKeepPending(.init(
            isPending: true,
            isDismissed: false,
            hermesStatus: nil,
            isLoading: false,
            hasAttemptedStatusFetch: true
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

    func testMultiConnectionPendingAndDismissAreIndependent() {
        let ready = HermesSetupStatus(state: .ready)
        let contextA = HermesConnectionCardContext(
            isPending: true,
            isDismissed: false,
            hermesStatus: ready,
            isLoading: false
        )
        let contextB = HermesConnectionCardContext(
            isPending: true,
            isDismissed: false,
            hermesStatus: ready,
            isLoading: false
        )

        XCTAssertTrue(HermesConnectionCardPolicy.shouldShow(contextA))
        XCTAssertTrue(HermesConnectionCardPolicy.shouldShow(contextB))

        let dismissedA = HermesConnectionCardContext(
            isPending: true,
            isDismissed: true,
            hermesStatus: ready,
            isLoading: false
        )
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(dismissedA))
        XCTAssertTrue(HermesConnectionCardPolicy.shouldShow(contextB))

        let clearedAStillPendingB = HermesConnectionCardContext(
            isPending: false,
            isDismissed: true,
            hermesStatus: ready,
            isLoading: false
        )
        XCTAssertFalse(HermesConnectionCardPolicy.shouldShow(clearedAStillPendingB))
        XCTAssertTrue(HermesConnectionCardPolicy.shouldShow(contextB))
    }

    func testPerConnectionPreferenceKeysAreDistinct() {
        let first = CompanionOnboardingPreferences.pendingHermesConnectionCardKey(connectionID: "mac-a")
        let second = CompanionOnboardingPreferences.pendingHermesConnectionCardKey(connectionID: "mac-b")
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(
            CompanionOnboardingPreferences.dismissedHermesConnectionCardKey(connectionID: "mac-a"),
            "companion.onboarding.hermesCardDismissed.mac-a"
        )
    }

    func testCardConnectNavigationResolvesImportedBot() {
        let response = HermesSetupConnectionResponse(
            botId: "hermes-bot",
            profile: HermesSetupProfile(
                profile: "default",
                handle: "hermes",
                displayName: "Hermes",
                description: ""
            ),
            status: HermesSetupStatus(state: .connected),
            created: true
        )
        XCTAssertEqual(
            HermesConnectionCardPolicy.navigationBotID(afterConnect: response),
            "hermes-bot"
        )
        XCTAssertNil(HermesConnectionCardPolicy.navigationBotID(afterConnect: nil))
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
