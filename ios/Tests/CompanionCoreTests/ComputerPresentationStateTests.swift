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

    func testLocalVmControlsRequireCapabilityAndActionableStatus() {
        var status = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .missing,
            container: "missing",
            daemonUp: true,
            imageReady: true,
            desktopReady: false,
            ready: false,
            createSupported: true,
            busy: false,
            canCreate: true,
            canStop: false,
            canRecreate: false,
            problem: "Create this bot's Local VM."
        )
        let vm = bot(computer: "vm")
        XCTAssertTrue(ComputerPresentationState.supportsLocalVmControls(vm, status: status, accessGranted: true))
        XCTAssertFalse(ComputerPresentationState.supportsLocalVmControls(vm, status: status, accessGranted: false))

        status.canCreate = false
        status.canRecreate = true
        status.problem = "Recreate this bot's Local VM."
        XCTAssertTrue(ComputerPresentationState.supportsLocalVmControls(vm, status: status, accessGranted: true))

        let shared = LocalVmStatus(
            mode: .shared,
            maxInstances: 1,
            state: .stopped,
            container: "stopped",
            daemonUp: true,
            imageReady: true,
            desktopReady: false,
            ready: false,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: false,
            canRecreate: true,
            problem: "Recreate the Local VM."
        )
        XCTAssertTrue(ComputerPresentationState.supportsLocalVmControls(vm, status: shared, accessGranted: true))

        let idleShared = LocalVmStatus(
            mode: .shared,
            maxInstances: 1,
            state: .ready,
            container: "running",
            daemonUp: true,
            imageReady: true,
            desktopReady: true,
            ready: true,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: false,
            canRecreate: false,
            problem: nil
        )
        XCTAssertFalse(ComputerPresentationState.supportsLocalVmControls(vm, status: idleShared, accessGranted: true))
        XCTAssertFalse(ComputerPresentationState.supportsLocalVmControls(bot(computer: "local"), status: status, accessGranted: true))
    }

    func testMissingFrameStartsBeforeFailure() {
        XCTAssertEqual(ComputerPresentationState(bot: bot(computer: "local")), .starting)
    }

    func testAutoModeWithoutFrameWhileWorkingStarts() {
        XCTAssertEqual(ComputerPresentationState(bot: bot(computer: nil, busy: true)), .starting)
    }

    func testAutoModeWithFrameIsWatchableButNeverInteractive() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        let auto = bot(computer: nil, cloudBackend: "box", busy: true)
        XCTAssertEqual(ComputerPresentationState(bot: auto, frame: frame), .watching)
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(auto))
    }

    func testAutoModeWithoutWorkingBotHasNoLiveScreen() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: nil, busy: false)),
            .unavailable(message: "No live screen is available until this agent is working.")
        )
    }

    func testAutoModeStreamFailureIsUnavailable() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: nil, busy: true), loadFailure: "The stream is offline."),
            .unavailable(message: "The stream is offline.")
        )
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
            .unavailable(message: "No live screen is available until this agent is working.")
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

    func testOffAndUnknownComputersIgnoreValidCachedFrames() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "off"), frame: frame),
            .unavailable(message: "Computer access is turned off for this agent.")
        )
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: nil, busy: true), frame: frame),
            .watching
        )
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "future-desktop"), frame: frame),
            .unavailable(message: "This computer type isn't supported on this phone.")
        )
    }

    func testIdleComputerIgnoresValidCachedFrame() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "local", busy: false), frame: frame),
            .unavailable(message: "No live screen is available until this agent is working.")
        )
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "cloud", cloudBackend: "box", busy: false), frame: frame),
            .cloudViewerAvailable
        )
    }

    func testIdleLocalVmShowsCachedFrame() {
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "vm", busy: false), frame: frame),
            .watching
        )
    }

    func testIdleLocalVmWithoutFrameStarts() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "vm", busy: false)),
            .starting
        )
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

        lifecycle.reset()
        XCTAssertEqual(lifecycle.phase, .idle)
        XCTAssertEqual(lifecycle.attempt, 3)

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
