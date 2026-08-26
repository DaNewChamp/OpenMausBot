/// Platform-neutral policy for the companion's first-run and pairing flow.
///
/// Keeping these transitions outside SwiftUI makes the crash-sensitive
/// lifecycle deterministic: a skip is not a pairing, a pending deep link
/// still opens pairing, and a revoked credential never falls through to an
/// ordinary empty state.
public enum CompanionPairingState: Equatable, Sendable {
    case unpaired
    case paired
    case revoked
}

public enum CompanionOnboardingRoute: Equatable, Sendable {
    case welcome
    case pairing
    case unpairedHome
    case notificationPrompt
    case chats
    case revoked
}

/// UserNotifications answers asynchronously at launch. Keep that unresolved
/// window distinct from a real `.notDetermined` result so first-pair
/// education cannot be spent before iOS has answered.
public enum CompanionNotificationAuthorizationState: Equatable, Sendable {
    case unresolved
    case notDetermined
    case determined
}

public enum CompanionOnboardingPreferences {
    public static let pendingNotificationOnboardingKey =
        "companion.onboarding.notificationPending"
}

/// The notification marker is written before the restorable connection. An
/// orphan marker while unpaired is harmless; a connection without its marker
/// could permanently skip first-pair education after a crash.
public enum CompanionPairingCommitSequence {
    public static func persist(
        markNotificationOnboardingPending: () -> Void,
        saveConnection: () -> Void
    ) {
        markNotificationOnboardingPending()
        saveConnection()
    }
}

public enum CompanionPairingInviteEvent: Equatable, Sendable {
    case received(PairingInvite)
    case consumed
    case pairingSucceeded
    case signedOut
}

/// Invite lifecycle policy shared by Session and tests. Publishing a
/// connection closes the deep-link race even before the status publisher has
/// delivered its next value to the view hierarchy.
public enum CompanionPairingInvitePolicy {
    public static func allowsIncomingInvite(
        hasConnection: Bool,
        pairingStateIsUnpaired: Bool
    ) -> Bool {
        !hasConnection && pairingStateIsUnpaired
    }

    public static func nextInvite(
        current: PairingInvite?,
        after event: CompanionPairingInviteEvent
    ) -> PairingInvite? {
        switch event {
        case let .received(invite): return invite
        case .consumed, .pairingSucceeded, .signedOut: return nil
        }
    }
}

/// Pure lifecycle policy for the durable first-pair notification marker.
public enum CompanionNotificationOnboardingPolicy {
    public static func shouldKeepPending(
        isPending: Bool,
        hasCompletedStep: Bool,
        authorization: CompanionNotificationAuthorizationState
    ) -> Bool {
        guard isPending else { return false }
        guard authorization != .unresolved else { return true }
        return authorization == .notDetermined && !hasCompletedStep
    }
}

/// Prevents a second Connect, reset, or dismissal from overtaking a pairing
/// request which may already have persisted a device on the computer.
public struct CompanionPairingSubmissionState: Equatable, Sendable {
    public private(set) var isInFlight = false

    public init() {}

    public var allowsNavigation: Bool { !isInFlight }

    @discardableResult
    public mutating func begin() -> Bool {
        guard !isInFlight else { return false }
        isInFlight = true
        return true
    }

    public mutating func finish() {
        isInFlight = false
    }
}

public struct CompanionOnboardingContext: Equatable, Sendable {
    public var pairingState: CompanionPairingState
    public var hasSeenWelcome: Bool
    public var pairingRequested: Bool
    public var hasPendingPairingInvite: Bool
    /// Set only after a new pairing commits; upgrades for existing paired
    /// users must not unexpectedly interrupt their chat.
    public var notificationOnboardingPending: Bool
    public var hasSeenNotificationPrompt: Bool
    public var notificationAuthorization: CompanionNotificationAuthorizationState

    public init(
        pairingState: CompanionPairingState,
        hasSeenWelcome: Bool,
        pairingRequested: Bool = false,
        hasPendingPairingInvite: Bool = false,
        notificationOnboardingPending: Bool = false,
        hasSeenNotificationPrompt: Bool = false,
        notificationAuthorization: CompanionNotificationAuthorizationState = .notDetermined
    ) {
        self.pairingState = pairingState
        self.hasSeenWelcome = hasSeenWelcome
        self.pairingRequested = pairingRequested
        self.hasPendingPairingInvite = hasPendingPairingInvite
        self.notificationOnboardingPending = notificationOnboardingPending
        self.hasSeenNotificationPrompt = hasSeenNotificationPrompt
        self.notificationAuthorization = notificationAuthorization
    }
}

public enum CompanionOnboardingRouter {
    public static func route(for context: CompanionOnboardingContext) -> CompanionOnboardingRoute {
        switch context.pairingState {
        case .revoked:
            return .revoked
        case .paired:
            if context.notificationOnboardingPending,
               !context.hasSeenNotificationPrompt,
               context.notificationAuthorization == .notDetermined {
                return .notificationPrompt
            }
            return .chats
        case .unpaired:
            if context.pairingRequested || context.hasPendingPairingInvite {
                return .pairing
            }
            return context.hasSeenWelcome ? .unpairedHome : .welcome
        }
    }
}
