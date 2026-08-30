import XCTest
@testable import CompanionCore

final class UnreadPolicyTests: XCTestCase {
    private func message(
        _ id: String,
        role: Message.Role = .bot,
        kind: Message.Kind = .text,
        at: Double = 1
    ) -> Message {
        Message(id: id, role: role, kind: kind, at: at, text: role == .bot ? "reply" : "send")
    }

    private func bot(
        id: String = "bot-1",
        threadId: String = "thread-1",
        unread: Bool = false
    ) -> Bot {
        Bot(
            id: id,
            threadId: threadId,
            name: "Scout",
            title: "",
            description: "",
            notifications: true,
            color: "green",
            unread: unread,
            modelSelection: ModelSelection(instanceId: "i", model: "m"),
            createdAt: 0
        )
    }

    func testFinalAssistantMessageMarksUnreadWhenNotVisible() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.messages["thread-1"] = [message("user-1", role: .user)]

        state.applyUnreadOnFinalMessage(
            threadId: "thread-1",
            message: message("assistant-1"),
            visibleThreadId: nil,
            messageAlreadyPresent: false
        )

        XCTAssertTrue(state.bots[0].unread)
    }

    func testActiveVisibleChatSuppressesUnread() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.messages["thread-1"] = []

        state.applyUnreadOnFinalMessage(
            threadId: "thread-1",
            message: message("assistant-1"),
            visibleThreadId: "thread-1",
            messageAlreadyPresent: false
        )

        XCTAssertFalse(state.bots[0].unread)
        XCTAssertEqual(state.readReceipts.lastReadMessageId(for: "bot:bot-1"), "assistant-1")
    }

    func testDuplicateReplayDoesNotReMarkUnread() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.readReceipts.markRead(stableID: "bot:bot-1", messageId: "assistant-1")
        state.messages["thread-1"] = [message("assistant-1")]

        state.applyUnreadOnFinalMessage(
            threadId: "thread-1",
            message: message("assistant-1"),
            visibleThreadId: nil,
            messageAlreadyPresent: true
        )

        XCTAssertFalse(state.bots[0].unread)
    }

    func testOpenToClearRecordsReceiptAndClearsUnread() {
        var state = CompanionState()
        state.bots = [bot(unread: true)]
        state.messages["thread-1"] = [message("assistant-1"), message("assistant-2")]

        state.markConversationRead(stableID: "bot:bot-1", threadId: "thread-1")

        XCTAssertFalse(state.bots[0].unread)
        XCTAssertEqual(state.readReceipts.lastReadMessageId(for: "bot:bot-1"), "assistant-2")
    }

    func testHydrateReconcilePreservesUnreadReceiptWhenServerStillUnread() {
        var state = CompanionState()
        state.bots = [bot(unread: true)]
        state.messages["thread-1"] = [message("assistant-1")]
        state.readReceipts.markRead(stableID: "bot:bot-1", messageId: "older")

        state.reconcileReadReceiptsAfterHydrate()
        state.reconcileUnreadIndicators(visibleThreadId: nil)

        XCTAssertEqual(state.readReceipts.lastReadMessageId(for: "bot:bot-1"), "older")
        XCTAssertTrue(state.bots[0].unread)
    }

    func testHydrateReconcileAdvancesReceiptWhenServerRead() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.messages["thread-1"] = [message("assistant-1")]

        state.reconcileReadReceiptsAfterHydrate()
        state.reconcileUnreadIndicators(visibleThreadId: nil)

        XCTAssertEqual(state.readReceipts.lastReadMessageId(for: "bot:bot-1"), "assistant-1")
        XCTAssertFalse(state.bots[0].unread)
    }

    func testPinnedAndListRenderingUseEffectiveUnread() {
        var state = CompanionState()
        state.bots = [
            bot(id: "pinned", threadId: "thread-pinned", unread: false),
            bot(id: "plain", threadId: "thread-plain", unread: false),
        ]
        state.bots[0].pinned = true
        state.messages["thread-pinned"] = [message("pinned-reply", at: 20)]
        state.messages["thread-plain"] = [message("plain-reply", at: 10)]

        state.applyUnreadOnFinalMessage(
            threadId: "thread-pinned",
            message: message("pinned-reply", at: 20),
            visibleThreadId: nil,
            messageAlreadyPresent: true
        )
        state.applyUnreadOnFinalMessage(
            threadId: "thread-plain",
            message: message("plain-reply", at: 10),
            visibleThreadId: nil,
            messageAlreadyPresent: true
        )
        state.reconcileUnreadIndicators(visibleThreadId: nil)

        let summaries = state.conversationSummaries
        XCTAssertTrue(summaries.first { $0.id == "bot:pinned" }?.unread == true)
        XCTAssertTrue(summaries.first { $0.id == "bot:plain" }?.unread == true)
    }

    func testOutgoingUserMessageDoesNotMarkUnread() {
        XCTAssertNil(UnreadPolicy.unreadRevision(for: message("user-1", role: .user)))
    }

    func testPartialActivityDoesNotMarkUnread() {
        XCTAssertNil(UnreadPolicy.unreadRevision(for: message("tool-1", kind: .activity)))
    }

    func testNotifyDoneMarksUnreadWithoutBotFrame() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.messages["thread-1"] = [message("assistant-1")]

        state.applyUnreadOnNotification(
            NotificationFrame(
                kind: "done",
                botId: "bot-1",
                botName: "Scout",
                threadId: "thread-1",
                title: "Done",
                body: "Finished the task."
            ),
            visibleThreadId: nil
        )

        XCTAssertTrue(state.bots[0].unread)
    }

    func testNotifySuppressedForVisibleThread() {
        var state = CompanionState()
        state.bots = [bot(unread: false)]
        state.messages["thread-1"] = [message("assistant-1")]

        state.applyUnreadOnNotification(
            NotificationFrame(
                kind: "done",
                botId: "bot-1",
                botName: "Scout",
                threadId: "thread-1",
                title: "Done",
                body: "Finished the task."
            ),
            visibleThreadId: "thread-1"
        )

        XCTAssertFalse(state.bots[0].unread)
    }

    func testPersistenceRoundTrip() throws {
        var receipts = ConversationReadReceipts()
        receipts.markRead(stableID: "bot:bot-1", messageId: "assistant-9")
        let data = try JSONEncoder().encode(receipts)
        let decoded = try JSONDecoder().decode(ConversationReadReceipts.self, from: data)
        XCTAssertEqual(decoded.lastReadMessageId(for: "bot:bot-1"), "assistant-9")
    }
}
