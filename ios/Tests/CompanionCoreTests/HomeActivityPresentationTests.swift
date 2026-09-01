import Foundation
import Testing
@testable import CompanionCore

struct HomeActivityPresentationTests {
    @Test
    func quietStateUsesCalmCollapsedCopy() {
        let presentation = HomeActivityPresentation(state: CompanionState())

        #expect(presentation.state == .quiet)
        #expect(presentation.collapsedTitle == "All quiet")
        #expect(presentation.collapsedSubtitle == "Nothing needs you")
        #expect(presentation.items.isEmpty)
    }

    @Test
    func approvalsOutrankWorkAndKnownQueueReceiptsRemainSeparate() throws {
        var state = try fixtureState()
        let bot = try #require(state.bots.first)
        let room = try #require(state.rooms.first)

        var unreadRoom = room
        unreadRoom.unread = true
        state.rooms[0] = unreadRoom

        var workingBot = bot
        workingBot.busy = true
        workingBot.unread = true
        state.bots[0] = workingBot

        var approval = Message(id: "approval", role: .bot, kind: .options, at: 10)
        approval.card = OptionCard(
            title: "Allow this?",
            subtitle: "A request needs your answer.",
            options: ["Allow"],
            requestId: "request-1"
        )
        state.messages[workingBot.threadId, default: []].append(approval)
        state.bots[0].activeLeafId = approval.id

        let receipts = [
            HomeActivityQueueReceipt(queueId: "queue-1", threadId: unreadRoom.threadId),
            HomeActivityQueueReceipt(queueId: "queue-2", threadId: unreadRoom.threadId),
            // A receipt for an unknown thread cannot become a dead row.
            HomeActivityQueueReceipt(queueId: "queue-unknown", threadId: "missing-thread")
        ]
        let presentation = HomeActivityPresentation(state: state, queuedReceipts: receipts)

        #expect(presentation.state == .needsAttention)
        #expect(presentation.sections.map(\.kind) == [.needsYou, .active, .queued, .recentlyFinished])
        #expect(presentation.items.map(\.kind) == [.needsYou, .queued, .recentlyFinished])
        #expect(presentation.items.first?.threadId == workingBot.threadId)
        #expect(presentation.queued.first?.queueCount == 2)
        #expect(presentation.queued.first?.id == "queued:\(unreadRoom.threadId)")
        #expect(presentation.queued.first?.subtitle == "2 queued")
        #expect(presentation.recentlyFinished.first?.threadId == unreadRoom.threadId)
        #expect(presentation.active.isEmpty, "approval suppresses the same chat's active row")
    }

    @Test
    func activeCollapsedCopyReportsCountWithoutProviderName() throws {
        var state = try fixtureState()
        var bot = try #require(state.bots.first)
        bot.busy = true
        bot.unread = false
        state.bots[0] = bot

        let presentation = HomeActivityPresentation(state: state)

        #expect(presentation.state == .active)
        #expect(presentation.collapsedTitle == "1 active")
        #expect(!presentation.collapsedTitle.localizedCaseInsensitiveContains("grok"))
        #expect(!presentation.collapsedTitle.localizedCaseInsensitiveContains("provider"))
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
