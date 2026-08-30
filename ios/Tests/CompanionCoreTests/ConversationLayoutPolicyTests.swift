import XCTest
@testable import CompanionCore

final class ConversationLayoutPolicyTests: XCTestCase {
    func testReferenceCanvasDimensions() {
        XCTAssertEqual(ConversationLayoutPolicy.referenceWidth, 590)
        XCTAssertEqual(ConversationLayoutPolicy.referenceHeight, 1280)
        XCTAssertEqual(ConversationLayoutPolicy.referenceChromeTopY, 92)
        XCTAssertEqual(ConversationLayoutPolicy.referenceChromeBottomY, 150)
    }

    func testHeaderChromeMatchesReferenceControls() {
        XCTAssertEqual(ConversationLayoutPolicy.chromeButtonDiameter, 44)
        XCTAssertEqual(ConversationLayoutPolicy.composerButtonDiameter, 44)
        XCTAssertEqual(ConversationLayoutPolicy.composerBarHeight, 44)
        XCTAssertEqual(ConversationLayoutPolicy.floatingWorkingAvatarSize, 30)
        XCTAssertEqual(ConversationLayoutPolicy.floatingScrollButtonSize, 44)
        XCTAssertEqual(ConversationLayoutPolicy.headerChromeHeight, 44 + 4 + 6)
    }

    func testTranscriptMarginsAndBubbleWidth() {
        XCTAssertEqual(ConversationLayoutPolicy.transcriptHorizontalMargin, 22)
        XCTAssertEqual(ConversationLayoutPolicy.bubbleCornerRadius, 24)
        XCTAssertEqual(ConversationLayoutPolicy.bubbleMaxWidthFraction, 0.83, accuracy: 0.001)

        let pane = ConversationLayoutPolicy.referenceWidth
        let maxBubble = ConversationLayoutPolicy.bubbleMaxWidth(paneWidth: pane)
        XCTAssertEqual(maxBubble, pane * 0.83, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(maxBubble / pane, 0.82)
        XCTAssertLessThanOrEqual(maxBubble / pane, 0.84)
    }

    func testIdentityTitleJoinsNameAndModel() {
        XCTAssertEqual(
            ConversationLayoutPolicy.identityTitle(name: "Scout", modelLabel: "S-M"),
            "Scout · S-M"
        )
        XCTAssertEqual(
            ConversationLayoutPolicy.identityTitle(name: "Scout", modelLabel: "  "),
            "Scout"
        )
    }

    func testScrollToBottomOnlyWhenReaderLeftLatest() {
        XCTAssertFalse(
            ConversationLayoutPolicy.showsScrollToBottomButton(
                followingLatest: true,
                hasTranscript: true
            )
        )
        XCTAssertTrue(
            ConversationLayoutPolicy.showsScrollToBottomButton(
                followingLatest: false,
                hasTranscript: true
            )
        )
        XCTAssertFalse(
            ConversationLayoutPolicy.showsScrollToBottomButton(
                followingLatest: false,
                hasTranscript: false
            )
        )
    }

    func testFloatingWorkingAvatarOnlyWhenWorkingAndNotFollowing() {
        XCTAssertFalse(
            ConversationLayoutPolicy.showsFloatingWorkingAvatar(
                showsWorkingRow: true,
                followingLatest: true
            )
        )
        XCTAssertTrue(
            ConversationLayoutPolicy.showsFloatingWorkingAvatar(
                showsWorkingRow: true,
                followingLatest: false
            )
        )
        XCTAssertFalse(
            ConversationLayoutPolicy.showsFloatingWorkingAvatar(
                showsWorkingRow: false,
                followingLatest: false
            )
        )
    }

    func testChromeBandMapsOntoReferenceCanvas() {
        let top = ConversationLayoutPolicy.referenceCanvasY(
            ConversationLayoutPolicy.referenceChromeTopY,
            paneWidth: 402
        )
        let bottom = ConversationLayoutPolicy.referenceCanvasY(
            ConversationLayoutPolicy.referenceChromeBottomY,
            paneWidth: 402
        )
        XCTAssertGreaterThanOrEqual(top, 60)
        XCTAssertLessThanOrEqual(bottom, 110)
    }
}
