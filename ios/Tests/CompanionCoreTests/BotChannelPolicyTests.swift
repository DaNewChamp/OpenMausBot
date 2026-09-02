import Testing
@testable import CompanionCore

struct BotChannelPolicyTests {
    @Test
    func testBotChannelDetection() {
        var room = Room(
            id: "room-1",
            threadId: "t1",
            name: "Alpha ⇄ Beta",
            memberIds: ["a", "b"],
            defaultResponder: GroupResponder(kind: "mentions", botId: nil),
            bulletin: "",
            unread: false,
            createdAt: 0
        )
        #expect(!BotChannelPolicy.isBotChannel(room))
        room.dm = true
        #expect(BotChannelPolicy.isBotChannel(room))
    }

    @Test
    func testRosterHidesBotChannelsByDefault() {
        let team = Room(
            id: "team",
            threadId: "t-team",
            name: "Team",
            memberIds: ["a", "b", "c"],
            defaultResponder: GroupResponder(kind: "member", botId: "a"),
            bulletin: "",
            unread: false,
            createdAt: 0
        )
        var channel = team
        channel.id = "dm"
        channel.threadId = "t-dm"
        channel.name = "Alpha ⇄ Beta"
        channel.memberIds = ["a", "b"]
        channel.dm = true

        let hidden = BotChannelPolicy.rosterRooms([team, channel], showBotChannels: false)
        #expect(hidden.map(\.id) == ["team"])

        let shown = BotChannelPolicy.rosterRooms([team, channel], showBotChannels: true)
        #expect(shown.map(\.id) == ["team", "dm"])
    }

    @Test
    func testParticipantOrderPrefersInvokingBot() {
        #expect(
            BotChannelPolicy.participantOrder(memberIds: ["alpha", "beta"], invokingBotId: "beta")
                == ["beta", "alpha"]
        )
        #expect(
            BotChannelPolicy.participantOrder(memberIds: ["alpha", "beta"], invokingBotId: nil)
                == ["alpha", "beta"]
        )
    }
}
