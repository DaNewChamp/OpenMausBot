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

public struct HermesSubagentActivity: Hashable, Identifiable, Sendable, Equatable {
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
    }

    public var activityId: String
    public var parentThreadId: String
    public var title: String
    public var status: Status
    public var transcriptThreadId: String
    public var promoteEligible: Bool

    public var id: String { activityId }

    public init(
        activityId: String,
        parentThreadId: String,
        title: String,
        status: Status,
        transcriptThreadId: String,
        promoteEligible: Bool
    ) {
        self.activityId = activityId
        self.parentThreadId = parentThreadId
        self.title = title
        self.status = status
        self.transcriptThreadId = transcriptThreadId
        self.promoteEligible = promoteEligible
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

    public static func navigationThreadId(for activity: HermesSubagentActivity) -> String {
        activity.transcriptThreadId
    }

    public static func showsPromote(for activity: HermesSubagentActivity) -> Bool {
        activity.promoteEligible && activity.status != .promoted
    }
}
