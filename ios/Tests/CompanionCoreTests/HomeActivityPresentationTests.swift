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

    @Test
    func failedQueueReceiptIsRejected() {
        let receipt = MessageDeliveryReceipt(
            ok: false,
            disposition: .queued,
            queueId: "q-failed",
            threadId: "thread-1"
        )

        #expect(HomeActivityQueueReceipt(receipt: receipt) == nil)
    }

    @Test
    func quietPillHidesWhenTemporaryAgentsAreIdle() {
        let presentation = HomeActivityPresentation(
            state: CompanionState(),
            subagents: []
        )
        #expect(presentation.state == .quiet)
        #expect(!HomeActivityRailLayoutPolicy.showsRail(for: presentation.state))
        #expect(presentation.temporaryAgentCount == 0)
    }

    @Test
    func temporaryAgentsAppearAsCompactCountAndNavigateToTranscript() {
        let activity = HermesSubagentActivity(
            activityId: "act-1",
            parentThreadId: "parent-thread",
            title: "Draft review",
            status: .started,
            transcriptThreadId: "thread-temp-1",
            promoteEligible: false
        )
        let presentation = HomeActivityPresentation(state: CompanionState(), subagents: [activity])
        #expect(presentation.temporaryAgentCount == 1)
        #expect(presentation.collapsedTitle == "1 agent")
        #expect(HomeActivityRailLayoutPolicy.showsRail(for: presentation.state))
        #expect(HermesSubagentPresentationPolicy.navigationThreadId(for: activity) == "thread-temp-1")
        #expect(!HermesSubagentPresentationPolicy.showsPromote(for: activity))
    }

    @Test
    func completedTemporaryAgentKeepsTranscriptAndPromote() {
        let activity = HermesSubagentActivity(
            activityId: "act-2",
            parentThreadId: "parent-thread",
            title: "Draft review",
            status: .completed,
            transcriptThreadId: "thread-temp-2",
            promoteEligible: true
        )
        #expect(HermesSubagentPresentationPolicy.navigationThreadId(for: activity) == "thread-temp-2")
        #expect(HermesSubagentPresentationPolicy.showsPromote(for: activity))
        #expect(HermesSubagentPresentationPolicy.promoteTitle == "Promote to Bot")
        #expect(activity.status != .promoted)
    }

    @Test
    func livePillDropsCompletedAgentsAfterRetentionWhileParentHistoryStaysReopenable() {
        let nowMs = 1_700_000_060_000.0
        let now = Date(timeIntervalSince1970: nowMs / 1000)
        let recent = HermesSubagentActivity(
            activityId: "act-recent",
            parentThreadId: "parent-thread",
            title: "Draft review",
            status: .completed,
            transcriptThreadId: "thread-temp-recent",
            promoteEligible: true,
            updatedAt: nowMs - 30_000
        )
        let stale = HermesSubagentActivity(
            activityId: "act-stale",
            parentThreadId: "parent-thread",
            title: "Older review",
            status: .completed,
            transcriptThreadId: "thread-temp-stale",
            promoteEligible: true,
            updatedAt: nowMs - 61_000
        )

        #expect(HermesSubagentPresentationPolicy.showsInLivePill(recent, now: now))
        #expect(!HermesSubagentPresentationPolicy.showsInLivePill(stale, now: now))
        #expect(HermesSubagentPresentationPolicy.retainedInParentHistory(recent))
        #expect(HermesSubagentPresentationPolicy.retainedInParentHistory(stale))
        #expect(
            HermesSubagentPresentationPolicy.parentHistoryActivities(
                [recent, stale],
                parentThreadId: "parent-thread"
            ).map(\.activityId) == ["act-recent", "act-stale"]
        )
        #expect(HermesSubagentPresentationPolicy.navigationThreadId(for: stale) == "thread-temp-stale")
        #expect(ChatActivityNavigationPolicy.action(fromParentThreadId: "parent-thread") == .pushFocusedTranscript)

        let live = HomeActivityPresentation(state: CompanionState(), subagents: [recent], now: now)
        #expect(live.state == .active)
        #expect(HomeActivityRailLayoutPolicy.showsRail(for: live.state))
        #expect(live.recentlyFinished.map(\.threadId) == ["thread-temp-recent"])
        #expect(
            HomeActivityRailLayoutPolicy.composerPillPlacement(presentationState: live.state)
                == .immediatelyAboveComposer
        )

        let quiet = HomeActivityPresentation(state: CompanionState(), subagents: [stale], now: now)
        #expect(quiet.state == .quiet)
        #expect(!HomeActivityRailLayoutPolicy.showsRail(for: quiet.state))
        #expect(
            HomeActivityRailLayoutPolicy.composerPillPlacement(presentationState: quiet.state) == .hidden
        )
        #expect(quiet.items.isEmpty)
        #expect(HomeInChatActivityProjectionPolicy.scopedSubagents([stale], parentThreadId: "parent-thread") == [stale])
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
