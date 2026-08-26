import XCTest
@testable import CompanionCore

final class PendingQueueReconciliationTests: XCTestCase {
    private func message(
        _ id: String,
        role: Message.Role = .user,
        text: String,
        queueId: String? = nil
    ) -> Message {
        var value = Message(id: id, role: role, kind: .text, at: 1)
        value.text = text
        value.queueId = queueId
        return value
    }

    func testMessageDecodesOptionalQueueID() throws {
        let queued = try JSONDecoder().decode(
            Message.self,
            from: Data(#"{"id":"m1","role":"user","kind":"text","at":1,"text":"same","queueId":"q-1"}"#.utf8)
        )
        XCTAssertEqual(queued.queueId, "q-1")

        let legacy = try JSONDecoder().decode(
            Message.self,
            from: Data(#"{"id":"m2","role":"user","kind":"text","at":2,"text":"same"}"#.utf8)
        )
        XCTAssertNil(legacy.queueId)
    }

    func testIdenticalTextWithoutQueueIDDoesNotRetireAQueuedNotice() {
        let transcript = [
            message("old", text: "same"),
            message("duplicate", text: "same")
        ]

        XCTAssertEqual(
            PendingQueueReconciliation.remainingQueueIDs(
                pendingQueueIDs: ["q-1"],
                transcript: transcript
            ),
            ["q-1"]
        )
    }

    func testOnlyMatchingUserQueueIDRetiresTheNotice() {
        let transcript = [
            message("old", text: "same"),
            message("queued", text: "same", queueId: "q-1"),
            message("bot", role: .bot, text: "same", queueId: "q-2")
        ]

        XCTAssertEqual(
            PendingQueueReconciliation.remainingQueueIDs(
                pendingQueueIDs: ["q-1", "q-2", "q-3"],
                transcript: transcript
            ),
            ["q-2", "q-3"]
        )
    }

    func testAuthoritativeRefreshRetiresNoticesMissingFromTheRefresh() {
        XCTAssertEqual(
            PendingQueueReconciliation.remainingQueueIDs(
                pendingQueueIDs: ["q-1", "q-2"],
                transcript: [message("old", text: "same")],
                authoritativeRefresh: true
            ),
            []
        )
    }
}
