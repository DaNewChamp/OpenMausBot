import Foundation

/// Tracks the computer panels that currently need screen frames.
///
/// The stream is shared by every panel, while frames are keyed by bot. A
/// per-bot count keeps one panel closing from clearing a frame still needed by
/// another panel for the same bot.
public struct ScreenWatchRegistry: Equatable, Sendable {
    public struct StopResult: Equatable, Sendable {
        public let stopped: Bool
        public let lastForBot: Bool
        public let lastOverall: Bool
        public let remainingForBot: Int

        public init(
            stopped: Bool,
            lastForBot: Bool,
            lastOverall: Bool,
            remainingForBot: Int
        ) {
            self.stopped = stopped
            self.lastForBot = lastForBot
            self.lastOverall = lastOverall
            self.remainingForBot = remainingForBot
        }
    }

    private var counts: [String: Int] = [:]

    public init() {}

    public var totalCount: Int {
        counts.values.reduce(0, +)
    }

    public func count(for botId: String) -> Int {
        counts[botId, default: 0]
    }

    public func isWatching(botId: String) -> Bool {
        count(for: botId) > 0
    }

    /// Starts a panel and returns whether this is the first screen watcher in
    /// the shared session.
    @discardableResult
    public mutating func start(botId: String) -> Bool {
        counts[botId, default: 0] += 1
        return totalCount == 1
    }

    /// Stops one panel and reports which frames/streams the caller may tear
    /// down. An unmatched stop is a no-op, which makes repeated SwiftUI
    /// disappearance callbacks harmless.
    public mutating func stop(botId: String) -> StopResult {
        guard let current = counts[botId], current > 0 else {
            return StopResult(
                stopped: false,
                lastForBot: false,
                lastOverall: false,
                remainingForBot: 0
            )
        }

        if current == 1 {
            counts.removeValue(forKey: botId)
        } else {
            counts[botId] = current - 1
        }

        return StopResult(
            stopped: true,
            lastForBot: current == 1,
            lastOverall: totalCount == 0,
            remainingForBot: counts[botId, default: 0]
        )
    }
}
