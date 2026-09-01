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
    private static let genericNames: Set<String> = [
        "computer", "desktop", "open maus", "open maus bot", "openmaus", "openmausbot", "v bot", "vbot"
    ]

    public static func displayName(for connection: Connection) -> String {
        if let alias = connection.alias?.trimmingCharacters(in: .whitespacesAndNewlines), !alias.isEmpty {
            return alias
        }
        return displayName(name: connection.name, host: connection.host)
    }

    public static func displayName(name: String, host: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased().replacingOccurrences(of: "-", with: " ")
        guard trimmed.isEmpty || genericNames.contains(normalized) else { return trimmed }

        let address = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if address.contains(":")
            || address.range(of: #"^\d{1,3}(?:\.\d{1,3}){3}$"#, options: .regularExpression) != nil {
            return "Connected computer"
        }
        let hostName = address
            .split(separator: ".", maxSplits: 1)
            .first
            .map(String.init) ?? ""
        guard !hostName.isEmpty else {
            return "Connected computer"
        }

        let words = hostName
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .map { word -> String in
                switch word.lowercased() {
                case "macmini": return "Mac mini"
                case "macbook": return "MacBook"
                case "mac": return "Mac"
                case "mini": return "mini"
                default: return word.prefix(1).uppercased() + word.dropFirst()
                }
            }
        return words.isEmpty ? "Connected computer" : words.joined(separator: " ")
    }

    public static func fleetSummary(count: Int) -> String {
        switch max(0, count) {
        case 0: return "No computers paired"
        case 1: return "1 computer paired"
        default: return "\(count) computers paired"
        }
    }
}
