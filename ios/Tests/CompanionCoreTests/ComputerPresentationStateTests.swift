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

    func testIdleVpsCloudExplainsWatchDuringTurns() {
        XCTAssertEqual(
            ComputerPresentationState(bot: bot(computer: "cloud", cloudBackend: "vps", busy: false)),
            .unavailable(message: CloudViewerPolicy.vpsWatchCopy)
        )
        XCTAssertTrue(CloudViewerPolicy.vpsWatchCopy.contains(CloudViewerPolicy.interactiveUnavailable))
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

    func testLocalVmMissingStatusIsUnavailableNotStarting() {
        let missing = LocalVmStatus(
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
        XCTAssertEqual(
            ComputerPresentationState(
                bot: bot(computer: "vm", busy: false),
                localVm: .init(status: missing, accessGranted: true)
            ),
            .unavailable(message: "Create this bot's Local VM.")
        )
    }

    func testLocalVmViewerFailureWithFrameStaysWatching() {
        let ready = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .ready,
            container: "running",
            daemonUp: true,
            imageReady: true,
            desktopReady: true,
            ready: true,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: true,
            canRecreate: true,
            problem: nil
        )
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(
            ComputerPresentationState(
                bot: bot(computer: "vm", busy: false),
                frame: frame,
                localVm: .init(
                    status: ready,
                    accessGranted: true,
                    hasScreenshot: true,
                    viewerFailed: true
                )
            ),
            .watching
        )
        XCTAssertEqual(
            ComputerPresentationState(
                bot: bot(computer: "vm", busy: false),
                localVm: .init(status: ready, accessGranted: true, viewerFailed: true)
            ),
            .unavailable(message: LocalVmDesktopPolicy.viewerConnectFailureMessage)
        )
    }

    func testLocalVmAccessOffDoesNotClaimInteractiveViewer() {
        XCTAssertEqual(
            ComputerPresentationState(
                bot: bot(computer: "vm", busy: false),
                localVm: .init(accessGranted: false)
            ),
            .unavailable(message: LocalVmDesktopPolicy.accessOffMessage)
        )
        XCTAssertFalse(
            ComputerPresentationState.supportsLocalVmControls(
                bot(computer: "vm"),
                status: nil,
                accessGranted: false
            )
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

    func testIdleVpsShowsWaitingMessageWithoutSecureViewer() {
        let idleVps = bot(computer: "cloud", cloudBackend: "vps", busy: false)
        XCTAssertEqual(
            ComputerPresentationState(bot: idleVps),
            .unavailable(message: CloudViewerPolicy.vpsWatchCopy)
        )
        XCTAssertFalse(ComputerPresentationState(bot: idleVps).isIdleWaiting)
        XCTAssertEqual(
            ComputerPresentationState.watchCaption(for: idleVps),
            CloudViewerPolicy.vpsBusyWatchCopy
        )
        XCTAssertNil(ComputerPresentationState.watchCaption(for: bot(computer: "cloud", cloudBackend: "box")))
        XCTAssertNil(ComputerPresentationState.watchCaption(for: bot(computer: "vm")))
    }

    func testStreamLoadFailureIgnoresWatchTimeoutWhenIdle() {
        let idleVps = bot(computer: "cloud", cloudBackend: "vps", busy: false)
        let timeout = "No screen frame arrived. The computer may be asleep or unavailable."
        XCTAssertNil(
            ComputerPresentationState.streamLoadFailure(
                streamFailure: nil,
                watchFailure: timeout,
                wantsScreenPreview: false
            )
        )
        XCTAssertEqual(
            ComputerPresentationState(
                bot: idleVps,
                loadFailure: ComputerPresentationState.streamLoadFailure(
                    streamFailure: nil,
                    watchFailure: timeout,
                    wantsScreenPreview: false
                )
            ),
            .unavailable(message: CloudViewerPolicy.vpsWatchCopy)
        )
    }

    func testStreamLoadFailureKeepsWatchTimeoutWhileWorking() {
        let busyVps = bot(computer: "cloud", cloudBackend: "vps", busy: true)
        let timeout = "No screen frame arrived. The computer may be asleep or unavailable."
        XCTAssertEqual(
            ComputerPresentationState.streamLoadFailure(
                streamFailure: nil,
                watchFailure: timeout,
                wantsScreenPreview: true
            ),
            timeout
        )
        XCTAssertEqual(
            ComputerPresentationState(
                bot: busyVps,
                loadFailure: timeout
            ),
            .unavailable(message: timeout)
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

    func testCloudJoinURLMustBePublicHTTPSAndNeverLoopback() throws {
        let valid = try XCTUnwrap(CloudViewerPolicy.validatedJoinURL(
            "https://desktop.example/session/fresh?ticket=secret#autoconnect"
        ))
        XCTAssertEqual(valid.scheme, "https")
        XCTAssertEqual(valid.host, "desktop.example")
        XCTAssertTrue(valid.absoluteString.contains("ticket=secret"))
        XCTAssertEqual(
            CloudViewerPolicy.sanitizedOrigin(for: valid),
            "https://desktop.example"
        )
        XCTAssertFalse(CloudViewerPolicy.sanitizedOrigin(for: valid)?.contains("ticket") == true)

        for raw in [
            "http://desktop.example/session",
            "https://127.0.0.1/vnc",
            "https://localhost/vnc",
            "https://[::1]/vnc",
            "https://192.168.1.42/vnc",
            "https://10.0.0.8/vnc",
            "https://mac.local/vnc",
            "https://user:pass@desktop.example/session",
            "https://user@desktop.example/session",
            "https://169.254.1.1/vnc",
            "https://172.16.0.8/vnc",
            "https://172.31.255.1/vnc",
            "https://local/vnc",
            "https://internal/vnc",
            "https://gateway/session",
            "javascript:alert(1)",
            "not a URL",
        ] {
            XCTAssertNil(CloudViewerPolicy.validatedJoinURL(raw), raw)
        }
        XCTAssertNil(CloudViewerPolicy.validatedJoinURL("https://local"))
        XCTAssertNotNil(CloudViewerPolicy.validatedJoinURL("https://box.example/session"))
        XCTAssertTrue(CloudViewerPolicy.isForbiddenViewerHost("local"))
        XCTAssertTrue(CloudViewerPolicy.isForbiddenViewerHost("169.254.12.4"))
        XCTAssertTrue(CloudViewerPolicy.isForbiddenViewerHost("172.16.4.2"))
        XCTAssertFalse(CloudViewerPolicy.isForbiddenViewerHost("desktop.example"))
    }

    func testCloudJoinURLSanitizesOriginAndRejectsPersistence() throws {
        let url = try XCTUnwrap(CloudViewerPolicy.validatedJoinURL(
            "https://box.example:8443/vnc.html?omb_viewer=ticket-1#autoconnect=true"
        ))
        XCTAssertEqual(CloudViewerPolicy.sanitizedOrigin(for: url), "https://box.example:8443")
        XCTAssertTrue(CloudViewerPolicy.originAccessibilityLabel(for: url).contains("External cloud desktop"))
        XCTAssertFalse(CloudViewerPolicy.originAccessibilityLabel(for: url).contains("ticket"))
        XCTAssertTrue(CloudViewerPolicy.persistableViewerKeys.isEmpty)
        XCTAssertTrue(CloudViewerPolicy.externalSemantics.contains("does not keep"))
    }

    func testCloudDesktopSessionDecoderUsesTheSameHTTPSPolicy() throws {
        let valid = Data(#"{"joinUrl":"https://desktop.example/session/fresh?token=secret"}"#.utf8)
        let session = try JSONDecoder().decode(CloudDesktopSession.self, from: valid)
        XCTAssertEqual(CloudViewerPolicy.sanitizedOrigin(for: session.url), "https://desktop.example")
        XCTAssertTrue(session.url.absoluteString.contains("token=secret"))

        for value in [
            "http://desktop.example/session",
            "https://127.0.0.1/session",
            "https://192.168.1.9/session",
            "javascript:alert(1)",
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["joinUrl": value])
            XCTAssertThrowsError(try JSONDecoder().decode(CloudDesktopSession.self, from: data), value)
        }
    }

    func testVpsBusyStateIsWatchOnlyNeverInteractive() {
        let busyVps = bot(computer: "cloud", cloudBackend: "vps", busy: true)
        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertNotEqual(ComputerPresentationState(bot: busyVps), .cloudViewerAvailable)
        XCTAssertEqual(ComputerPresentationState(bot: busyVps, frame: frame), .watching)
        XCTAssertEqual(
            ComputerPresentationState.watchCaption(for: busyVps),
            CloudViewerPolicy.vpsBusyWatchCopy
        )
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(busyVps))
    }

    func testLocalThisMacHelpNeverUsesVpsBusyCopy() {
        let localBusy = bot(computer: "local", cloudBackend: nil, busy: true)
        let localIdle = bot(computer: "local", busy: false)
        let localMislabelled = bot(computer: "local", cloudBackend: "vps", busy: true)
        XCTAssertEqual(
            ComputerPresentationState.startingCopy(for: localBusy),
            "Waiting for the first frame."
        )
        XCTAssertEqual(
            ComputerPresentationState.startingCopy(for: localIdle),
            "This Bot's computer is captured while it is working."
        )
        XCTAssertNotEqual(
            ComputerPresentationState.startingCopy(for: localBusy),
            CloudViewerPolicy.vpsBusyWatchCopy
        )
        XCTAssertNotEqual(
            ComputerPresentationState.startingCopy(for: localMislabelled),
            CloudViewerPolicy.vpsBusyWatchCopy
        )
        XCTAssertEqual(
            ComputerPresentationState.destinationHelp(for: localBusy),
            "Running on this Mac. Use ··· to switch to Local or Cloud."
        )
        XCTAssertEqual(
            ComputerPresentationState.destinationHelp(for: localMislabelled),
            "Running on this Mac. Use ··· to switch to Local or Cloud."
        )
        XCTAssertFalse(
            (ComputerPresentationState.destinationHelp(for: localBusy) ?? "")
                .localizedCaseInsensitiveContains("VPS")
        )

        let vpsBusy = bot(computer: "cloud", cloudBackend: "vps", busy: true)
        XCTAssertEqual(
            ComputerPresentationState.startingCopy(for: vpsBusy),
            CloudViewerPolicy.vpsBusyWatchCopy
        )
        XCTAssertEqual(
            ComputerPresentationState.destinationHelp(for: vpsBusy),
            CloudViewerPolicy.vpsWatchCopy
        )
    }

    func testCardCopyKeepsComputerStateToOneCalmAction() {
        let cloud = bot(computer: "cloud")
        let cloudCopy = ComputerPresentationState.cardCopy(
            for: .cloudViewerAvailable,
            bot: cloud
        )
        XCTAssertEqual(cloudCopy.title, CloudViewerPolicy.boxReadyTitle)
        XCTAssertEqual(cloudCopy.action, .openCloudDesktop)
        XCTAssertFalse(cloudCopy.body.localizedCaseInsensitiveContains("OpenMausBot"))

        let vps = bot(computer: "cloud", cloudBackend: "vps", busy: true)
        let vpsCopy = ComputerPresentationState.cardCopy(for: .starting, bot: vps)
        XCTAssertEqual(vpsCopy.title, "Watch-only desktop")
        XCTAssertNil(vpsCopy.action)
        XCTAssertTrue(vpsCopy.body.localizedCaseInsensitiveContains("send a message"))
    }

    func testCardCopySelectsLocalVmLifecycleAction() {
        let vm = bot(computer: "vm", busy: false)
        let missing = LocalVmStatus(
            mode: .perBot,
            maxInstances: 1,
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
            problem: nil
        )
        let create = ComputerPresentationState.cardCopy(
            for: .unavailable(message: "ignored"),
            bot: vm,
            localVm: .init(status: missing, accessGranted: true),
            localVmDestinationEnabled: true
        )
        XCTAssertEqual(create.title, "Create a Local VM")
        XCTAssertEqual(create.action, .createLocalVm)

        var stopped = missing
        stopped.state = .stopped
        stopped.canCreate = false
        stopped.canRecreate = true
        let restart = ComputerPresentationState.cardCopy(
            for: .unavailable(message: "ignored"),
            bot: vm,
            localVm: .init(status: stopped, accessGranted: true),
            localVmDestinationEnabled: true
        )
        XCTAssertEqual(restart.title, "Restart the Local VM")
        XCTAssertEqual(restart.action, .recreateLocalVm)
    }

    func testCardCopyExplainsAccessOffAndUnsupportedReconstructedEngine() {
        let vm = bot(computer: "vm", busy: false)
        let accessOff = ComputerPresentationState.cardCopy(
            for: .unavailable(message: LocalVmDesktopPolicy.accessOffMessage),
            bot: vm,
            localVm: .init(accessGranted: false)
        )
        XCTAssertEqual(accessOff.title, "Enable Local VM access")
        XCTAssertTrue(accessOff.body.localizedCaseInsensitiveContains("V Bot"))
        XCTAssertNil(accessOff.action)

        let unsupported = ComputerPresentationState.cardCopy(
            for: .starting,
            bot: vm,
            localVm: .init(accessGranted: true, instanceResolved: true),
            localVmDestinationEnabled: false,
            localVmDestinationReason: "Grok Reconstructed cannot use Local VM."
        )
        XCTAssertEqual(unsupported.title, "Local VM isn't available for this engine")
        XCTAssertTrue(unsupported.body.localizedCaseInsensitiveContains("Grok Reconstructed"))
        XCTAssertNil(unsupported.action)
    }

    func testDistinctSecondaryCopySuppressesDuplicateHelp() {
        XCTAssertNil(
            ComputerPresentationState.distinctSecondaryCopy(
                primary: "Watch-only desktop",
                secondary: " watch-only desktop "
            )
        )
        XCTAssertEqual(
            ComputerPresentationState.distinctSecondaryCopy(
                primary: "Watch-only desktop",
                secondary: "Send a message to start a turn."
            ),
            "Send a message to start a turn."
        )
        XCTAssertNil(
            ComputerPresentationState.distinctSecondaryCopy(primary: "Body", secondary: "   ")
        )
    }

    func testFleetLocalVmWithViewerFailureAndUsableFrameChoosesInteractivePreview() {
        let vm = bot(computer: "vm", busy: false)
        let readyStatus = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .ready,
            container: "running",
            daemonUp: true,
            imageReady: true,
            desktopReady: true,
            ready: true,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: true,
            canRecreate: true,
            problem: nil
        )
        let decision = ComputerPresentationDecision.resolve(
            bot: vm,
            hasGuardedInput: true,
            hasFrame: true,
            viewerFailed: true,
            viewerReady: false,
            status: readyStatus
        )
        XCTAssertEqual(decision, .interactivePreview)
    }

    func testTrueBoxBackendChoosesLiveViewer() {
        let box = bot(computer: "cloud", cloudBackend: "box", busy: false)
        let decision = ComputerPresentationDecision.resolve(
            bot: box,
            hasGuardedInput: true,
            hasFrame: true,
            viewerFailed: false,
            viewerReady: true
        )
        XCTAssertEqual(decision, .liveViewer)
    }

    func testFleetLocalVmSnapshotWithViewerFailureChoosesInteractivePreview() {
        let vm = bot(computer: "vm", busy: false)
        let readyStatus = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .ready,
            container: "running",
            daemonUp: true,
            imageReady: true,
            desktopReady: true,
            ready: true,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: true,
            canRecreate: true,
            problem: nil
        )
        let snapshot = LocalVmDesktopPolicy.Snapshot(
            status: readyStatus,
            accessGranted: true,
            hasScreenshot: true,
            viewerURLPresent: true,
            viewerFailed: true,
            viewerReady: false
        )
        let decision = ComputerPresentationDecision.resolve(
            bot: vm,
            snapshot: snapshot
        )
        XCTAssertEqual(decision, .interactivePreview)
    }

    func testExplicitLiveViewerAdvertisedBackendChoosesLiveViewer() {
        let vm = bot(computer: "vm", busy: false)
        let readyStatus = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .ready,
            container: "running",
            daemonUp: true,
            imageReady: true,
            desktopReady: true,
            ready: true,
            createSupported: true,
            busy: false,
            canCreate: false,
            canStop: true,
            canRecreate: true,
            problem: nil
        )
        let decision = ComputerPresentationDecision.resolve(
            bot: vm,
            hasGuardedInput: true,
            hasFrame: true,
            viewerFailed: false,
            viewerReady: true,
            advertisesLiveViewer: true,
            status: readyStatus
        )
        XCTAssertEqual(decision, .liveViewer)
    }
}
