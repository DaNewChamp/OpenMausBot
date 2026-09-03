import Foundation

public enum HermesCapabilityAvailability: String, Codable, Sendable, Equatable {
    case available
    case unavailable
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct HermesNativeCapabilityManifest: Codable, Hashable, Sendable, Equatable {
    public var memory: HermesCapabilityAvailability
    public var learning: HermesCapabilityAvailability
    public var skills: HermesCapabilityAvailability
    public var moa: HermesCapabilityAvailability
    public var routines: HermesCapabilityAvailability
    public var approvals: HermesCapabilityAvailability
    public var groups: HermesCapabilityAvailability
    public var messaging: HermesCapabilityAvailability
    public var events: HermesCapabilityAvailability
    public var finalResponse: HermesCapabilityAvailability
    public var queueing: HermesCapabilityAvailability
    public var steering: HermesCapabilityAvailability
    public var attachments: HermesCapabilityAvailability
    public var computerTools: HermesCapabilityAvailability

    public init(
        memory: HermesCapabilityAvailability = .unavailable,
        learning: HermesCapabilityAvailability = .unavailable,
        skills: HermesCapabilityAvailability = .unavailable,
        moa: HermesCapabilityAvailability = .unavailable,
        routines: HermesCapabilityAvailability = .unavailable,
        approvals: HermesCapabilityAvailability = .unavailable,
        groups: HermesCapabilityAvailability = .unavailable,
        messaging: HermesCapabilityAvailability = .unavailable,
        events: HermesCapabilityAvailability = .unavailable,
        finalResponse: HermesCapabilityAvailability = .unavailable,
        queueing: HermesCapabilityAvailability = .unavailable,
        steering: HermesCapabilityAvailability = .unavailable,
        attachments: HermesCapabilityAvailability = .unavailable,
        computerTools: HermesCapabilityAvailability = .unavailable
    ) {
        self.memory = memory
        self.learning = learning
        self.skills = skills
        self.moa = moa
        self.routines = routines
        self.approvals = approvals
        self.groups = groups
        self.messaging = messaging
        self.events = events
        self.finalResponse = finalResponse
        self.queueing = queueing
        self.steering = steering
        self.attachments = attachments
        self.computerTools = computerTools
    }

    public func availability(for key: String) -> HermesCapabilityAvailability {
        switch key {
        case "memory": return memory
        case "learning": return learning
        case "skills": return skills
        case "moa": return moa
        case "routines": return routines
        case "approvals": return approvals
        case "groups": return groups
        case "messaging": return messaging
        case "events": return events
        case "finalResponse": return finalResponse
        case "queueing": return queueing
        case "steering": return steering
        case "attachments": return attachments
        case "computerTools": return computerTools
        default: return .unavailable
        }
    }
}

public struct HermesEndpointOption: Hashable, Identifiable, Sendable, Equatable {
    public var id: String
    public var computerName: String
    public var profile: String

    public init(id: String, computerName: String, profile: String) {
        self.id = id
        self.computerName = computerName
        self.profile = profile
    }

    public var label: String {
        HermesRuntimePresentationPolicy.endpointLabel(computerName: computerName, profile: profile)
    }
}

public struct HermesRuntimePickerRow: Hashable, Sendable, Equatable {
    public var id: String
    public var label: String
}

public struct HermesSubagentActivity: Hashable, Identifiable, Sendable, Equatable, Codable {
    public enum Status: String, Codable, Sendable, Equatable {
        case started
        case updated
        case completed
        case promoted
        case unknown

        public init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: value) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var activityId: String
    public var parentThreadId: String
    public var title: String
    public var status: Status
    public var transcriptThreadId: String
    public var promoteEligible: Bool
    public var updatedAt: Double?

    public var id: String { activityId }

    private enum CodingKeys: String, CodingKey {
        case activityId, parentThreadId, title, status, transcriptThreadId, promoteEligible, updatedAt
    }

    public init(
        activityId: String,
        parentThreadId: String,
        title: String,
        status: Status,
        transcriptThreadId: String,
        promoteEligible: Bool,
        updatedAt: Double? = nil
    ) {
        self.activityId = activityId
        self.parentThreadId = parentThreadId
        self.title = title
        self.status = status
        self.transcriptThreadId = transcriptThreadId
        self.promoteEligible = promoteEligible
        self.updatedAt = updatedAt
    }

    public func placeholderBot() -> Bot {
        Bot(
            id: "hermes-temp-\(activityId)",
            threadId: transcriptThreadId,
            name: title,
            title: "",
            description: "",
            notifications: false,
            color: "green",
            unread: false,
            modelSelection: ModelSelection(instanceId: "hermes", model: ""),
            createdAt: 0
        )
    }
}

public struct HermesBotProvenance: Codable, Hashable, Sendable, Equatable {
    public var hermesAgentId: String
    public var kind: String
    public var parentBotId: String?
    public var sourceActivityId: String?

    public init(
        hermesAgentId: String,
        kind: String,
        parentBotId: String? = nil,
        sourceActivityId: String? = nil
    ) {
        self.hermesAgentId = hermesAgentId
        self.kind = kind
        self.parentBotId = parentBotId
        self.sourceActivityId = sourceActivityId
    }
}

public struct BotRuntimeBinding: Hashable, Sendable, Equatable {
    public var kind: String
    public var instanceId: String?
    public var model: String?
    public var profile: String?
    public var bridgeId: String?
    public var placementKind: String?

    public init(
        kind: String,
        instanceId: String? = nil,
        model: String? = nil,
        profile: String? = nil,
        bridgeId: String? = nil,
        placementKind: String? = nil
    ) {
        self.kind = kind
        self.instanceId = instanceId
        self.model = model
        self.profile = profile
        self.bridgeId = bridgeId
        self.placementKind = placementKind
    }

    private enum CodingKeys: String, CodingKey {
        case kind, instanceId, model, placement, bindingVersion, profile, bridgeId, placementKind
    }
    private enum PlacementKeys: String, CodingKey { case kind, profile, bridgeId }
}

extension BotRuntimeBinding: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? ""
        if container.contains(.placement),
           let placement = try? container.nestedContainer(keyedBy: PlacementKeys.self, forKey: .placement) {
            self.init(
                kind: kind,
                instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
                model: try container.decodeIfPresent(String.self, forKey: .model),
                profile: try placement.decodeIfPresent(String.self, forKey: .profile),
                bridgeId: try placement.decodeIfPresent(String.self, forKey: .bridgeId),
                placementKind: try placement.decodeIfPresent(String.self, forKey: .kind)
            )
            return
        }
        self.init(
            kind: kind,
            instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
            model: try container.decodeIfPresent(String.self, forKey: .model),
            profile: try container.decodeIfPresent(String.self, forKey: .profile),
            bridgeId: try container.decodeIfPresent(String.self, forKey: .bridgeId),
            placementKind: try container.decodeIfPresent(String.self, forKey: .placementKind)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(instanceId, forKey: .instanceId)
        try container.encodeIfPresent(model, forKey: .model)
        if kind == "hermes" {
            var placement = container.nestedContainer(keyedBy: PlacementKeys.self, forKey: .placement)
            try placement.encode(placementKind ?? "local", forKey: .kind)
            try placement.encodeIfPresent(profile, forKey: .profile)
            try placement.encodeIfPresent(bridgeId, forKey: .bridgeId)
            try container.encode(2, forKey: .bindingVersion)
        } else {
            try container.encodeIfPresent(profile, forKey: .profile)
            try container.encodeIfPresent(bridgeId, forKey: .bridgeId)
            try container.encodeIfPresent(placementKind, forKey: .placementKind)
        }
    }
}

public enum HermesConversionApplyPolicy: Sendable {
    public static func request(from endpoint: HermesEndpointOption) -> HermesRuntimeRebindRequest {
        let parts = endpoint.id.split(separator: ":").map(String.init)
        if parts.first == "bridge", parts.count == 3,
           parts[1].range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil {
            return HermesRuntimeRebindRequest(
                kind: "bridge",
                profile: endpoint.profile,
                bridgeId: parts[1]
            )
        }
        if parts.first == "bridge" {
            return HermesRuntimeRebindRequest(
                kind: "bridge",
                profile: endpoint.profile
            )
        }
        return HermesRuntimeRebindRequest(
            kind: "local",
            profile: endpoint.profile
        )
    }
}

public enum HermesConversionSheetPolicy: Sendable {
    /// The conversion sheet only opens when a connected profile already owns a
    /// bot id. Picking a default runtime must not mint a new bot.
    public static func pendingConversion(
        selected: HermesEndpointOption,
        connectedProfiles: [HermesSetupProfile]
    ) -> HermesEndpointOption? {
        connectedProfiles.contains { profile in
            let id = profile.botId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !id.isEmpty
        } ? selected : nil
    }

    public static func applyRequests(
        endpoint: HermesEndpointOption,
        botIds: [String]
    ) -> [(botId: String, request: HermesRuntimeRebindRequest)] {
        let request = HermesConversionApplyPolicy.request(from: endpoint)
        return botIds
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { ($0, request) }
    }
}

public struct HermesRuntimeRebindRequest: Encodable, Hashable, Sendable, Equatable {
    public var kind: String
    public var instanceId: String?
    public var model: String?
    public var profile: String?
    public var bridgeId: String?
    public var contextMode: String
    public var userRequested: Bool

    public init(
        kind: String,
        instanceId: String? = nil,
        model: String? = nil,
        profile: String? = nil,
        bridgeId: String? = nil,
        contextMode: String = "none",
        userRequested: Bool = true
    ) {
        self.kind = kind
        self.instanceId = instanceId
        self.model = model
        self.profile = profile
        self.bridgeId = bridgeId
        self.contextMode = contextMode
        self.userRequested = userRequested
    }

    private enum CodingKeys: String, CodingKey { case binding, contextMode, userRequested }
    private enum BindingKeys: String, CodingKey { case kind, instanceId, model, placement, bindingVersion }
    private enum PlacementKeys: String, CodingKey { case kind, profile, bridgeId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(contextMode, forKey: .contextMode)
        try container.encode(userRequested, forKey: .userRequested)
        var binding = container.nestedContainer(keyedBy: BindingKeys.self, forKey: .binding)
        if kind == "provider" {
            try binding.encode("provider", forKey: .kind)
            try binding.encode(instanceId ?? "", forKey: .instanceId)
            try binding.encodeIfPresent(model, forKey: .model)
        } else {
            try binding.encode("hermes", forKey: .kind)
            try binding.encode(2, forKey: .bindingVersion)
            var placement = binding.nestedContainer(keyedBy: PlacementKeys.self, forKey: .placement)
            if kind == "bridge" {
                try placement.encode("bridge", forKey: .kind)
                try placement.encode(bridgeId ?? "", forKey: .bridgeId)
                try placement.encode(profile ?? "", forKey: .profile)
            } else {
                try placement.encode("local", forKey: .kind)
                try placement.encode(profile ?? "", forKey: .profile)
            }
        }
    }
}

public enum HermesRuntimePresentationPolicy: Sendable {
    public static let persistsAsynchronouslyBeforeBack = true

    public static func endpointLabel(computerName: String, profile: String) -> String {
        let computer = computerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        if computer.isEmpty { return slug.isEmpty ? "Hermes" : slug }
        if slug.isEmpty { return computer }
        return "\(computer) / \(slug)"
    }

    public static func isEnabled(_ key: String, in manifest: HermesNativeCapabilityManifest) -> Bool {
        manifest.availability(for: key) == .available
    }

    public static func availabilityLabel(for key: String, in manifest: HermesNativeCapabilityManifest) -> String {
        isEnabled(key, in: manifest) ? "Available" : "Unavailable"
    }

    public static func conversionSummary(botName: String, sourceLabel: String, destinationLabel: String) -> String {
        "Convert \(botName) from \(sourceLabel) to \(destinationLabel). Name, rooms, and history stay."
    }

    public static func pickerRows(_ endpoints: [HermesEndpointOption]) -> [HermesRuntimePickerRow] {
        endpoints.map { HermesRuntimePickerRow(id: $0.id, label: $0.label) }
    }
}

public enum HermesSubagentPresentationPolicy: Sendable {
    public static let promoteTitle = "Promote to Bot"
    public static let recentlyFinishedRetention: TimeInterval = 60

    public static func navigationThreadId(for activity: HermesSubagentActivity) -> String {
        activity.transcriptThreadId
    }

    public static func showsPromote(for activity: HermesSubagentActivity) -> Bool {
        activity.promoteEligible && activity.status != .promoted
    }

    public static func showsInLivePill(
        _ activity: HermesSubagentActivity,
        now: Date = Date()
    ) -> Bool {
        switch activity.status {
        case .started, .updated:
            return true
        case .completed:
            guard let updatedAt = activity.updatedAt else { return false }
            return now.timeIntervalSince1970 - (updatedAt / 1000) <= recentlyFinishedRetention
        case .promoted, .unknown:
            return false
        }
    }

    public static func retainedInParentHistory(_ activity: HermesSubagentActivity) -> Bool {
        switch activity.status {
        case .started, .updated, .completed:
            return !activity.transcriptThreadId.isEmpty
        case .promoted, .unknown:
            return false
        }
    }

    public static func parentHistoryActivities(
        _ activities: [HermesSubagentActivity],
        parentThreadId: String
    ) -> [HermesSubagentActivity] {
        activities.filter {
            retainedInParentHistory($0)
                && ($0.parentThreadId == parentThreadId || $0.transcriptThreadId == parentThreadId)
        }
    }

    /// Compact parent-chat rows for completed temporary agents after the live
    /// pill has expired. Navigation still uses the retained transcript thread.
    public static func parentHistoryAnchors(
        _ activities: [HermesSubagentActivity],
        parentThreadId: String,
        now: Date = Date()
    ) -> [HermesParentHistoryAnchor] {
        parentHistoryActivities(activities, parentThreadId: parentThreadId)
            .filter { $0.status == .completed && !showsInLivePill($0, now: now) }
            .map { activity in
                HermesParentHistoryAnchor(
                    activityId: activity.activityId,
                    title: activity.title,
                    transcriptThreadId: navigationThreadId(for: activity),
                    accessibilityLabel: "\(activity.title), completed temporary agent",
                    accessibilityHint: "Opens the retained transcript"
                )
            }
    }
}

public struct HermesParentHistoryAnchor: Equatable, Identifiable, Sendable {
    public var id: String { activityId }
    public let activityId: String
    public let title: String
    public let transcriptThreadId: String
    public let accessibilityLabel: String
    public let accessibilityHint: String

    public init(
        activityId: String,
        title: String,
        transcriptThreadId: String,
        accessibilityLabel: String,
        accessibilityHint: String
    ) {
        self.activityId = activityId
        self.title = title
        self.transcriptThreadId = transcriptThreadId
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityHint = accessibilityHint
    }
}
