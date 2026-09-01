import Foundation

/// The safe, display-only state returned by the companion Hermes setup
/// routes. Provider credentials, paths, session ids, and diagnostics never
/// cross this boundary.
public enum HermesSetupState: String, Codable, Sendable, Equatable {
    case disabled
    case ready
    case connected
    case unavailable
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum HermesSetupReason: String, Codable, Sendable, Equatable {
    case missingCLI = "missing_cli"
    case invalidCredentials = "invalid_credentials"
    case gatewayUnavailable = "gateway_unavailable"
    case stateUnavailable = "state_unavailable"
    case malformedResponse = "malformed_response"
    case timeout
    case profileUnavailable = "profile_unavailable"
    case upstreamError = "upstream_error"
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum HermesCanonicalState: String, Codable, Sendable, Equatable {
    case present
    case absent
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum HermesProfileAvailability: String, Codable, Sendable, Equatable {
    case available
    case unavailable
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct HermesSetupCapabilities: Codable, Hashable, Sendable, Equatable {
    public var roster: Bool
    public var canonicalChat: Bool
    public var send: Bool
    public var finalResponse: Bool
    public var events: Bool
    public var stop: Bool
    public var routinesRead: Bool
    public var messageAgent: Bool
    public var groups: Bool
    public var crossMachine: Bool
    public var queueing: Bool
    public var steer: Bool
    public var attachments: Bool

    public init(
        roster: Bool = false,
        canonicalChat: Bool = false,
        send: Bool = false,
        finalResponse: Bool = false,
        events: Bool = false,
        stop: Bool = false,
        routinesRead: Bool = false,
        messageAgent: Bool = false,
        groups: Bool = false,
        crossMachine: Bool = false,
        queueing: Bool = false,
        steer: Bool = false,
        attachments: Bool = false
    ) {
        self.roster = roster
        self.canonicalChat = canonicalChat
        self.send = send
        self.finalResponse = finalResponse
        self.events = events
        self.stop = stop
        self.routinesRead = routinesRead
        self.messageAgent = messageAgent
        self.groups = groups
        self.crossMachine = crossMachine
        self.queueing = queueing
        self.steer = steer
        self.attachments = attachments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            roster: try container.decodeIfPresent(Bool.self, forKey: .roster) ?? false,
            canonicalChat: try container.decodeIfPresent(Bool.self, forKey: .canonicalChat) ?? false,
            send: try container.decodeIfPresent(Bool.self, forKey: .send) ?? false,
            finalResponse: try container.decodeIfPresent(Bool.self, forKey: .finalResponse) ?? false,
            events: try container.decodeIfPresent(Bool.self, forKey: .events) ?? false,
            stop: try container.decodeIfPresent(Bool.self, forKey: .stop) ?? false,
            routinesRead: try container.decodeIfPresent(Bool.self, forKey: .routinesRead) ?? false,
            messageAgent: try container.decodeIfPresent(Bool.self, forKey: .messageAgent) ?? false,
            groups: try container.decodeIfPresent(Bool.self, forKey: .groups) ?? false,
            crossMachine: try container.decodeIfPresent(Bool.self, forKey: .crossMachine) ?? false,
            queueing: try container.decodeIfPresent(Bool.self, forKey: .queueing) ?? false,
            steer: try container.decodeIfPresent(Bool.self, forKey: .steer) ?? false,
            attachments: try container.decodeIfPresent(Bool.self, forKey: .attachments) ?? false
        )
    }
}

public struct HermesSetupProfile: Codable, Hashable, Identifiable, Sendable, Equatable {
    public var profile: String
    public var handle: String
    public var displayName: String
    public var description: String
    public var model: String?
    public var provider: String?
    public var canonicalChat: HermesCanonicalState
    public var availability: HermesProfileAvailability
    public var botId: String?

    public var id: String { profile }

    public init(
        profile: String,
        handle: String,
        displayName: String,
        description: String,
        model: String? = nil,
        provider: String? = nil,
        canonicalChat: HermesCanonicalState = .unknown,
        availability: HermesProfileAvailability = .unknown,
        botId: String? = nil
    ) {
        self.profile = profile
        self.handle = handle
        self.displayName = displayName
        self.description = description
        self.model = model
        self.provider = provider
        self.canonicalChat = canonicalChat
        self.availability = availability
        self.botId = botId
    }

    private enum CodingKeys: String, CodingKey {
        case profile, handle, displayName, description, model, provider, canonicalChat, availability, botId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            profile: try container.decodeIfPresent(String.self, forKey: .profile) ?? "",
            handle: try container.decodeIfPresent(String.self, forKey: .handle) ?? "",
            displayName: try container.decodeIfPresent(String.self, forKey: .displayName) ?? "",
            description: try container.decodeIfPresent(String.self, forKey: .description) ?? "",
            model: try container.decodeIfPresent(String.self, forKey: .model),
            provider: try container.decodeIfPresent(String.self, forKey: .provider),
            canonicalChat: try container.decodeIfPresent(HermesCanonicalState.self, forKey: .canonicalChat) ?? .unknown,
            availability: try container.decodeIfPresent(HermesProfileAvailability.self, forKey: .availability) ?? .unknown,
            botId: try container.decodeIfPresent(String.self, forKey: .botId)
        )
    }
}

public struct HermesSetupStatus: Codable, Hashable, Sendable, Equatable {
    public var state: HermesSetupState
    public var reason: HermesSetupReason?
    public var profiles: [HermesSetupProfile]
    public var capabilities: HermesSetupCapabilities

    public init(
        state: HermesSetupState = .ready,
        reason: HermesSetupReason? = nil,
        profiles: [HermesSetupProfile] = [],
        capabilities: HermesSetupCapabilities = HermesSetupCapabilities()
    ) {
        self.state = state
        self.reason = reason
        self.profiles = profiles
        self.capabilities = capabilities
    }

    private enum CodingKeys: String, CodingKey { case state, reason, profiles, capabilities }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            state: try container.decodeIfPresent(HermesSetupState.self, forKey: .state) ?? .unknown,
            reason: try container.decodeIfPresent(HermesSetupReason.self, forKey: .reason),
            profiles: try container.decodeIfPresent([HermesSetupProfile].self, forKey: .profiles) ?? [],
            capabilities: try container.decodeIfPresent(HermesSetupCapabilities.self, forKey: .capabilities) ?? HermesSetupCapabilities()
        )
    }
}

public struct HermesSetupConnectionResponse: Codable, Hashable, Sendable, Equatable {
    public var botId: String
    public var profile: HermesSetupProfile
    public var status: HermesSetupStatus
    public var created: Bool

    public init(botId: String, profile: HermesSetupProfile, status: HermesSetupStatus, created: Bool) {
        self.botId = botId
        self.profile = profile
        self.status = status
        self.created = created
    }
}

public enum HermesSetupProfileAction: String, Sendable, Equatable {
    case connect
    case openChat
}

public enum HermesSetupPresentationState: Equatable, Sendable {
    case checking
    case ready
    case connected
    case needsSetup
    case unavailable
}

public struct HermesSetupPresentation: Equatable, Sendable {
    public let state: HermesSetupPresentationState
    public let title: String
    public let message: String
    public let actionTitle: String?

    public init(
        state: HermesSetupPresentationState,
        title: String,
        message: String,
        actionTitle: String? = nil
    ) {
        self.state = state
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
    }
}

/// Maps the safe server projection to calm, actionable copy. This stays
/// outside SwiftUI so old clients and focused tests share the same language.
public enum HermesSetupPresentationPolicy {
    public static func presentation(
        status: HermesSetupStatus?,
        isLoading: Bool
    ) -> HermesSetupPresentation {
        if isLoading || status == nil {
            return HermesSetupPresentation(
                state: .checking,
                title: "Checking Hermes",
                message: "Looking for Hermes on this computer…"
            )
        }

        guard let status else {
            return HermesSetupPresentation(
                state: .checking,
                title: "Checking Hermes",
                message: "Looking for Hermes on this computer…"
            )
        }
        switch status.state {
        case .disabled, .ready:
            return HermesSetupPresentation(
                state: .ready,
                title: "Connect Hermes",
                message: "Use Hermes profiles on this computer. For another machine, pair that V Bot first, then connect Hermes there.",
                actionTitle: "Connect Hermes"
            )
        case .connected:
            return HermesSetupPresentation(
                state: .connected,
                title: "Hermes connected",
                message: status.profiles.isEmpty ? "No connected profiles yet." : "Connected profiles"
            )
        case .unavailable, .unknown:
            switch status.reason {
            case .missingCLI:
                return HermesSetupPresentation(
                    state: .needsSetup,
                    title: "Set up Hermes",
                    message: "Install Hermes on this computer, then try again.",
                    actionTitle: "Try again"
                )
            case .invalidCredentials:
                return HermesSetupPresentation(
                    state: .needsSetup,
                    title: "Sign in to Hermes",
                    message: "Sign in to Hermes on this computer, then try again.",
                    actionTitle: "Try again"
                )
            default:
                return HermesSetupPresentation(
                    state: .unavailable,
                    title: "Hermes unavailable",
                    message: "Hermes couldn’t be reached on this computer. Try again later.",
                    actionTitle: "Try again"
                )
            }
        }
    }

    public static func availableProfiles(_ status: HermesSetupStatus) -> [HermesSetupProfile] {
        status.profiles.filter {
            $0.availability == .available && !$0.profile.isEmpty
        }
    }

    public static func requiresProfileChoice(_ status: HermesSetupStatus) -> Bool {
        availableProfiles(status).count > 1
    }

    public static func shouldShowProfileList(_ status: HermesSetupStatus) -> Bool {
        requiresProfileChoice(status)
    }

    public static func profileAction(_ profile: HermesSetupProfile) -> HermesSetupProfileAction {
        guard let botId = profile.botId, !botId.isEmpty else { return .connect }
        return .openChat
    }

    public static func defaultProfile(_ status: HermesSetupStatus) -> HermesSetupProfile? {
        let profiles = availableProfiles(status)
        if let preferred = profiles.first(where: {
            $0.handle.caseInsensitiveCompare("hermes") == .orderedSame ||
                $0.profile.caseInsensitiveCompare("default") == .orderedSame
        }) {
            return preferred
        }
        return profiles.count == 1 ? profiles[0] : nil
    }
}
