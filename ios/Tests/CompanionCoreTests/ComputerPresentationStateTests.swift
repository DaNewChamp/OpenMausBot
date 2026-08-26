import XCTest
@testable import CompanionCore

final class ComputerPresentationStateTests: XCTestCase {
    private func bot(computer: String?, cloudBackend: String? = nil) -> Bot {
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
            busy: true,
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
}
