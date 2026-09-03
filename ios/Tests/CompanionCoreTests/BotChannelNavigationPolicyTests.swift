import Testing
@testable import CompanionCore

struct BotChannelNavigationPolicyTests {
    private func room(
        id: String = "dm",
        members: [String],
        dm: Bool? = true
    ) -> Room {
        Room(
            id: id,
            threadId: "t-\(id)",
            name: members.joined(separator: " ⇄ "),
            memberIds: members,
            defaultResponder: GroupResponder(kind: "mentions", botId: nil),
            bulletin: "",
            unread: false,
            createdAt: 0,
            dm: dm
        )
    }

    @Test
    func testOneCounterpartOpensDedicatedReadOnlyConversationWithoutChooser() {
        let dm = room(members: ["chief", "cio"])
        let action = BotChannelPolicy.navigationAction(
            room: dm,
            invokingBotId: "chief",
            counterpartBotId: "cio"
        )
        #expect(action == .openDedicatedReadOnly(perspectiveBotId: "chief"))
        #expect(!BotChannelPolicy.showsParticipantPicker(room: dm))
        #expect(BotChannelPolicy.isDedicatedReadOnlyConversation(dm))
        #expect(BotChannelPolicy.hidesComposer(for: dm))
        #expect(BotChannelPolicy.dedicatedTranscriptUsesNormalBubbles)
    }

    @Test
    func testOneCounterpartWithoutInvokingBotUsesCounterpartPerspective() {
        let dm = room(members: ["chief", "cio"])
        let action = BotChannelPolicy.navigationAction(
            room: dm,
            invokingBotId: nil,
            counterpartBotId: "cio"
        )
        #expect(action == .openDedicatedReadOnly(perspectiveBotId: "cio"))
        #expect(!BotChannelPolicy.showsParticipantPicker(room: dm))
    }

    @Test
    func testMultipleParticipantsRetainPicker() {
        let group = room(id: "ops", members: ["chief", "cio", "risk"])
        let action = BotChannelPolicy.navigationAction(
            room: group,
            invokingBotId: "chief",
            counterpartBotId: "cio"
        )
        #expect(action == .showParticipantPicker)
        #expect(BotChannelPolicy.showsParticipantPicker(room: group))
        #expect(!BotChannelPolicy.isDedicatedReadOnlyConversation(group))
        #expect(!BotChannelPolicy.hidesComposer(for: group))
    }

    @Test
    func testMissingRoomIsUnavailable() {
        #expect(
            BotChannelPolicy.navigationAction(
                room: nil,
                invokingBotId: "chief",
                counterpartBotId: "cio"
            ) == .unavailable
        )
    }

    @Test
    func testSharedNonBotRoomKeepsExistingDirectOpen() {
        let team = room(id: "team", members: ["chief", "cio"], dm: false)
        let action = BotChannelPolicy.navigationAction(
            room: team,
            invokingBotId: "chief",
            counterpartBotId: "cio"
        )
        #expect(action == .openSharedRoom(perspectiveBotId: "chief"))
        #expect(!BotChannelPolicy.showsParticipantPicker(room: team))
        #expect(!BotChannelPolicy.hidesComposer(for: team))
    }
}
