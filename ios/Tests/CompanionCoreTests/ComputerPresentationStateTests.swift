import XCTest
@testable import CompanionCore

final class ComputerPresentationStateTests: XCTestCase {
    private func bot(computer: String?, cloudBackend: String? = nil, busy: Bool? = true) -> Bot {
        Bot(
            id: "bot-1",
            threadId: "thread-1",
            name: "Scout",
            title: "Researcher",
            description: "Finds the facts.",
            notifications: true,
            color: "cyan",
            avatarUrl: nil,
            avatarCrop: nil,
            unread: false,
            modelSelection: ModelSelection(instanceId: "preview", model: "preview"),
            createdAt: 1,
            busy: busy,
            pinned: false,
            hidden: false,
            chiefOfStaff: false,
            autoApprove: false,
            alwaysAllow: nil,
            computer: computer,
            cloudBackend: cloudBackend,
            speakReplies: false,
            voice: nil,
            mascotExpression: nil,
            tasks: nil,
            messages: nil,
            activeLeafId: nil,
            hasMore: nil
        )
    }

    func testCloudBoxWithoutFrameOffersSecureViewer() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "cloud", cloudBackend: "box")),
            .cloudViewerAvailable
        )
        XCTAssertTrue(ComputerPresentationState.supportsCloudViewer(bot(computer: "cloud")))
    }

    func testOnlyExplicitBoxAndLegacyCloudOfferSecureViewer() {
        XCTAssertTrue(ComputerPresentationState.supportsCloudViewer(bot(computer: "cloud", cloudBackend: "box")))
        XCTAssertTrue(ComputerPresentationState.supportsCloudViewer(bot(computer: "cloud", cloudBackend: nil)))
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(bot(computer: "cloud", cloudBackend: "future-box")))
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(bot(computer: "cloud", cloudBackend: "vps")))
    }

    func testVPSNeverClaimsInteractiveViewerSupport() {
        let state = ComputerPresentationState(bot: bot(computer: "cloud", cloudBackend: "vps"))
        XCTAssertNotEqual(state, .cloudViewerAvailable)
    }

    func testLocalAndVirtualMachinesNeverClaimInteractiveViewerSupport() {
        XCTAssertNotEqual(ComputerPresentationState(bot: bot(computer: "local")), .cloudViewerAvailable)
        XCTAssertNotEqual(ComputerPresentationState(bot: bot(computer: "vm")), .cloudViewerAvailable)
    }

    func testMissingFrameStartsBeforeFailure() {
        XCTAssertEqual(ComputerPresentationState(bot: bot(computer: "local")), .starting)
    }

    func testIdleKnownComputerDoesNotSpinForever() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "local", busy: false)),
            .unavailable(message: "No live screen is available until this agent is working.")
        )
    }

    func testOffAndUnknownComputersAreUnavailable() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "off", busy: false)),
            .unavailable(message: "Computer access is turned off for this agent.")
        )
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: nil, busy: false)),
            .unavailable(message: "No computer is configured for this agent.")
        )
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "quantum-desktop", busy: true)),
            .unavailable(message: "This computer type isn't supported on this phone.")
        )
    }

    func testLoadFailureBecomesUnavailable() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "local"), loadFailure: "The stream timed out."),
            .unavailable(message: "The stream timed out.")
        )
    }

    func testEmptyLoadFailureUsesSafeMessage() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "local"), loadFailure: "  "),
            .unavailable(message: "We couldn't load this computer right now.")
        )
    }

    func testReceivedFrameIsWatching() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(ComputerPresentationState(bot: bot(computer: "local"), frame: frame), .watching)
    }

    func testLoadFailureWinsOverStaleFrame() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(
            ComputerPresentationState(
                bot: bot(computer: "cloud", cloudBackend: "box", busy: false),
                frame: frame,
                loadFailure: "The screen stream ended."
            ),
            .unavailable(message: "The screen stream ended.")
        )
    }

    func testWatchLifecycleResetsFailuresOnRetryAndFrame() {
        var lifecycle = ComputerWatchLifecycle()
        lifecycle.begin()
        XCTAssertTrue(lifecycle.isWaiting)
        lifecycle.timedOut()
        XCTAssertEqual(lifecycle.failureMessage, "No screen frame arrived. The computer may be asleep or unavailable.")

        lifecycle.retry()
        XCTAssertTrue(lifecycle.isWaiting)
        XCTAssertNil(lifecycle.failureMessage)
        XCTAssertEqual(lifecycle.attempt, 2)

        lifecycle.receivedFrame()
        XCTAssertEqual(lifecycle.phase, .watching)
        XCTAssertNil(lifecycle.failureMessage)

        lifecycle.failed("The stream ended.")
        XCTAssertEqual(lifecycle.failureMessage, "The stream ended.")
        lifecycle.receivedFrame()
        XCTAssertEqual(lifecycle.phase, .watching)
    }

    func testWatchLifecycleSanitizesEmptyFailures() {
        var lifecycle = ComputerWatchLifecycle()
        lifecycle.failed("  ")
        XCTAssertEqual(lifecycle.failureMessage, "We couldn't load this computer right now.")
    }
}
