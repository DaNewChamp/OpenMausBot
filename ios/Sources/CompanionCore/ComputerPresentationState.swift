import Foundation

/// The small set of computer states the phone can honestly present.
///
/// A screen frame is a watch-only surface unless Local VM policy says the
/// companion-proxied viewer (or screenshot canvas) is interactive. The only
/// cloud viewer this client can open is the secure Box viewer minted by the
/// paired computer; VPS and local-host destinations stay watch-only.
public enum ComputerPresentationState: Equatable, Sendable {
    case starting
    case watching
    case unavailable(message: String)
    case cloudViewerAvailable

    /// The calm, single-copy card shown when a computer cannot be opened yet.
    /// Keeping title/body/action together prevents a destination hint from
    /// being rendered twice by the SwiftUI surface.
    public struct CardCopy: Equatable, Sendable {
        public enum Action: String, Equatable, Sendable {
            case createLocalVm
            case recreateLocalVm
            case retry
            case openCloudDesktop
        }

        public let title: String
        public let body: String
        public let action: Action?

        public init(title: String, body: String, action: Action? = nil) {
            self.title = title
            self.body = body
            self.action = action
        }
    }

    /// Maps the authoritative bot record and the latest optional frame to a
    /// display state. Configuration and failures win over a cached frame:
    /// showing a screen after the computer was disabled, stopped, or lost is
    /// more misleading than showing a waiting card.
    ///
    /// Pass `localVm` for the Local VM Computer screen so missing/stopped/error
    /// and viewer fallback are honest. Call sites that omit it keep the
    /// generic watch-only mapping.
    public init(
        bot: Bot,
        frame: ScreenFrame? = nil,
        loadFailure: String? = nil,
        localVm: LocalVmDesktopPolicy.Snapshot? = nil
    ) {
        if let loadFailure {
            let message = loadFailure.trimmingCharacters(in: .whitespacesAndNewlines)
            self = message.isEmpty
                ? .unavailable(message: "We couldn't load this computer right now.")
                : .unavailable(message: message)
        } else if let localVm, LocalVmDesktopPolicy.isLocalVm(bot) {
            self = LocalVmDesktopPolicy.surface(bot: bot, snapshot: localVm).presentationState
        } else if !Self.hasKnownComputer(bot) {
            self = .unavailable(message: Self.unavailableMessage(for: bot))
        } else if bot.busy != true {
            let computer = bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if computer == "vm" {
                self = frame != nil ? .watching : .starting
            } else if Self.supportsCloudViewer(bot) {
                self = .cloudViewerAvailable
            } else if bot.computer == "cloud" && bot.cloudBackend == "vps" {
                self = .unavailable(message: CloudViewerPolicy.vpsWatchCopy)
            } else {
                self = .unavailable(message: Self.idleWaitingMessage)
            }
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
        loadFailure: String? = nil,
        localVm: LocalVmDesktopPolicy.Snapshot? = nil
    ) -> Self {
        Self(bot: bot, frame: frame, loadFailure: loadFailure, localVm: localVm)
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

    /// Local VM lifecycle controls are available for an explicitly configured
    /// VM whose paired device has received the safe status projection and at
    /// least one guarded server-side action (create, stop, recreate).
    public static func supportsLocalVmControls(
        _ bot: Bot,
        status: LocalVmStatus?,
        accessGranted: Bool
    ) -> Bool {
        guard accessGranted,
              bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "vm",
              let status
        else { return false }
        return status.canCreate || status.canStop || status.canRecreate
    }

    /// Computer values are supplied by the desktop and can grow over time.
    /// An omitted value is the server's Auto mode: the desktop chooses Box,
    /// VPS, Local VM, or local CUA for the turn and can still stream a frame.
    /// Explicit `off` and future values are honest unavailable states.
    public static func hasKnownComputer(_ bot: Bot) -> Bool {
        guard let raw = bot.computer else { return true }
        let computer = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch computer {
        case "cloud", "local", "vm": return true
        default: return false
        }
    }

    public static let idleWaitingMessage = "No live screen is available until this agent is working."

    /// Whether the destination can only be watched while a turn is running.
    public static func isVpsWatchOnly(_ bot: Bot) -> Bool {
        bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "cloud"
            && bot.cloudBackend?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "vps"
    }

    /// The one card copy used by ComputerView. Inputs are projections only;
    /// no raw command, URL, token, or backend error is placed in the card.
    public static func cardCopy(
        for state: Self,
        bot: Bot,
        localVm: LocalVmDesktopPolicy.Snapshot? = nil,
        localVmDestinationEnabled: Bool = true,
        localVmDestinationReason: String? = nil,
        canRetry: Bool = false
    ) -> CardCopy {
        if state == .cloudViewerAvailable {
            return CardCopy(
                title: CloudViewerPolicy.boxReadyTitle,
                body: "Open the secure cloud desktop to control it in the in-app browser.",
                action: .openCloudDesktop
            )
        }

        if isVpsWatchOnly(bot) {
            return CardCopy(
                title: "Watch-only desktop",
                body: "Send a message to start a turn, then watch the VPS desktop here while the agent works."
            )
        }

        if let localVm, LocalVmDesktopPolicy.isLocalVm(bot) {
            if !localVm.accessGranted {
                return CardCopy(
                    title: "Enable Local VM access",
                    body: LocalVmDesktopPolicy.accessOffMessage
                )
            }

            if !localVmDestinationEnabled,
               localVm.instanceResolved,
               let reason = localVmDestinationReason,
               !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !reason.localizedCaseInsensitiveContains("checking") {
                if reason.localizedCaseInsensitiveContains("grok reconstructed") {
                    return CardCopy(
                        title: "Local VM isn't available for this engine",
                        body: "Grok Reconstructed uses its own desktop. Choose a Local VM-capable engine in the profile."
                    )
                }
                return CardCopy(
                    title: "Local VM isn't available",
                    body: "Choose a Local VM-capable engine in the profile, then select Local from ···."
                )
            }

            if let status = localVm.status {
                switch status.state {
                case .missing:
                    return CardCopy(
                        title: "Create a Local VM",
                        body: "Create a Local VM from ···. Once it starts, this screen will show the desktop.",
                        action: status.canCreate ? .createLocalVm : nil
                    )
                case .stopped:
                    return CardCopy(
                        title: "Restart the Local VM",
                        body: "This Local VM is stopped. Recreate it from ··· to start a fresh desktop.",
                        action: status.canRecreate ? .recreateLocalVm : nil
                    )
                case .unavailable:
                    return CardCopy(
                        title: "Local VM unavailable",
                        body: "The desktop could not be reached. Try again, or recreate it from ···.",
                        action: canRetry ? .retry : (status.canRecreate ? .recreateLocalVm : nil)
                    )
                case .ready, .running, .unknown:
                    if state == .starting {
                        switch status.state {
                        case .ready:
                            return CardCopy(
                                title: "Opening Local VM",
                                body: localVm.viewerURLPresent
                                    ? LocalVmDesktopPolicy.openingLiveDesktopMessage
                                    : LocalVmDesktopPolicy.loadingPreviewMessage
                            )
                        case .running:
                            return CardCopy(
                                title: "Starting Local VM",
                                body: LocalVmDesktopPolicy.startingDesktopMessage
                            )
                        case .unknown:
                            return CardCopy(
                                title: "Checking Local VM",
                                body: LocalVmDesktopPolicy.checkingMessage
                            )
                        case .missing, .stopped, .unavailable:
                            break
                        }
                    }
                }
            }
        }

        switch state {
        case .starting:
            return CardCopy(
                title: "Preparing desktop",
                body: startingCopy(for: bot)
            )
        case .watching:
            return CardCopy(title: "Desktop", body: "The desktop is live.")
        case .cloudViewerAvailable:
            // Handled above; keep this exhaustive for future state additions.
            return CardCopy(title: CloudViewerPolicy.boxReadyTitle, body: CloudViewerPolicy.boxReadyCopy, action: .openCloudDesktop)
        case let .unavailable(message):
            if message == idleWaitingMessage {
                return CardCopy(
                    title: "Waiting for agent",
                    body: "The desktop appears here while the agent is working."
                )
            }
            return CardCopy(
                title: "Computer unavailable",
                body: message,
                action: canRetry ? .retry : nil
            )
        }
    }

    /// Returns a secondary hint only when it adds information to the card.
    /// This is deliberately case-insensitive so server wording changes do not
    /// reintroduce the duplicated VPS copy seen on older builds.
    public static func distinctSecondaryCopy(primary: String, secondary: String?) -> String? {
        guard let secondary else { return nil }
        let normalizedPrimary = primary.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSecondary = secondary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSecondary.isEmpty,
              normalizedPrimary.caseInsensitiveCompare(normalizedSecondary) != .orderedSame
        else { return nil }
        return normalizedSecondary
    }

    public static func unavailableMessage(for bot: Bot) -> String {
        guard let computer = bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines), !computer.isEmpty else {
            return idleWaitingMessage
        }
        if computer.lowercased() == "off" {
            return "Computer access is turned off for this agent."
        }
        return "This computer type isn't supported on this phone."
    }

    /// Watch timeouts and decode failures apply only while the bot is working
    /// or the destination is Local VM. An idle VPS must keep the waiting card
    /// instead of inheriting a stale "No screen frame arrived" error.
    public static func streamLoadFailure(
        streamFailure: String?,
        watchFailure: String?,
        wantsScreenPreview: Bool
    ) -> String? {
        if let streamFailure { return streamFailure }
        guard wantsScreenPreview else { return nil }
        return watchFailure
    }

    public var isIdleWaiting: Bool {
        if case let .unavailable(message) = self {
            return message == Self.idleWaitingMessage
        }
        return false
    }

    public var canOpenCloudViewer: Bool {
        self == .cloudViewerAvailable
    }

    /// Honest watch-only caption for backends that can stream frames but
    /// cannot open an interactive phone viewer.
    public static func watchCaption(for bot: Bot) -> String? {
        guard bot.computer == "cloud", bot.cloudBackend == "vps" else { return nil }
        return CloudViewerPolicy.vpsBusyWatchCopy
    }

    /// Waiting-card copy while a frame has not arrived. VPS busy copy is
    /// only for `cloudBackend == "vps"` and never for This Mac.
    public static func startingCopy(for bot: Bot) -> String {
        startingCopy(computer: bot.computer, cloudBackend: bot.cloudBackend, busy: bot.busy)
    }

    public static func startingCopy(computer: String?, cloudBackend: String?, busy: Bool?) -> String {
        let destination = computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if destination != "local", cloudBackend == "vps" {
            return CloudViewerPolicy.vpsBusyWatchCopy
        }
        if busy == true {
            return "Waiting for the first frame."
        }
        return "This Bot's computer is captured while it is working."
    }

    /// Destination subtitle. Local always uses This Mac copy, even if a
    /// stale `cloudBackend` value is present.
    public static func destinationHelp(for bot: Bot) -> String? {
        destinationHelp(computer: bot.computer, cloudBackend: bot.cloudBackend)
    }

    public static func destinationHelp(computer: String?, cloudBackend: String?) -> String? {
        switch computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "cloud":
            return cloudBackend == "vps"
                ? CloudViewerPolicy.vpsWatchCopy
                : "Running on Cloud. Open a live frame while the agent is working, or use Open cloud desktop."
        case "local":
            return "Running on this Mac. Use ··· to switch to Local or Cloud."
        case "off":
            return "Computer access is off. Use ··· to switch to Local or Cloud."
        default:
            return nil
        }
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
