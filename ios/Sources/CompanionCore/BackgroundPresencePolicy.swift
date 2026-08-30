import Foundation

/// Pure Live Activity / background-presence rules. Session and
/// `LiveActivityCoordinator` own ActivityKit and sockets; this keeps start,
/// update, end, linger, dedupe, and privacy-safe presentation deterministic.
public enum BackgroundPresencePolicy: Sendable {
    public static let lingerDuration: TimeInterval = 120

    public enum PresenceKind: String, Equatable, Sendable {
        case working
        case needsYou
        case finished
    }

    public struct WantedBot: Hashable, Sendable {
        public var botId: String
        public var threadId: String
        public var name: String
        public var color: String
        public var shape: String?
        public var face: String
        public var kind: PresenceKind
        public var requestId: String?
        public var options: [String]
        public var isPermission: Bool

        public init(
            botId: String,
            threadId: String,
            name: String,
            color: String,
            shape: String?,
            face: String,
            kind: PresenceKind,
            requestId: String? = nil,
            options: [String] = [],
            isPermission: Bool = false
        ) {
            self.botId = botId
            self.threadId = threadId
            self.name = name
            self.color = color
            self.shape = shape
            self.face = face
            self.kind = kind
            self.requestId = requestId
            self.options = options
            self.isPermission = isPermission
        }
    }

    public struct Presentation: Hashable, Sendable {
        public var face: String
        public var kind: PresenceKind
        public var headline: String
        public var line: String
        public var requestId: String?
        public var options: [String]
        public var isPermission: Bool
        public var since: Date
        public var staleDate: Date?

        public var kindRawValue: String { kind.rawValue }
    }

    public struct TrackedBot: Hashable, Sendable {
        public var botId: String
        public var threadId: String
        public var name: String
        public var color: String
        public var shape: String?
        public var presentation: Presentation
        public var finishedAt: Date?
    }

    public enum Command: Equatable, Sendable {
        case start(WantedBot, Presentation)
        case update(WantedBot, Presentation, alert: Bool)
        case end(botId: String)
    }

    public struct Context: Equatable, Sendable {
        public var activitiesEnabled: Bool
        public var notificationsEnabled: Bool
        public var reduceMotion: Bool
        public var isBackground: Bool
        public var hydrated: Bool
        public var backgroundedAt: Date?
        public var now: Date

        public init(
            activitiesEnabled: Bool,
            notificationsEnabled: Bool,
            reduceMotion: Bool = false,
            isBackground: Bool,
            hydrated: Bool,
            backgroundedAt: Date? = nil,
            now: Date
        ) {
            self.activitiesEnabled = activitiesEnabled
            self.notificationsEnabled = notificationsEnabled
            self.reduceMotion = reduceMotion
            self.isBackground = isBackground
            self.hydrated = hydrated
            self.backgroundedAt = backgroundedAt
            self.now = now
        }
    }

    public struct SyncPlan: Equatable, Sendable {
        public var commands: [Command]
        public var tracked: [String: TrackedBot]
    }

    /// Whether ActivityKit work should run at all.
    public static func shouldSync(context: Context) -> Bool {
        context.activitiesEnabled
    }

    /// Privacy-safe lock-screen copy: bot name and calm status only.
    public static func presentation(
        for bot: WantedBot,
        since: Date,
        staleDate: Date?,
        reduceMotion: Bool
    ) -> Presentation {
        let headline: String
        let line: String
        switch bot.kind {
        case .working:
            headline = "\(bot.name) is working"
            line = "Working…"
        case .needsYou:
            headline = "\(bot.name) needs you"
            line = "Open V Bot to answer"
        case .finished:
            headline = "\(bot.name) finished"
            line = "Turn complete"
        }
        return Presentation(
            face: bot.face,
            kind: bot.kind,
            headline: headline,
            line: line,
            requestId: bot.kind == .needsYou ? bot.requestId : nil,
            options: bot.kind == .needsYou ? bot.options : [],
            isPermission: bot.isPermission,
            since: since,
            staleDate: staleDate
        )
    }

    public static func staleDate(context: Context) -> Date? {
        guard context.isBackground, let backgroundedAt = context.backgroundedAt else { return nil }
        return backgroundedAt.addingTimeInterval(lingerDuration)
    }

    public static func lingerExpired(context: Context) -> Bool {
        guard let backgroundedAt = context.backgroundedAt else { return false }
        return context.now.timeIntervalSince(backgroundedAt) >= lingerDuration
    }

    public static func shouldAlert(
        for bot: WantedBot,
        previousRequestId: String?,
        context: Context
    ) -> Bool {
        guard context.notificationsEnabled else { return false }
        guard bot.kind == .needsYou else { return false }
        return previousRequestId != bot.requestId
    }

    /// Fold wanted bots, tracked activities, and lifecycle into commands.
    public static func sync(
        wanted: [WantedBot],
        tracked: [String: TrackedBot],
        context: Context
    ) -> SyncPlan {
        guard shouldSync(context: context) else {
            let ends = tracked.keys.sorted().map { Command.end(botId: $0) }
            return SyncPlan(commands: ends, tracked: [:])
        }

        var nextTracked = tracked
        var commands: [Command] = []
        let wantedById = Dictionary(uniqueKeysWithValues: wanted.map { ($0.botId, $0) })
        var wantedIds = Set(wantedById.keys)
        let stale = staleDate(context: context)

        for bot in wanted {
            let since = nextTracked[bot.botId]?.presentation.since ?? context.now
            let presentation = presentation(for: bot, since: since, staleDate: stale, reduceMotion: context.reduceMotion)
            if let existing = nextTracked[bot.botId] {
                if existing.presentation == presentation { continue }
                let alert = shouldAlert(
                    for: bot,
                    previousRequestId: existing.presentation.requestId,
                    context: context
                )
                commands.append(.update(bot, presentation, alert: alert))
                nextTracked[bot.botId] = TrackedBot(
                    botId: bot.botId,
                    threadId: bot.threadId,
                    name: bot.name,
                    color: bot.color,
                    shape: bot.shape,
                    presentation: presentation,
                    finishedAt: nil
                )
            } else {
                commands.append(.start(bot, presentation))
                nextTracked[bot.botId] = TrackedBot(
                    botId: bot.botId,
                    threadId: bot.threadId,
                    name: bot.name,
                    color: bot.color,
                    shape: bot.shape,
                    presentation: presentation,
                    finishedAt: nil
                )
            }
        }

        for (botId, existing) in tracked where !wantedIds.contains(botId) {
            if context.isBackground, !lingerExpired(context: context) {
                if existing.presentation.kind != .finished {
                    let finishedBot = WantedBot(
                        botId: existing.botId,
                        threadId: existing.threadId,
                        name: existing.name,
                        color: existing.color,
                        shape: existing.shape,
                        face: existing.presentation.face,
                        kind: .finished
                    )
                    let finishedPresentation = presentation(
                        for: finishedBot,
                        since: existing.presentation.since,
                        staleDate: stale,
                        reduceMotion: context.reduceMotion
                    )
                    if existing.presentation != finishedPresentation {
                        commands.append(.update(finishedBot, finishedPresentation, alert: false))
                    }
                    nextTracked[botId] = TrackedBot(
                        botId: existing.botId,
                        threadId: existing.threadId,
                        name: existing.name,
                        color: existing.color,
                        shape: existing.shape,
                        presentation: finishedPresentation,
                        finishedAt: existing.finishedAt ?? context.now
                    )
                }
                continue
            }

            if shouldEndStale(
                botId: botId,
                wantedIds: wantedIds,
                context: context
            ) {
                commands.append(.end(botId: botId))
                nextTracked.removeValue(forKey: botId)
            }
        }

        return SyncPlan(commands: commands, tracked: nextTracked)
    }

    public static func shouldEndStale(
        botId: String,
        wantedIds: Set<String>,
        context: Context
    ) -> Bool {
        guard !wantedIds.contains(botId) else { return false }
        if context.isBackground {
            return lingerExpired(context: context)
        }
        return context.hydrated
    }

    /// Foreground return with a hydrated snapshot ends every activity that is
    /// no longer wanted, including stale working rows.
    public static func reconcileForeground(
        wantedIds: Set<String>,
        activeBotIds: Set<String>,
        hydrated: Bool
    ) -> [String] {
        guard hydrated else { return [] }
        return activeBotIds.subtracting(wantedIds).sorted()
    }

    public static func streamLingerSeconds(isBackground: Bool) -> TimeInterval {
        isBackground ? lingerDuration : 0
    }

}
