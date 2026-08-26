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
    /// display state. A failure wins over capability, because showing a
    /// disabled-looking viewer while the stream is broken is misleading.
    public init(bot: Bot, frame: ScreenFrame? = nil, loadFailure: String? = nil) {
        if frame != nil {
            self = .watching
        } else if let loadFailure {
            let message = loadFailure.trimmingCharacters(in: .whitespacesAndNewlines)
            self = message.isEmpty
                ? .unavailable(message: "We couldn't load this computer right now.")
                : .unavailable(message: message)
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
        bot.computer == "cloud" && bot.cloudBackend != "vps"
    }

    public var canOpenCloudViewer: Bool {
        self == .cloudViewerAvailable
    }
}
