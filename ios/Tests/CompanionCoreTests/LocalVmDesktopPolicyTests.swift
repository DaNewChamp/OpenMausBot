import XCTest
@testable import CompanionCore

final class LocalVmDesktopPolicyTests: XCTestCase {
    private func bot(computer: String = "vm", busy: Bool? = false) -> Bot {
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
            cloudBackend: nil,
            speakReplies: false,
            voice: nil,
            mascotExpression: nil,
            tasks: nil,
            messages: nil,
            activeLeafId: nil,
            hasMore: nil
        )
    }

    private func status(
        state: LocalVmStatus.State,
        ready: Bool = false,
        canCreate: Bool = false,
        canStop: Bool = false,
        canRecreate: Bool = false,
        problem: String? = nil
    ) -> LocalVmStatus {
        LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: state,
            container: state == .ready ? "running" : state.rawValue,
            daemonUp: state != .unavailable,
            imageReady: true,
            desktopReady: ready,
            ready: ready,
            createSupported: true,
            busy: false,
            canCreate: canCreate,
            canStop: canStop,
            canRecreate: canRecreate,
            problem: problem
        )
    }

    func testMissingStatusWithoutGrantIsAccessOffNotInteractive() {
        let surface = LocalVmDesktopPolicy.surface(bot: bot(), snapshot: .init(accessGranted: false))
        XCTAssertEqual(surface, .unavailable(message: LocalVmDesktopPolicy.accessOffMessage, retry: false))
        XCTAssertFalse(surface.isInteractive)
        XCTAssertEqual(surface.presentationState, .unavailable(message: LocalVmDesktopPolicy.accessOffMessage))
    }

    func testCheckingThenStartingThenReadyJoin() {
        let vm = bot()
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(bot: vm, snapshot: .init(accessGranted: true)),
            .checking
        )
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: status(state: .running, problem: "The Local VM desktop is still starting."),
                    accessGranted: true
                )
            ),
            .starting(message: "The Local VM desktop is still starting.")
        )
        let ready = status(state: .ready, ready: true, canStop: true, canRecreate: true)
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(bot: vm, snapshot: .init(status: ready, accessGranted: true)),
            .starting(message: LocalVmDesktopPolicy.openingLiveDesktopMessage)
        )
        XCTAssertTrue(LocalVmDesktopPolicy.shouldJoinViewer(bot: vm, snapshot: .init(status: ready, accessGranted: true)))
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: ready,
                    accessGranted: true,
                    viewerURLPresent: true,
                    viewerReady: true
                )
            ),
            .liveViewer
        )
    }

    func testStoppedAndMissingAreHonestUnavailable() {
        let vm = bot()
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: status(state: .missing, canCreate: true, problem: "Create this bot's Local VM."),
                    accessGranted: true
                )
            ),
            .unavailable(message: "Create this bot's Local VM.", retry: false)
        )
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: status(state: .stopped, canRecreate: true),
                    accessGranted: true
                )
            ),
            .unavailable(message: LocalVmDesktopPolicy.stoppedMessage, retry: false)
        )
    }

    func testViewerFailureFallsBackToScreenshotNeverSilentBlack() {
        let vm = bot()
        let ready = status(state: .ready, ready: true, canStop: true, canRecreate: true)
        XCTAssertEqual(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: ready,
                    accessGranted: true,
                    hasScreenshot: true,
                    viewerFailed: true
                )
            ),
            .screenshotInteractive
        )
        XCTAssertTrue(
            LocalVmDesktopPolicy.surface(
                bot: vm,
                snapshot: .init(
                    status: ready,
                    accessGranted: true,
                    hasScreenshot: true,
                    viewerFailed: true
                )
            ).isInteractive
        )
        let empty = LocalVmDesktopPolicy.surface(
            bot: vm,
            snapshot: .init(status: ready, accessGranted: true, viewerFailed: true)
        )
        XCTAssertEqual(empty, .unavailable(message: LocalVmDesktopPolicy.viewerConnectFailureMessage, retry: true))
        XCTAssertTrue(empty.showsRetry)
        XCTAssertFalse(empty.isInteractive)
    }

    func testIdleStartingUnavailableCopyNeverClaimsLiveViewer() {
        XCTAssertFalse(
            LocalVmDesktopPolicy.surface(
                bot: bot(),
                snapshot: .init(status: status(state: .running), accessGranted: true)
            ).isInteractive
        )
        XCTAssertFalse(
            LocalVmDesktopPolicy.surface(
                bot: bot(),
                snapshot: .init(status: status(state: .missing, canCreate: true), accessGranted: true)
            ).isInteractive
        )
        XCTAssertFalse(
            LocalVmDesktopPolicy.surface(
                bot: bot(),
                snapshot: .init(accessGranted: false, hasScreenshot: true)
            ).isInteractive
        )
    }

    func testUnknownInstanceCannotSelectLocalVmDestination() {
        XCTAssertFalse(LocalVmDesktopPolicy.destinationControlsEnabled(isLoading: false, instanceResolved: false))
        XCTAssertFalse(LocalVmDesktopPolicy.destinationControlsEnabled(isLoading: true, instanceResolved: true))
        XCTAssertTrue(LocalVmDesktopPolicy.destinationControlsEnabled(isLoading: false, instanceResolved: true))
    }

    func testPointerModeDoesNotRemountViewer() {
        XCTAssertFalse(LocalVmDesktopPolicy.remountsViewerWhenPointerModeChanges())
    }

    func testStaleTicketReloadsOnlyWhenGenerationChanges() throws {
        let first = try XCTUnwrap(URL(string: "http://127.0.0.1:8810/api/bots/b/local-computer/viewer/vnc.html?omb_viewer=ticket-1#autoconnect=true"))
        let second = try XCTUnwrap(URL(string: "http://127.0.0.1:8810/api/bots/b/local-computer/viewer/vnc.html?omb_viewer=ticket-2#autoconnect=true"))
        XCTAssertEqual(
            LocalVmDesktopPolicy.stableViewerKey(for: first),
            LocalVmDesktopPolicy.stableViewerKey(for: second)
        )
        XCTAssertFalse(LocalVmDesktopPolicy.shouldReloadViewer(stableKeyChanged: false, generationChanged: false))
        XCTAssertTrue(LocalVmDesktopPolicy.shouldReloadViewer(stableKeyChanged: false, generationChanged: true))
        XCTAssertTrue(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 0, reason: .staleTicket))
        XCTAssertTrue(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 1, reason: .staleTicket))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 2, reason: .staleTicket))
        XCTAssertEqual(LocalVmDesktopPolicy.failure(forHTTPStatus: 401), .staleTicket)
        XCTAssertEqual(LocalVmDesktopPolicy.message(for: .staleTicket), LocalVmDesktopPolicy.staleTicketMessage)
        XCTAssertEqual(LocalVmDesktopPolicy.viewerBlankTimeout, .seconds(8))
    }

    func testBlankTimeoutFallsBackAfterBudget() {
        XCTAssertTrue(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 0, reason: .blankTimeout))
        XCTAssertTrue(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 1, reason: .blankTimeout))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: 2, reason: .blankTimeout))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldJoinViewer(
            bot: bot(),
            snapshot: .init(
                status: status(state: .ready, ready: true),
                accessGranted: true,
                viewerFailed: true
            )
        ))
    }

    func testStatusPollingStopsAfterAccessDenied() {
        XCTAssertTrue(LocalVmDesktopPolicy.shouldPollStatus(bot: bot(), accessDenied: false))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldPollStatus(bot: bot(), accessDenied: true))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldPollStatus(bot: bot(computer: "cloud"), accessDenied: false))
        XCTAssertTrue(LocalVmDesktopPolicy.continueStatusPolling(isLocalVm: true, accessDenied: false))
        XCTAssertFalse(LocalVmDesktopPolicy.continueStatusPolling(isLocalVm: true, accessDenied: true))
        XCTAssertFalse(LocalVmDesktopPolicy.continueStatusPolling(isLocalVm: false, accessDenied: false))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldPollScreenshot(
            bot: bot(),
            snapshot: .init(status: status(state: .missing, canCreate: true), accessGranted: true)
        ))
        XCTAssertTrue(LocalVmDesktopPolicy.shouldPollScreenshot(
            bot: bot(),
            snapshot: .init(status: status(state: .ready, ready: true), accessGranted: true)
        ))
        XCTAssertFalse(LocalVmDesktopPolicy.shouldPollScreenshot(
            bot: bot(),
            snapshot: .init(
                status: status(state: .ready, ready: true),
                accessGranted: true,
                viewerReady: true
            )
        ))
    }

    func testScreenshotWatchSkipsLocalVmSSETimeout() {
        XCTAssertFalse(LocalVmDesktopPolicy.usesLiveScreenStreamTimeout())
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: nil, accessGranted: true))
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: status(state: .running), accessGranted: true))
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: status(state: .ready, ready: true), accessGranted: true))
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: status(state: .missing), accessGranted: true))
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: status(state: .stopped), accessGranted: true))
        XCTAssertFalse(LocalVmDesktopPolicy.wantsScreenshotWatch(status: status(state: .running), accessGranted: false))
    }

    func testViewerURLIsNeverAPersistableStatusKey() {
        XCTAssertTrue(LocalVmDesktopPolicy.forbiddenPersistedKeys.contains("viewer_url"))
        XCTAssertTrue(LocalVmDesktopPolicy.forbiddenPersistedKeys.contains("viewer_path"))
        XCTAssertTrue(LocalVmDesktopPolicy.forbiddenPersistedKeys.contains("omb_viewer"))
        XCTAssertTrue(LocalVmDesktopPolicy.encodedObjectIsPhoneSafe(["state": "ready", "ready": true]))
        XCTAssertFalse(LocalVmDesktopPolicy.encodedObjectIsPhoneSafe(["viewer_url": "http://127.0.0.1:6080/vnc.html"]))
        XCTAssertFalse(LocalVmDesktopPolicy.encodedObjectIsPhoneSafe(["viewerPath": "/api/bots/b/local-computer/viewer/vnc.html"]))
    }
}
