// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, or working
// — started, updated and ended from the same `updates` the pill reads. The
// stream is foreground-only and there is no push path yet, so the island is
// exact while the app is alive and lingers for about two minutes after you
// leave; foreground hydration ends anything stale.
import ActivityKit
import Combine
import Foundation
import CompanionCore
import UIKit
import os

@MainActor
final class LiveActivityCoordinator {
    static let log = Logger(subsystem: "com.posival.openmausmobile", category: "live-activities")

    private var cancellable: AnyCancellable?
    private var tracked: [String: BackgroundPresencePolicy.TrackedBot] = [:]
    private var isBackground = false
    private var backgroundedAt: Date?
    private var notificationsEnabled = false
    private var reduceMotion = UIAccessibility.isReduceMotionEnabled
    private var syncGeneration = 0

    func setBackground(_ background: Bool) {
        isBackground = background
        if background {
            backgroundedAt = Date()
        } else {
            backgroundedAt = nil
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        notificationsEnabled = enabled
    }

    func setReduceMotion(_ enabled: Bool) {
        reduceMotion = enabled
    }

    func attach(to session: Session) {
        AnswerApprovalIntent.handler = { [weak session] threadId, requestId, choice, isPermission in
            await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        cancellable = Publishers.CombineLatest3(
            session.$state,
            session.$authoritativeHydrationRevision,
            session.$notificationAuthorization
        )
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state, revision, authorization in
                let enabled = authorization == .authorized || authorization == .provisional || authorization == .ephemeral
                self?.setNotificationsEnabled(enabled)
                self?.sync(state, hydrated: revision > 0)
            }
    }

    private func sync(_ state: CompanionState, hydrated: Bool) {
        syncGeneration &+= 1
        let generation = syncGeneration
        let context = BackgroundPresencePolicy.Context(
            activitiesEnabled: ActivityAuthorizationInfo().areActivitiesEnabled,
            notificationsEnabled: notificationsEnabled,
            reduceMotion: reduceMotion,
            isBackground: isBackground,
            hydrated: hydrated,
            backgroundedAt: backgroundedAt,
            now: Date()
        )

        let wanted = state.updates
            .filter { $0.kind != .toReview }
            .compactMap { wantedBot(from: $0, state: state) }

        let plan = BackgroundPresencePolicy.sync(
            wanted: wanted,
            tracked: tracked,
            context: context
        )
        tracked = plan.tracked

        for command in plan.commands {
            apply(command, generation: generation)
        }

        if !isBackground, hydrated {
            // The voice session's activity is not this fold's to reconcile:
            // VoiceIsland starts and ends it with the app-scoped session, and
            // keeping it out of the namespace here means a hydrated
            // foreground sync can never tear it down mid-sentence.
            let activeIds = Set(Activity<BotActivityAttributes>.activities.map(\.attributes.botId))
                .subtracting([VoiceIsland.botId])
            let wantedIds = Set(wanted.map(\.botId))
            for botId in BackgroundPresencePolicy.reconcileForeground(
                wantedIds: wantedIds,
                activeBotIds: activeIds,
                hydrated: hydrated
            ) {
                endActivity(botId: botId)
                tracked.removeValue(forKey: botId)
            }
        }
    }

    private func wantedBot(from update: ChatUpdate, state: CompanionState) -> BackgroundPresencePolicy.WantedBot? {
        guard case let .bot(bot) = update.chat else { return nil }
        let face = MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
        let kind: BackgroundPresencePolicy.PresenceKind = update.kind == .needsYou ? .needsYou : .working
        return BackgroundPresencePolicy.WantedBot(
            botId: bot.id,
            threadId: bot.threadId,
            name: bot.name,
            color: bot.color,
            shape: bot.mascotShape?.rawValue,
            face: face.rawValue,
            kind: kind,
            requestId: update.card?.isPending == true ? update.card?.requestId : nil,
            options: update.card?.isPending == true ? (update.card?.options ?? []) : [],
            isPermission: update.card?.isPermission ?? false
        )
    }

    private func apply(_ command: BackgroundPresencePolicy.Command, generation: Int) {
        guard generation == syncGeneration else { return }
        switch command {
        case let .start(bot, presentation):
            start(bot: bot, presentation: presentation)
        case let .update(bot, presentation, alert):
            update(bot: bot, presentation: presentation, alert: alert)
        case let .end(botId):
            endActivity(botId: botId)
        }
    }

    private func start(bot: BackgroundPresencePolicy.WantedBot, presentation: BackgroundPresencePolicy.Presentation) {
        let attributes = BotActivityAttributes(
            botId: bot.botId,
            threadId: bot.threadId,
            name: bot.name,
            color: bot.color,
            shape: bot.shape
        )
        let content = contentState(from: presentation)
        do {
            _ = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
        } catch {
            LiveActivityCoordinator.log.error(
                "activity request for \(bot.botId, privacy: .public) failed: \(error.localizedDescription, privacy: .public)"
            )
        }
        if notificationsEnabled,
           bot.kind == .needsYou,
           let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == bot.botId }) {
            let alert = alertConfiguration(for: presentation)
            Task { await activity.update(content, alertConfiguration: alert) }
        }
    }

    private func update(
        bot: BackgroundPresencePolicy.WantedBot,
        presentation: BackgroundPresencePolicy.Presentation,
        alert: Bool
    ) {
        guard let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == bot.botId }) else {
            start(bot: bot, presentation: presentation)
            return
        }
        let content = contentState(from: presentation)
        let alertConfig = alert ? alertConfiguration(for: presentation) : nil
        Task { await activity.update(content, alertConfiguration: alertConfig) }
    }

    private func endActivity(botId: String) {
        guard let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == botId }) else {
            return
        }
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func contentState(from presentation: BackgroundPresencePolicy.Presentation) -> ActivityContent<BotActivityAttributes.ContentState> {
        ActivityContent(
            state: BotActivityAttributes.ContentState(
                face: presentation.face,
                kind: presentation.kindRawValue,
                headline: presentation.headline,
                line: presentation.line,
                requestId: presentation.requestId,
                options: presentation.options,
                isPermission: presentation.isPermission,
                since: presentation.since
            ),
            staleDate: presentation.staleDate
        )
    }

    private func alertConfiguration(for presentation: BackgroundPresencePolicy.Presentation) -> AlertConfiguration {
        AlertConfiguration(
            title: LocalizedStringResource(stringLiteral: presentation.headline),
            body: LocalizedStringResource(stringLiteral: presentation.line),
            sound: .default
        )
    }
}
