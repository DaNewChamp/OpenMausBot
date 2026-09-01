import Foundation

public struct BridgeRosterEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let capabilities: [String]
    public let grantedCapabilities: [String]
    public let createdAt: Double
    public let lastSeenAt: Double
    public let hostInfo: String?
    public let online: Bool

    public init(
        id: String,
        name: String,
        capabilities: [String],
        grantedCapabilities: [String],
        createdAt: Double,
        lastSeenAt: Double,
        hostInfo: String?,
        online: Bool
    ) {
        self.id = id
        self.name = name
        self.capabilities = capabilities
        self.grantedCapabilities = grantedCapabilities
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.hostInfo = hostInfo
        self.online = online
    }
}

public struct BridgeRosterResponse: Codable, Equatable, Sendable {
    public let bridges: [BridgeRosterEntry]

    public init(bridges: [BridgeRosterEntry]) {
        self.bridges = bridges
    }
}

public enum BridgePresentationPolicy: Sendable {
    public static func onlineStatus(_ online: Bool) -> String {
        online ? "Online" : "Offline"
    }

    public static func capabilitySummary(_ capabilities: [String]) -> String {
        let labels = capabilities.map(capabilityLabel)
        guard !labels.isEmpty else { return "No capabilities" }
        return labels.joined(separator: ", ")
    }

    private static func capabilityLabel(_ raw: String) -> String {
        switch raw {
        case "shell": return "Shell"
        case "local-vm": return "Local VM"
        case "ssh-forward": return "SSH forward"
        default: return raw
        }
    }
}
