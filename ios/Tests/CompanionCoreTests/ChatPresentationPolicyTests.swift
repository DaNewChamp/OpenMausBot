// Chat chrome policy: suggestion chips stay off, live tokens stay off the
// surface, and the working line never quotes a partial reply.
import XCTest
@testable import CompanionCore

final class ChatPresentationPolicyTests: XCTestCase {
    func testPostResponseSuggestionRowIsAbsentEvenWhenIdleAndEmpty() {
        XCTAssertFalse(
            ChatPresentationPolicy.showsPostResponseSuggestionRow(
                draftIsEmpty: true,
                busy: false,
                hasPendingApproval: false
            )
        )
        XCTAssertFalse(
            ChatPresentationPolicy.showsPostResponseSuggestionRow(
                draftIsEmpty: true,
                busy: true,
                hasPendingApproval: false
            )
        )
        XCTAssertFalse(
            ChatPresentationPolicy.showsPostResponseSuggestionRow(
                draftIsEmpty: false,
                busy: false,
                hasPendingApproval: true
            )
        )
    }

    func testLiveAssistantProseIsNeverRevealed() {
        XCTAssertFalse(ChatPresentationPolicy.revealsLiveAssistantProse)
    }

    func testWorkingStatusLineNeverQuotesAPartialReply() {
        XCTAssertEqual(
            ChatPresentationPolicy.workingStatusLine(
                streaming: "Hello world this is a live token dump",
                lastMessage: Message(id: "u1", role: .user, kind: .text, at: 1, text: "hi")
            ),
            "Working…"
        )
        var activity = Message(id: "t1", role: .bot, kind: .activity, at: 2)
        activity.tool = ToolActivity(name: "Bash", ok: nil, spoken: nil, setup: nil)
        XCTAssertEqual(
            ChatPresentationPolicy.workingStatusLine(
                streaming: "partial answer",
                lastMessage: activity
            ),
            "Bash"
        )
    }
}
