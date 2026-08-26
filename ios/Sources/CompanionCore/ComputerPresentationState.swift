import Foundation

/// The small set of computer states the phone can honestly present.
///
/// A screen frame is a watch-only surface. The only interactive viewer this
/// client can open is the secure Box viewer minted by the paired computer;
/// VPS, Local VM, and local-host destinations deliberately never map to that
/// capability.
public enum ComputerPresentationState: Equatable, Sendable {
    case starting
    case watching
    case unavailable(message: String)
    case cloudViewerAvailable

    /// Maps the authoritative bot record and the latest optional frame to a
    /// display state. Configuration and failures win over a cached frame:
    /// showing a screen after the computer was disabled, stopped, or lost is
    /// more misleading than showing a waiting card.
    public init(bot: Bot, frame: ScreenFrame? = nil, loadFailure: String? = nil) {
        if let loadFailure {
            let message = loadFailure.trimmingCharacters(in: .whitespacesAndNewlines)
            self = message.isEmpty
                ? .unavailable(message: "We couldn't load this computer right now.")
                : .unavailable(message: message)
        } else if !Self.hasKnownComputer(bot) {
            self = .unavailable(message: Self.unavailableMessage(for: bot))
        } else if bot.busy != true {
            // Frames are emitted only while a bot is working. A frame held
            // after the turn ends is a cache, not a live desktop.
            self = Self.supportsCloudViewer(bot)
                ? .cloudViewerAvailable
                : .unavailable(message: "No live screen is available until this agent is working.")
        } else if frame != nil {
            self = .watching
        } else if Self.supportsCloudViewer(bot) {
            self = .cloudViewerAvailable
        } else {
            self = .starting
        }
    }

    /// A named form is useful at call sites that already have a bot and keeps
    /// the policy easy to discover without exposing UI concerns in the app.
    public static func resolve(
        bot: Bot,
        frame: ScreenFrame? = nil,
        loadFailure: String? = nil
    ) -> Self {
        Self(bot: bot, frame: frame, loadFailure: loadFailure)
    }

    /// Whether this bot can receive a fresh, secure cloud viewer URL.
    /// `cloudBackend == "vps"` is intentionally excluded: the paired phone
    /// cannot use the desktop-only loopback SSH viewer.
    public static func supportsCloudViewer(_ bot: Bot) -> Bool {
        guard bot.computer == "cloud" else { return false }
        // `nil` is the legacy cloud shape and means Box. Any explicit value
        // must be one this client knows how to open; a future backend must
        // remain watch-only until the phone learns its secure handoff.
        return bot.cloudBackend == nil || bot.cloudBackend == "box"
    }

    /// Computer values are supplied by the desktop and can grow over time.
    /// Only the three values this client can describe get a waiting state;
    /// `nil`, `off`, and future values are honest unavailable states.
    public static func hasKnownComputer(_ bot: Bot) -> Bool {
        switch bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "cloud", "local", "vm": return true
        default: return false
        }
    }

    public static func unavailableMessage(for bot: Bot) -> String {
        guard let computer = bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines), !computer.isEmpty else {
            return "No computer is configured for this agent."
        }
        if computer.lowercased() == "off" {
            return "Computer access is turned off for this agent."
        }
        return "This computer type isn't supported on this phone."
    }

    public var canOpenCloudViewer: Bool {
        self == .cloudViewerAvailable
    }
}

/// Lifecycle events for the watch-only screen stream. Keeping timeout and
/// retry transitions here makes the UI a projection of observable events,
/// rather than a spinner that can remain forever because no callback arrived.
public struct ComputerWatchLifecycle: Equatable, Sendable {
    public static let firstFrameTimeout: Duration = .seconds(8)

    public enum Phase: Equatable, Sendable {
        case idle
        case waiting
        case watching
        case unavailable(message: String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var attempt: Int = 0

    public init() {}

    public var isWaiting: Bool { phase == .waiting }

    public var failureMessage: String? {
        guard case let .unavailable(message) = phase else { return nil }
        return message
    }

    public mutating func begin() {
        attempt += 1
        phase = .waiting
    }

    public mutating func retry() { begin() }

    /// Forget the last stream phase when the bot's computer or working state
    /// changes. Incrementing the attempt also cancels any timeout task that
    /// was waiting on the previous phase.
    public mutating func reset() {
        attempt += 1
        phase = .idle
    }

    public mutating func receivedFrame() {
        phase = .watching
    }

    public mutating func failed(_ message: String? = nil) {
        let normalized = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        phase = .unavailable(
            message: normalized.isEmpty
                ? "We couldn't load this computer right now."
                : normalized
        )
    }

    public mutating func timedOut() {
        failed("No screen frame arrived. The computer may be asleep or unavailable.")
    }
}
