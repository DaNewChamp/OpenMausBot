import Foundation

public enum AccountAvatarSymbol: String, CaseIterable, Identifiable, Sendable {
    case person = "person.fill"
    case crown = "crown.fill"
    case star = "star.fill"
    case bolt = "bolt.fill"
    case briefcase = "briefcase.fill"
    case heart = "heart.fill"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .person: return "Person"
        case .crown: return "Crown"
        case .star: return "Star"
        case .bolt: return "Bolt"
        case .briefcase: return "Briefcase"
        case .heart: return "Heart"
        }
    }

    public static func normalized(_ rawValue: String) -> String {
        Self(rawValue: rawValue)?.rawValue ?? Self.person.rawValue
    }
}

public enum ConnectionPresentationPolicy: Sendable {
    public static func displayName(for connection: Connection) -> String {
        FleetPresentationPolicy.resolveHubDisplayName(
            name: connection.name,
            host: connection.host,
            alias: connection.alias,
            runtimeProfile: connection.runtimeProfile
        )
    }

    public static func displayName(
        name: String,
        host: String,
        runtimeProfile: String? = nil
    ) -> String {
        FleetPresentationPolicy.resolveHubDisplayName(
            name: name,
            host: host,
            runtimeProfile: runtimeProfile
        )
    }

    public static func fleetSummary(count: Int) -> String {
        switch max(0, count) {
        case 0: return "No computers paired"
        case 1: return "1 computer paired"
        default: return "\(count) computers paired"
        }
    }

    public static func computerSummary(hubCount: Int, connectedComputerCount: Int) -> String {
        let safeHubs = max(0, hubCount)
        let safeComputers = max(0, connectedComputerCount)
        let hubPart = safeHubs == 1 ? "1 hub" : "\(safeHubs) hubs"
        let computerPart = safeComputers == 1 ? "1 connected computer" : "\(safeComputers) connected computers"
        return "\(hubPart) · \(computerPart)"
    }

    public static func computerSummary(hubCount: Int, bridges: [BridgeRosterEntry]) -> String {
        computerSummary(
            hubCount: hubCount,
            connectedComputerCount: BridgePresentationPolicy.connectedComputerCount(in: bridges)
        )
    }

    public static func computerSummary(hubCount: Int, presentedBridges: [PresentedBridgeEntry]) -> String {
        computerSummary(
            hubCount: hubCount,
            connectedComputerCount: BridgePresentationPolicy.connectedComputerCount(in: presentedBridges)
        )
    }

    public static let hubSectionTitle = "Hub"
    public static let bridgeSectionTitle = "Available computers"
    public static let availableComputersSectionTitle = "Available computers"
    public static let bridgeSectionFooter =
        "Computers connected to this hub run tasks for your bots. They are managed through the hub rather than paired directly with your phone."
    public static let availableComputersSectionFooter = bridgeSectionFooter
}


