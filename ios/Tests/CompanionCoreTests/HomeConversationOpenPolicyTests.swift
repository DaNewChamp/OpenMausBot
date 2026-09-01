import XCTest
@testable import CompanionCore

final class HomeConversationOpenPolicyTests: XCTestCase {
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

    private func room(
        id: String = "room-1",
        threadId: String = "thread-room",
        name: String = "Chief Keef ⇄ Desk Docs",
        unread: Bool = false
    ) -> Room {
        Room(
            id: id,
            threadId: threadId,
            name: name,
            memberIds: ["bot-1", "bot-2"],
            defaultResponder: GroupResponder(kind: "mentions", botId: nil),
            bulletin: "",
            unread: unread,
            createdAt: 0
        )
    }

    func testImmediateOpenClearsUnreadBotAndRecordsReceipt() {
        var state = CompanionState()
        state.bots = [bot(unread: true)]
        state.messages["thread-1"] = [message("assistant-1"), message("assistant-2")]

        HomeConversationOpenPolicy.applyImmediateRead(
            state: &state,
            stableID: "bot:bot-1",
            threadId: "thread-1"
        )

        XCTAssertFalse(state.bots[0].unread)
        XCTAssertEqual(state.readReceipts.lastReadMessageId(for: "bot:bot-1"), "assistant-2")
    }

    func testImmediateOpenClearsUnreadRoomWithoutBotRevision() {
        var state = CompanionState()
        state.rooms = [room(unread: true)]
        state.messages["thread-room"] = [message("user-1", role: .user)]

        HomeConversationOpenPolicy.applyImmediateRead(
            state: &state,
            stableID: "room:room-1",
            threadId: "thread-room"
        )

        XCTAssertFalse(state.rooms[0].unread)
    }

    func testImmediateOpenClearsUnreadInConversationSummaries() {
        var state = CompanionState()
        state.rooms = [room(unread: true)]
        state.messages["thread-room"] = [message("user-1", role: .user)]

        HomeConversationOpenPolicy.applyImmediateRead(
            state: &state,
            stableID: "room:room-1",
            threadId: "thread-room"
        )

        XCTAssertFalse(state.conversationSummaries.first { $0.id == "room:room-1" }?.unread ?? true)
    }
}
