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
            alias: connection.alias
        )
    }

    public static func displayName(name: String, host: String) -> String {
        FleetPresentationPolicy.resolveHubDisplayName(name: name, host: host)
    }

    public static func fleetSummary(count: Int) -> String {
        switch max(0, count) {
        case 0: return "No computers paired"
        case 1: return "1 computer paired"
        default: return "\(count) computers paired"
        }
    }

    public static let hubSectionTitle = "This V Bot hub"
    public static let bridgeSectionTitle = "Execution bridges"
    public static let bridgeSectionFooter =
        "Bridges run jobs for this hub. They are separate from the phone pairing that connects you to the hub."
}
