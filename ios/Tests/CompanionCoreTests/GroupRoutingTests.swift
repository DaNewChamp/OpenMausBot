import XCTest
@testable import CompanionCore

final class GroupRoutingTests: XCTestCase {
    private let members = [
        GroupRouting.Member(id: "atlas", name: "Atlas"),
        GroupRouting.Member(id: "milind", name: "Milind"),
    ]

    func testUnmentionedMessageGoesToLead() {
        let responders = GroupRouting.roomRespondersForComposer(
            text: "hello there",
            members: members,
            responder: GroupResponder(kind: "member", botId: "atlas")
        )
        XCTAssertEqual(responders.map(\.id), ["atlas"])
    }

    func testExplicitMentionOverridesLead() {
        let responders = GroupRouting.roomRespondersForComposer(
            text: "@Milind take this",
            members: members,
            responder: GroupResponder(kind: "member", botId: "atlas")
        )
        XCTAssertEqual(responders.map(\.id), ["milind"])
    }

    func testEveryoneAndMentionsOnlyPolicies() {
        XCTAssertEqual(
            GroupRouting.roomRespondersForComposer(
                text: "hello",
                members: members,
                responder: GroupResponder(kind: "everyone")
            ).map(\.id),
            ["atlas", "milind"]
        )
        XCTAssertEqual(
            GroupRouting.roomRespondersForComposer(
                text: "hello",
                members: members,
                responder: GroupResponder(kind: "mentions")
            ).map(\.id),
            []
        )
        XCTAssertEqual(
            GroupRouting.roomRespondersForComposer(
                text: "@everyone hello",
                members: members,
                responder: GroupResponder(kind: "mentions")
            ).map(\.id),
            ["atlas", "milind"]
        )
    }

    func testActiveMentionQueryRequiresBoundary() {
        XCTAssertEqual(GroupRouting.activeMentionQuery(in: "@"), "")
        XCTAssertEqual(GroupRouting.activeMentionQuery(in: "hello @Mi"), "Mi")
        XCTAssertNil(GroupRouting.activeMentionQuery(in: "hello @Milind "))
        XCTAssertNil(GroupRouting.activeMentionQuery(in: "email@host"))
    }

    func testApplyingMentionReplacesTrailingQuery() {
        XCTAssertEqual(GroupRouting.applyingMention("Milind", to: "hello @Mi"), "hello @Milind ")
        XCTAssertEqual(GroupRouting.applyingMention("everyone", to: "@"), "@everyone ")
    }

    func testMentionCandidatesKeepBotColor() {
        let colored = [
            GroupRouting.Member(id: "atlas", name: "Atlas", color: "purple"),
            GroupRouting.Member(id: "milind", name: "Milind", color: "orange"),
        ]
        let hits = GroupRouting.mentionCandidates(query: "Mi", members: colored)
        XCTAssertEqual(hits.map(\.id), ["milind"])
        XCTAssertEqual(hits.first?.color, "orange")
    }

    func testComposerHintForMentionsOnlyRoom() throws {
        let room = try JSONDecoder().decode(
            Room.self,
            from: Data(
                """
                {"id":"g1","threadId":"t1","name":"Ops","memberIds":["atlas","milind"],"defaultResponder":{"kind":"mentions"},"bulletin":"","unread":false,"createdAt":0}
                """.utf8
            )
        )
        XCTAssertEqual(GroupRouting.groupComposerHint(room: room, members: members), "@ to bring a bot in")
    }
}
