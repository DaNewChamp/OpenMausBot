import CoreGraphics
import Foundation

/// Phone-side Local VM desktop policy. Views own SwiftUI and WKWebView;
/// this keeps join/poll/timeout/fallback and persistence rules testable
/// without Apple UI frameworks.
public enum LocalVmDesktopPolicy: Sendable {
    public static let viewerBlankTimeout: Duration = .seconds(8)
    public static let statusPollInterval: Duration = .seconds(2)
    public static let screenshotPollInterval: Duration = .seconds(2)
    public static let ticketRefreshLimit = 2
    public static let joinNotReadyRetryLimit = 3
    public static let joinNotReadyRetryDelay: Duration = .milliseconds(500)
    public static let minimumChromeControlHeight: CGFloat = 44

    public static let checkingMessage = "Checking Local VM…"
    public static let startingDesktopMessage = "The Local VM desktop is still starting."
    public static let openingLiveDesktopMessage = "Opening live desktop…"
    public static let loadingPreviewMessage = "Loading desktop preview…"
    public static let notCreatedMessage = "Local VM is not created yet. Create it from ···, then this screen will show the desktop."
    public static let stoppedMessage = "This Local VM is stopped. Recreate it to start a fresh desktop."
    public static let accessOffMessage = "Local VM access is off for this phone. Turn it on in V Bot → Settings → Companion, then return here."
    public static let viewerConnectFailureMessage = "The live desktop viewer could not connect. Try again, or Recreate from ···."
    public static let staleTicketMessage = "The live desktop session expired. Retry to reconnect."
    public static let viewerNotReadyMessage = "The Local VM desktop is not ready yet."
    public static let viewerAddressInvalidMessage = "The Local VM viewer address was invalid."

    /// Host and loopback fields that must never be stored on the phone.
    public static let forbiddenPersistedKeys: Set<String> = [
        "viewer_url",
        "viewer_path",
        "viewerPath",
        "omb_viewer",
        "workspace_path",
        "workspace_guest_path",
        "image_id",
        "image_ref",
        "base_image_ref",
        "container_name",
        "target_key",
        "viewer_port",
        "password",
    ]

    public enum Surface: Equatable, Sendable {
        case checking
        case starting(message: String)
        case liveViewer
        case screenshotInteractive
        case screenshotWatchOnly
        case unavailable(message: String, retry: Bool)

        public var presentationState: ComputerPresentationState {
            switch self {
            case .checking, .starting:
                return .starting
            case .liveViewer, .screenshotInteractive, .screenshotWatchOnly:
                return .watching
            case let .unavailable(message, _):
                return .unavailable(message: message)
            }
        }

        public var isInteractive: Bool {
            switch self {
            case .liveViewer, .screenshotInteractive: return true
            case .checking, .starting, .screenshotWatchOnly, .unavailable: return false
            }
        }

        public var showsRetry: Bool {
            if case let .unavailable(_, retry) = self { return retry }
            return false
        }
    }

    public struct Snapshot: Equatable, Sendable {
        public var status: LocalVmStatus?
        public var accessGranted: Bool
        public var hasScreenshot: Bool
        public var viewerURLPresent: Bool
        public var viewerFailed: Bool
        public var viewerReady: Bool
        public var instanceResolved: Bool
        public var destinationsLoading: Bool

        public init(
            status: LocalVmStatus? = nil,
            accessGranted: Bool = false,
            hasScreenshot: Bool = false,
            viewerURLPresent: Bool = false,
            viewerFailed: Bool = false,
            viewerReady: Bool = false,
            instanceResolved: Bool = true,
            destinationsLoading: Bool = false
        ) {
            self.status = status
            self.accessGranted = accessGranted
            self.hasScreenshot = hasScreenshot
            self.viewerURLPresent = viewerURLPresent
            self.viewerFailed = viewerFailed
            self.viewerReady = viewerReady
            self.instanceResolved = instanceResolved
            self.destinationsLoading = destinationsLoading
        }
    }

    public enum ViewerFailure: Equatable, Sendable {
        case staleTicket
        case blankTimeout
        case navigationError
        case joinFailed
        case explicitRetry
    }

    public enum JoinHTTPOutcome: Equatable, Sendable {
        case retryNotReady
        case staleTicket
        case notReadyExhausted
        case transientFailure
    }

    public enum ViewerHealthSignal: String, Equatable, Sendable {
        case ok
        case waiting
        case auth
    }

    public static func isLocalVm(_ bot: Bot) -> Bool {
        bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "vm"
    }

    public static func surface(bot: Bot, snapshot: Snapshot) -> Surface {
        guard isLocalVm(bot) else { return .unavailable(message: ComputerPresentationState.unavailableMessage(for: bot), retry: false) }
        guard snapshot.accessGranted else {
            if snapshot.hasScreenshot { return .screenshotWatchOnly }
            return .unavailable(message: accessOffMessage, retry: false)
        }

        guard let status = snapshot.status else {
            return snapshot.hasScreenshot ? .screenshotWatchOnly : .checking
        }

        switch status.state {
        case .missing:
            return .unavailable(message: status.problem ?? notCreatedMessage, retry: false)
        case .stopped:
            return .unavailable(message: status.problem ?? stoppedMessage, retry: false)
        case .unavailable:
            return .unavailable(message: status.problem ?? "The Local VM desktop is unavailable.", retry: true)
        case .unknown:
            if snapshot.hasScreenshot { return .screenshotWatchOnly }
            return .starting(message: status.problem ?? checkingMessage)
        case .running:
            if snapshot.hasScreenshot { return .screenshotWatchOnly }
            return .starting(message: status.problem ?? startingDesktopMessage)
        case .ready:
            return readySurface(snapshot: snapshot, status: status)
        }
    }

    private static func readySurface(snapshot: Snapshot, status: LocalVmStatus) -> Surface {
        if snapshot.viewerReady, snapshot.viewerURLPresent, !snapshot.viewerFailed {
            return .liveViewer
        }
        if snapshot.viewerFailed || (snapshot.viewerURLPresent && !snapshot.viewerReady) {
            if snapshot.hasScreenshot { return .screenshotInteractive }
            if snapshot.viewerFailed {
                return .unavailable(message: viewerConnectFailureMessage, retry: true)
            }
            return .starting(message: openingLiveDesktopMessage)
        }
        if snapshot.viewerURLPresent {
            return snapshot.viewerReady ? .liveViewer : .starting(message: openingLiveDesktopMessage)
        }
        if snapshot.hasScreenshot { return .screenshotInteractive }
        return .starting(message: status.ready ? openingLiveDesktopMessage : loadingPreviewMessage)
    }

    public static func shouldJoinViewer(bot: Bot, snapshot: Snapshot) -> Bool {
        guard isLocalVm(bot), snapshot.accessGranted, snapshot.status?.ready == true else { return false }
        if snapshot.viewerFailed { return false }
        return true
    }

    /// Keep polling while this Computer screen is showing a Local VM whose
    /// grant has not been denied. A 403 is terminal for the session.
    public static func continueStatusPolling(isLocalVm: Bool, accessDenied: Bool) -> Bool {
        isLocalVm && !accessDenied
    }

    public static func shouldPollStatus(bot: Bot, accessDenied: Bool) -> Bool {
        continueStatusPolling(isLocalVm: isLocalVm(bot), accessDenied: accessDenied)
    }

    /// Automatic status polling is active only while the Computer screen can
    /// reach the paired companion. Offline gaps stop the poll loop from
    /// recovering on its own, so the banner may offer an explicit Retry.
    public static func statusPollingActive(
        isLocalVm: Bool,
        accessDenied: Bool,
        connectionLive: Bool
    ) -> Bool {
        continueStatusPolling(isLocalVm: isLocalVm, accessDenied: accessDenied) && connectionLive
    }

    public static func shouldPollScreenshot(bot: Bot, snapshot: Snapshot) -> Bool {
        guard isLocalVm(bot), snapshot.accessGranted else { return false }
        if snapshot.viewerReady {
            return needsSeedScreenshot(snapshot: snapshot)
        }
        switch snapshot.status?.state {
        case .missing, .stopped, .unavailable: return false
        case .ready, .running, .unknown, nil: return true
        }
    }

    /// Live viewer can become ready before the first idle screenshot lands.
    /// Request one seed capture for Save, then stop polling.
    public static func needsSeedScreenshot(snapshot: Snapshot) -> Bool {
        snapshot.viewerReady && !snapshot.hasScreenshot
    }

    public static func joinHTTPOutcome(statusCode: Int, attempt: Int) -> JoinHTTPOutcome {
        switch statusCode {
        case 401, 403:
            return .staleTicket
        case 409:
            return attempt + 1 < joinNotReadyRetryLimit ? .retryNotReady : .notReadyExhausted
        default:
            return .transientFailure
        }
    }

  /// noVNC health: require a connected RFB session when the object exists.
  /// Legacy canvas sizing is only used before RFB is exposed.
    public static func viewerHealthSignal(
        rfbPresent: Bool,
        rfbConnectionState: String?,
        canvasWidth: Int,
        canvasHeight: Int,
        bodyContainsPairPrompt: Bool
    ) -> ViewerHealthSignal {
        if bodyContainsPairPrompt { return .auth }
        if rfbPresent {
            if rfbConnectionState == "connected" { return .ok }
            return .waiting
        }
        if canvasWidth > 8 && canvasHeight > 8 { return .ok }
        return .waiting
    }

    /// Local VM never uses the SSE first-frame timeout. Status polling,
    /// screenshot polling, and the viewer blank timeout cover starting/ready.
    public static func usesLiveScreenStreamTimeout() -> Bool { false }

    public static func wantsScreenshotWatch(status: LocalVmStatus?, accessGranted: Bool) -> Bool {
        _ = status
        _ = accessGranted
        return usesLiveScreenStreamTimeout()
    }

    public static func remountsViewerWhenPointerModeChanges() -> Bool { false }

    public static func shouldReloadViewer(stableKeyChanged: Bool, generationChanged: Bool) -> Bool {
        generationChanged || stableKeyChanged
    }

    public static func shouldRefreshTicket(failureCount: Int, reason: ViewerFailure) -> Bool {
        switch reason {
        case .staleTicket, .blankTimeout, .explicitRetry:
            return failureCount < ticketRefreshLimit
        case .navigationError, .joinFailed:
            return failureCount < 1
        }
    }

    public static func destinationControlsEnabled(isLoading: Bool, instanceResolved: Bool) -> Bool {
        CalmSurfacePolicy.destinationsSelectable(isLoading: isLoading, instanceResolved: instanceResolved)
    }

    public static func encodedObjectIsPhoneSafe(_ object: [String: Any]) -> Bool {
        Set(object.keys).isDisjoint(with: forbiddenPersistedKeys)
    }

    public static func stableViewerKey(for url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        components.fragment = nil
        if var queryItems = components.queryItems {
            queryItems.removeAll { $0.name == "omb_viewer" }
            components.queryItems = queryItems.isEmpty ? nil : queryItems
        }
        return components.string ?? url.absoluteString
    }

    public static func failure(forHTTPStatus status: Int) -> ViewerFailure {
        status == 401 || status == 403 ? .staleTicket : .navigationError
    }

    public static func message(for failure: ViewerFailure) -> String {
        switch failure {
        case .staleTicket: return staleTicketMessage
        case .blankTimeout, .navigationError, .joinFailed: return viewerConnectFailureMessage
        case .explicitRetry: return openingLiveDesktopMessage
        }
    }
}

/// Localized Computer-surface banner for transient Local VM status-poll
/// failures. Keeps stale desktop content honest without routing through chat
/// `actionError` or re-announcing on every two-second poll tick.
public enum LocalVmStatusErrorBanner: Sendable {
    public static let message = "Connection interrupted. Retrying…"
    public static let retryTitle = "Retry"

    public struct Presentation: Equatable, Sendable {
        public var isVisible: Bool
        public var message: String
        public var showsRetry: Bool
        /// Stable identity for VoiceOver; nil while hidden.
        public var accessibilityEpisode: String?
    }

    public static func normalizedError(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public static func presentation(
        isLocalVm: Bool,
        statusError: String?,
        accessDenied: Bool,
        statusPollingActive: Bool
    ) -> Presentation {
        guard isLocalVm,
              !accessDenied,
              let episode = normalizedError(statusError)
        else {
            return Presentation(
                isVisible: false,
                message: message,
                showsRetry: false,
                accessibilityEpisode: nil
            )
        }
        return Presentation(
            isVisible: true,
            message: message,
            showsRetry: !statusPollingActive,
            accessibilityEpisode: episode
        )
    }

    /// Returns the banner copy when a new accessibility episode begins.
    public static func accessibilityAnnouncement(
        lastAnnouncedEpisode: String?,
        presentation: Presentation
    ) -> String? {
        guard presentation.isVisible,
              let episode = presentation.accessibilityEpisode,
              episode != lastAnnouncedEpisode
        else { return nil }
        return presentation.message
    }
}
