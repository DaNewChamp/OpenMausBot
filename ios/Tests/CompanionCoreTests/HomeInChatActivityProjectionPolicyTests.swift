import Foundation
import Testing
@testable import CompanionCore

struct HomeInChatActivityProjectionPolicyTests {
    @Test
    func scopedSubagentsKeepOnlyParentThreadWork() {
        let parent = "parent-thread"
        let other = HermesSubagentActivity(
            activityId: "act-other",
            parentThreadId: "other-thread",
            title: "Other",
            status: .started,
            transcriptThreadId: "thread-other",
            promoteEligible: false
        )
        let mine = HermesSubagentActivity(
            activityId: "act-mine",
            parentThreadId: parent,
            title: "Draft review",
            status: .started,
            transcriptThreadId: "thread-temp-1",
            promoteEligible: false
        )

        let scoped = HomeInChatActivityProjectionPolicy.scopedSubagents(
            [other, mine],
            parentThreadId: parent
        )

        #expect(scoped == [mine])
    }

    @Test
    func inChatProjectionHidesUnrelatedFleetActivity() throws {
        var state = try fixtureState()
        var workingBot = try #require(state.bots.first)
        workingBot.busy = true
        state.bots[0] = workingBot

        var otherBot = workingBot
        otherBot.id = "bot-other"
        otherBot.threadId = "thread-other"
        otherBot.name = "Other bot"
        state.bots.append(otherBot)

        let parentThreadId = workingBot.threadId
        let activity = HermesSubagentActivity(
            activityId: "act-1",
            parentThreadId: parentThreadId,
            title: "Draft review",
            status: .started,
            transcriptThreadId: "thread-temp-1",
            promoteEligible: false
        )

        let fleet = state.homeActivityPresentation(subagents: [activity])
        let inChat = state.homeActivityPresentation(
            subagents: HomeInChatActivityProjectionPolicy.scopedSubagents(
                [activity],
                parentThreadId: parentThreadId
            ),
            parentThreadId: parentThreadId
        )

        #expect(fleet.active.count >= 2)
        #expect(inChat.temporaryAgentCount == 1)
        #expect(inChat.active.map(\.threadId) == ["thread-temp-1"])
        #expect(!inChat.items.contains { $0.threadId == "thread-other" })
    }

    @Test
    func homeProjectionKeepsFleetAggregation() throws {
        var state = try fixtureState()
        var workingBot = try #require(state.bots.first)
        workingBot.busy = true
        state.bots[0] = workingBot

        var otherBot = workingBot
        otherBot.id = "bot-other"
        otherBot.threadId = "thread-other"
        otherBot.name = "Other bot"
        state.bots.append(otherBot)

        let presentation = state.homeActivityPresentation()
        #expect(presentation.active.count >= 2)
    }

    private func fixtureState() throws -> CompanionState {
        let url = try #require(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url))
        var state = CompanionState()
        state.hydrate(fleet)
        return state
    }
}
