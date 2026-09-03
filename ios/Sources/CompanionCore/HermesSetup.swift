import Foundation

/// The safe, display-only state returned by the companion Hermes setup
/// routes. Provider credentials, paths, session ids, and diagnostics never
/// cross this boundary.
public enum HermesSetupPlacementKind: String, Codable, Sendable, Equatable {
    case local
    case bridge
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct HermesSetupPlacement: Codable, Hashable, Sendable, Equatable {
    public var kind: HermesSetupPlacementKind
    public var profile: String
    public var bridge: String?
    public var bridgeId: String?

    public init(
        kind: HermesSetupPlacementKind = .local,
        profile: String = "",
        bridge: String? = nil,
        bridgeId: String? = nil
    ) {
        self.kind = kind
        self.profile = profile
        self.bridge = bridge
        self.bridgeId = bridgeId
    }

    private enum CodingKeys: String, CodingKey { case kind, profile, bridge, bridgeId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kind: try container.decodeIfPresent(HermesSetupPlacementKind.self, forKey: .kind) ?? .unknown,
            profile: try container.decodeIfPresent(String.self, forKey: .profile) ?? "",
            bridge: try container.decodeIfPresent(String.self, forKey: .bridge),
            bridgeId: try container.decodeIfPresent(String.self, forKey: .bridgeId)
        )
    }
}

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

public enum HermesEndpointAuthStatus: String, Codable, Sendable, Equatable {
    case connected
    case signInRequired
    case offline
    case unavailable
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct HermesEndpointIdentity: Codable, Hashable, Sendable, Equatable {
    public var id: String
    public var kind: HermesSetupPlacementKind
    public var profile: String
    public var computerName: String
    public var label: String

    public init(
        id: String = "",
        kind: HermesSetupPlacementKind = .unknown,
        profile: String = "",
        computerName: String = "",
        label: String = ""
    ) {
        self.id = id
        self.kind = kind
        self.profile = profile
        self.computerName = computerName
        self.label = label
    }

    private enum CodingKeys: String, CodingKey { case id, kind, profile, computerName, label }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decodeIfPresent(String.self, forKey: .id) ?? "",
            kind: try container.decodeIfPresent(HermesSetupPlacementKind.self, forKey: .kind) ?? .unknown,
            profile: try container.decodeIfPresent(String.self, forKey: .profile) ?? "",
            computerName: try container.decodeIfPresent(String.self, forKey: .computerName) ?? "",
            label: try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        )
    }
}

public struct HermesSignInAvailability: Codable, Hashable, Sendable, Equatable {
    public var available: Bool

    public init(available: Bool = false) {
        self.available = available
    }
}

public struct HermesSignInHandoff: Codable, Hashable, Sendable, Equatable {
    public var kind: String
    public var computerName: String
    public var message: String

    public init(kind: String = "", computerName: String = "", message: String = "") {
        self.kind = kind
        self.computerName = computerName
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case kind, computerName, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kind: try container.decodeIfPresent(String.self, forKey: .kind) ?? "",
            computerName: try container.decodeIfPresent(String.self, forKey: .computerName) ?? "",
            message: try container.decodeIfPresent(String.self, forKey: .message) ?? ""
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
    public var placement: HermesSetupPlacement?
    public var botId: String?
    public var endpoint: HermesEndpointIdentity?
    public var authStatus: HermesEndpointAuthStatus?
    public var signIn: HermesSignInAvailability?

    public var id: String {
        if let endpointId = endpoint?.id, !endpointId.isEmpty { return endpointId }
        if let placement {
            switch placement.kind {
            case .local:
                return "local:\(placement.profile.isEmpty ? profile : placement.profile)"
            case .bridge:
                let bridge = placement.bridgeId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    ?? "unknown"
                return "bridge:\(bridge):\(placement.profile)"
            case .unknown:
                return "local:\(profile)"
            }
        }
        return "local:\(profile)"
    }

    public init(
        profile: String,
        handle: String,
        displayName: String,
        description: String,
        model: String? = nil,
        provider: String? = nil,
        canonicalChat: HermesCanonicalState = .unknown,
        availability: HermesProfileAvailability = .unknown,
        placement: HermesSetupPlacement? = nil,
        botId: String? = nil,
        endpoint: HermesEndpointIdentity? = nil,
        authStatus: HermesEndpointAuthStatus? = nil,
        signIn: HermesSignInAvailability? = nil
    ) {
        self.profile = profile
        self.handle = handle
        self.displayName = displayName
        self.description = description
        self.model = model
        self.provider = provider
        self.canonicalChat = canonicalChat
        self.availability = availability
        self.placement = placement
        self.botId = botId
        self.endpoint = endpoint
        self.authStatus = authStatus
        self.signIn = signIn
    }

    private enum CodingKeys: String, CodingKey {
        case profile, handle, displayName, description, model, provider, canonicalChat, availability, placement, botId, endpoint, authStatus, signIn
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
            placement: try container.decodeIfPresent(HermesSetupPlacement.self, forKey: .placement),
            botId: try container.decodeIfPresent(String.self, forKey: .botId),
            endpoint: try container.decodeIfPresent(HermesEndpointIdentity.self, forKey: .endpoint),
            authStatus: try container.decodeIfPresent(HermesEndpointAuthStatus.self, forKey: .authStatus),
            signIn: try container.decodeIfPresent(HermesSignInAvailability.self, forKey: .signIn)
        )
    }
}

public struct HermesSetupStatus: Codable, Hashable, Sendable, Equatable {
    public var state: HermesSetupState
    public var reason: HermesSetupReason?
    public var profiles: [HermesSetupProfile]
    public var capabilities: HermesSetupCapabilities
    public var nativeCapabilities: HermesNativeCapabilityManifest?

    public init(
        state: HermesSetupState = .ready,
        reason: HermesSetupReason? = nil,
        profiles: [HermesSetupProfile] = [],
        capabilities: HermesSetupCapabilities = HermesSetupCapabilities(),
        nativeCapabilities: HermesNativeCapabilityManifest? = nil
    ) {
        self.state = state
        self.reason = reason
        self.profiles = profiles
        self.capabilities = capabilities
        self.nativeCapabilities = nativeCapabilities
    }

    private enum CodingKeys: String, CodingKey { case state, reason, profiles, capabilities, nativeCapabilities }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            state: try container.decodeIfPresent(HermesSetupState.self, forKey: .state) ?? .unknown,
            reason: try container.decodeIfPresent(HermesSetupReason.self, forKey: .reason),
            profiles: try container.decodeIfPresent([HermesSetupProfile].self, forKey: .profiles) ?? [],
            capabilities: try container.decodeIfPresent(HermesSetupCapabilities.self, forKey: .capabilities) ?? HermesSetupCapabilities(),
            nativeCapabilities: try container.decodeIfPresent(HermesNativeCapabilityManifest.self, forKey: .nativeCapabilities)
        )
    }
}

#if DEBUG
public enum HermesSetupPreviewPolicy {
    public static func isEnabled(arguments: [String]) -> Bool {
        arguments.contains("-store-preview") && arguments.contains("-open-hermes-settings")
    }

    public static let status = HermesSetupStatus(
        state: .connected,
        profiles: [
            HermesSetupProfile(
                profile: "chief",
                handle: "chief",
                displayName: "Hermes Chief",
                description: "Primary Hermes chief of staff",
                model: "GPT-5.6",
                provider: "OpenAI",
                canonicalChat: .present,
                availability: .available,
                placement: HermesSetupPlacement(kind: .local, profile: "chief"),
                botId: "preview-chief"
            ),
            HermesSetupProfile(
                profile: "research",
                handle: "research",
                displayName: "Hermes Research",
                description: "Research profile on a connected computer",
                model: "Claude Opus",
                provider: "Claude",
                canonicalChat: .present,
                availability: .available,
                placement: HermesSetupPlacement(
                    kind: .bridge,
                    profile: "research",
                    bridge: "Mac mini M4",
                    bridgeId: "bridge-mac-mini"
                ),
                botId: "preview-scout"
            ),
        ],
        capabilities: HermesSetupCapabilities(
            roster: true,
            canonicalChat: true,
            send: true,
            finalResponse: true,
            events: true,
            stop: true,
            routinesRead: true,
            messageAgent: true,
            crossMachine: true
        )
    )
}
#endif

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
    case signIn
    case none
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
    public static let controlPlaneCopy =
        "V Bot is the control plane. Hermes is an optional runtime installed on a paired computer."
    public static let defaultForNewBotsTitle = "Default for new Hermes bots"
    public static let defaultForNewBotsDetail =
        "New Hermes bots use this computer and profile. Existing bots keep their current runtime until you change them one at a time."
    public static let persistDefaultOnGlobalSelection = true
    public static let globalDefaultSelectionConvertsExistingBots = false

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
                    actionTitle: "Sign in"
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

    public static func authStatusLabel(_ status: HermesEndpointAuthStatus?) -> String {
        switch status {
        case .connected:
            return "Connected"
        case .signInRequired:
            return "Sign-in required"
        case .offline:
            return "Offline"
        case .unavailable, .unknown, .none:
            return "Unavailable"
        }
    }

    public static func visibleProfiles(_ status: HermesSetupStatus) -> [HermesSetupProfile] {
        status.profiles.filter { !$0.profile.isEmpty }
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
        if profile.authStatus == .signInRequired || profile.signIn?.available == true {
            return .signIn
        }
        if let botId = profile.botId, !botId.isEmpty { return .openChat }
        if profile.availability == .available { return .connect }
        return .none
    }

    public static func endpointPickerProfiles(_ status: HermesSetupStatus) -> [HermesSetupProfile] {
        visibleProfiles(status)
    }

    public static func selectedEndpoint(for botId: String, in status: HermesSetupStatus) -> HermesSetupProfile? {
        status.profiles.first { $0.botId == botId }
    }

    public static func isHermesBoundBot(title: String, instanceId: String) -> Bool {
        if title == "Hermes Bot Chat" { return true }
        return instanceId.caseInsensitiveCompare("hermes") == .orderedSame
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

    public static func placementLabel(
        placement: HermesSetupPlacement,
        computerName: String? = nil
    ) -> String {
        switch placement.kind {
        case .local:
            let trimmed = computerName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? "This computer" : trimmed
        case .bridge:
            let bridge = placement.bridge?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return bridge.isEmpty ? "Remote computer" : bridge
        case .unknown:
            return "Unknown"
        }
    }

    public static func hasRemotePlacements(_ status: HermesSetupStatus) -> Bool {
        status.profiles.contains { $0.placement?.kind == .bridge }
    }

    public struct HermesSetupPlacementGroup: Equatable, Sendable {
        public let label: String
        public let profiles: [HermesSetupProfile]

        public init(label: String, profiles: [HermesSetupProfile]) {
            self.label = label
            self.profiles = profiles
        }
    }

    public static func profilesGroupedByPlacement(
        _ status: HermesSetupStatus,
        computerName: String? = nil
    ) -> [HermesSetupPlacementGroup] {
        let available = visibleProfiles(status)
        var local: [HermesSetupProfile] = []
        var bridgeGroups: [String: (label: String, profiles: [HermesSetupProfile])] = [:]
        for profile in available {
            let placement = profile.placement ?? HermesSetupPlacement(kind: .local, profile: profile.profile)
            switch placement.kind {
            case .local:
                local.append(profile)
            case .bridge:
                let key = placement.bridge?.lowercased() ?? ""
                let existing = bridgeGroups[key]
                bridgeGroups[key] = (
                    label: existing?.label ?? placementLabel(placement: placement),
                    profiles: (existing?.profiles ?? []) + [profile]
                )
            case .unknown:
                local.append(profile)
            }
        }
        var groups: [HermesSetupPlacementGroup] = []
        if !local.isEmpty {
            groups.append(HermesSetupPlacementGroup(
                label: placementLabel(
                    placement: HermesSetupPlacement(kind: .local, profile: ""),
                    computerName: computerName
                ),
                profiles: local
            ))
        }
        groups.append(contentsOf: bridgeGroups.values.sorted {
            $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
        }.map { HermesSetupPlacementGroup(label: $0.label, profiles: $0.profiles) })
        return groups
    }
}
