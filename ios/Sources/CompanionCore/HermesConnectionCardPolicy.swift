import Foundation

public struct HermesConnectionCardContext: Equatable, Sendable {
    public var isPending: Bool
    public var isDismissed: Bool
    public var hermesStatus: HermesSetupStatus?
    public var isLoading: Bool
    /// False until the first status fetch for the active connection finishes.
    /// A nil status before that is still loading; afterward nil means cancel.
    public var hasAttemptedStatusFetch: Bool

    public init(
        isPending: Bool,
        isDismissed: Bool,
        hermesStatus: HermesSetupStatus? = nil,
        isLoading: Bool = false,
        hasAttemptedStatusFetch: Bool = false
    ) {
        self.isPending = isPending
        self.isDismissed = isDismissed
        self.hermesStatus = hermesStatus
        self.isLoading = isLoading
        self.hasAttemptedStatusFetch = hasAttemptedStatusFetch
    }
}

public struct HermesConnectionCardPresentation: Equatable, Sendable {
    public let title: String
    public let message: String
    public let primaryActionTitle: String
    public let detail: String?

    public init(
        title: String,
        message: String,
        primaryActionTitle: String,
        detail: String? = nil
    ) {
        self.title = title
        self.message = message
        self.primaryActionTitle = primaryActionTitle
        self.detail = detail
    }
}

/// Optional post-pair Hermes offer shown on the chat roster. Uses only the
/// safe setup projection; provider credentials and diagnostics never appear.
public enum HermesConnectionCardPolicy {
    public static func shouldShow(_ context: HermesConnectionCardContext) -> Bool {
        guard !context.isDismissed else { return false }
        guard context.isPending else { return false }
        guard !context.isLoading else { return false }
        return isConnectable(context.hermesStatus)
    }

    public static func shouldKeepPending(_ context: HermesConnectionCardContext) -> Bool {
        guard context.isPending else { return false }
        guard !context.isDismissed else { return false }
        if context.isLoading { return true }
        if context.hermesStatus == nil {
            return !context.hasAttemptedStatusFetch
        }
        switch context.hermesStatus?.state {
        case .connected, .unavailable, .unknown:
            return false
        case .disabled, .ready, nil:
            return true
        }
    }

    public static func isConnectable(_ status: HermesSetupStatus?) -> Bool {
        guard let status else { return false }
        switch status.state {
        case .disabled, .ready:
            return true
        case .connected, .unavailable, .unknown:
            return false
        }
    }

    /// Resolves the Hermes bot to open after a successful card connect action.
    public static func navigationBotID(afterConnect response: HermesSetupConnectionResponse?) -> String? {
        guard let response, !response.botId.isEmpty else { return nil }
        return response.botId
    }

    public static func presentation(
        status: HermesSetupStatus?,
        isLoading: Bool
    ) -> HermesConnectionCardPresentation {
        let mapped = HermesSetupPresentationPolicy.presentation(status: status, isLoading: isLoading)
        return HermesConnectionCardPresentation(
            title: mapped.title,
            message: mapped.message,
            primaryActionTitle: mapped.actionTitle ?? "Connect Hermes",
            detail: mapped.state == .ready
                ? "Optional. V Bot works without Hermes."
                : nil
        )
    }
}
