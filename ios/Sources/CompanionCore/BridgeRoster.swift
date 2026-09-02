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

public enum FleetPresentationPolicy: Sendable {
    private static let genericNames: Set<String> = [
        "computer", "desktop", "open maus", "open maus bot", "openmaus", "openmausbot", "v bot", "vbot", "bridge",
    ]

    public static func isGenericHubName(_ name: String) -> Bool {
        let normalized = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: " ")
        return normalized.isEmpty || genericNames.contains(normalized)
    }

    public static func friendlyNameFromHost(_ host: String) -> String {
        let address = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if address.contains(":")
            || address.range(of: #"^\d{1,3}(?:\.\d{1,3}){3}$"#, options: .regularExpression) != nil {
            return "Connected computer"
        }
        let hostName = address
            .split(separator: ".", maxSplits: 1)
            .first
            .map(String.init) ?? ""
        guard !hostName.isEmpty else { return "Connected computer" }

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

    public static func resolveHubDisplayName(
        name: String,
        host: String,
        alias: String? = nil,
        runtimeProfile: String? = nil
    ) -> String {
        if let alias = alias?.trimmingCharacters(in: .whitespacesAndNewlines), !alias.isEmpty {
            return String(alias.prefix(80))
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, !isGenericHubName(trimmed) { return trimmed }

        if runtimeProfile == "headless-hub", isAddressHost(host) {
            return "Headless V Bot hub"
        }
        if runtimeProfile == "desktop-client", isAddressHost(host) {
            return "V Bot client"
        }

        let fromHost = friendlyNameFromHost(host)
        if fromHost != "Connected computer" { return fromHost }
        if runtimeProfile == "headless-hub" { return "Headless V Bot hub" }
        return fromHost
    }

    private static func isAddressHost(_ host: String) -> Bool {
        let address = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return address.contains(":")
            || address.range(of: #"^\d{1,3}(?:\.\d{1,3}){3}$"#, options: .regularExpression) != nil
    }
}

public struct PresentedBridgeEntry: Equatable, Identifiable, Sendable {
    public enum RoleLabel: String, Equatable, Sendable {
        case connectedBridge = "Connected bridge"
        case previousRegistration = "Previous registration"
    }

    public let entry: BridgeRosterEntry
    public let displayName: String
    public let roleLabel: RoleLabel
    public let stale: Bool

    public var id: String { entry.id }
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

    public static func displayName(for entry: BridgeRosterEntry) -> String {
        let host = entry.hostInfo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if FleetPresentationPolicy.isGenericHubName(entry.name), !host.isEmpty {
            let fromHost = FleetPresentationPolicy.friendlyNameFromHost(host)
            if fromHost != "Connected computer" { return fromHost }
        }
        let trimmed = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, !host.isEmpty {
            return FleetPresentationPolicy.friendlyNameFromHost(host)
        }
        return trimmed.isEmpty ? "Connected bridge" : trimmed
    }

    public static func present(_ bridges: [BridgeRosterEntry]) -> [PresentedBridgeEntry] {
        var grouped: [String: [BridgeRosterEntry]] = [:]
        var groupedOrder: [String] = []
        var ungrouped: [BridgeRosterEntry] = []

        for entry in bridges {
            guard let identity = normalizedHostIdentity(entry.hostInfo) else {
                ungrouped.append(entry)
                continue
            }
            if grouped[identity] == nil {
                groupedOrder.append(identity)
                grouped[identity] = [entry]
            } else {
                grouped[identity]?.append(entry)
            }
        }

        var presented: [PresentedBridgeEntry] = []
        for entry in ungrouped {
            presented.append(
                PresentedBridgeEntry(
                    entry: entry,
                    displayName: displayName(for: entry),
                    roleLabel: PresentedBridgeEntry.RoleLabel.connectedBridge,
                    stale: false
                )
            )
        }

        for identity in groupedOrder {
            guard let group = grouped[identity] else { continue }
            if group.count == 1, let entry = group.first {
                presented.append(
                    PresentedBridgeEntry(
                        entry: entry,
                        displayName: displayName(for: entry),
                        roleLabel: PresentedBridgeEntry.RoleLabel.connectedBridge,
                        stale: false
                    )
                )
                continue
            }

            let canonicalIndex = pickCanonicalIndex(group)
            let ordered = group.enumerated().sorted { left, right in
                if left.offset == canonicalIndex { return true }
                if right.offset == canonicalIndex { return false }
                if left.element.online != right.element.online {
                    return left.element.online && !right.element.online
                }
                return left.element.lastSeenAt > right.element.lastSeenAt
            }

            for (index, entry) in ordered {
                let stale = index != canonicalIndex && !entry.online
                presented.append(
                    PresentedBridgeEntry(
                        entry: entry,
                        displayName: displayName(for: entry),
                        roleLabel: stale ? PresentedBridgeEntry.RoleLabel.previousRegistration : PresentedBridgeEntry.RoleLabel.connectedBridge,
                        stale: stale
                    )
                )
            }
        }

        return presented.sorted(by: { left, right in
            if left.stale != right.stale { return !left.stale }
            if left.entry.online != right.entry.online { return left.entry.online }
            return left.entry.lastSeenAt > right.entry.lastSeenAt
        })
    }

    private static func normalizedHostIdentity(_ hostInfo: String?) -> String? {
        let trimmed = hostInfo?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func pickCanonicalIndex(_ group: [BridgeRosterEntry]) -> Int {
        var best = 0
        for index in 1..<group.count {
            let candidate = group[index]
            let current = group[best]
            if candidate.online != current.online {
                if candidate.online { best = index }
                continue
            }
            if candidate.lastSeenAt != current.lastSeenAt {
                if candidate.lastSeenAt > current.lastSeenAt { best = index }
                continue
            }
            if candidate.createdAt > current.createdAt { best = index }
        }
        return best
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
