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

    func testMentionCandidatesRankPrefixMatchesAlphabetically() {
        let members = [
            GroupRouting.Member(id: "milind", name: "Milind", color: "orange"),
            GroupRouting.Member(id: "atlas", name: "Atlas", color: "purple"),
            GroupRouting.Member(id: "mira", name: "Mira", color: "cyan"),
        ]
        XCTAssertEqual(GroupRouting.mentionCandidates(query: "Mi", members: members).map(\.id), ["milind", "mira"])
        XCTAssertEqual(GroupRouting.mentionCandidates(query: "", members: members).map(\.id), ["atlas", "milind", "mira"])
    }

    func testMentionCandidatesPreferExactNameOverLongerPrefix() {
        let members = [
            GroupRouting.Member(id: "miracle", name: "Miracle"),
            GroupRouting.Member(id: "mira", name: "Mira"),
        ]
        XCTAssertEqual(
            GroupRouting.mentionCandidates(query: "mira", members: members).map(\.id),
            ["mira", "miracle"]
        )
    }

    func testMentionReturnAcceptsTopCandidateInsteadOfSending() {
        let members = [
            GroupRouting.Member(id: "mira", name: "Mira"),
            GroupRouting.Member(id: "miracle", name: "Miracle"),
        ]
        let ranked = GroupRouting.mentionCandidates(query: "mira", members: members)
        XCTAssertEqual(GroupRouting.mentionReturnAction(query: "mira", candidates: ranked), .accept("Mira"))
        XCTAssertEqual(GroupRouting.mentionReturnAction(query: "e", candidates: ranked), .accept("everyone"))
        XCTAssertEqual(GroupRouting.mentionReturnAction(query: "z", candidates: []), .ignore)
        XCTAssertFalse(GroupRouting.mentionReturnSends(query: "mira", candidates: ranked))
        XCTAssertFalse(GroupRouting.mentionReturnSends(query: "e", candidates: ranked))
        XCTAssertTrue(GroupRouting.mentionReturnSends(query: "z", candidates: []))
        XCTAssertTrue(GroupRouting.mentionReturnSends(query: nil, candidates: ranked))
        XCTAssertEqual(
            GroupRouting.mentionReturnHint(name: "Mira"),
            "Return inserts @Mira without sending"
        )
        XCTAssertEqual(
            GroupRouting.mentionReturnHint(name: "@everyone"),
            "Return inserts @everyone without sending"
        )
        XCTAssertFalse(GroupRouting.mentionReturnHint(name: "Mira").contains("name"))
        XCTAssertEqual(GroupRouting.mentionRowLabel(name: "Mira"), "@Mira")
        XCTAssertEqual(GroupRouting.mentionRowLabel(name: "@everyone"), "@everyone")
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
        XCTAssertEqual(GroupRouting.groupComposerHint(room: room, members: members), "@mention a bot")
    }
}
