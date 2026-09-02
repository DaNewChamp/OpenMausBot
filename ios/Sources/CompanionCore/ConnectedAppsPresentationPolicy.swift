import Foundation

/// Presentation-only ordering for the Connected Apps inventory. Account
/// discovery and authorization URLs stay in the client; this only decides
/// which configured-but-unconnected Google apps surface first.
public enum ConnectedAppsPresentationPolicy {
    public static let pinnedGoogleSlugs: [String] = [
        "gmail",
        "googlecalendar",
        "googledrive",
        "googlesheets",
        "googledocs",
    ]

    public static func orderedCards(
        catalog: ConnectorCatalog,
        statuses: [String: ConnectorStatus],
        query: String
    ) -> [ConnectorCard] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = trimmed.isEmpty
            ? catalog.cards
            : catalog.cards.filter {
                $0.label.localizedCaseInsensitiveContains(trimmed) ||
                    $0.slug.localizedCaseInsensitiveContains(trimmed)
            }
        guard catalog.configured, trimmed.isEmpty else { return filtered }

        let pinned = filtered.filter { shouldPin($0, statuses: statuses) }
        guard !pinned.isEmpty else { return filtered }

        let pinnedIDs = Set(pinned.map(\.id))
        let pinnedOrder = pinned.sorted { lhs, rhs in
            let left = pinnedGoogleSlugs.firstIndex(of: lhs.slug) ?? Int.max
            let right = pinnedGoogleSlugs.firstIndex(of: rhs.slug) ?? Int.max
            if left != right { return left < right }
            return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
        }
        let remainder = filtered.filter { !pinnedIDs.contains($0.id) }
        return pinnedOrder + remainder
    }

    public static func shouldPin(_ card: ConnectorCard, statuses: [String: ConnectorStatus]) -> Bool {
        guard isPinnedGoogleSlug(card.slug) else { return false }
        return !isConnected(statuses[card.slug])
    }

    public static func isPinnedGoogleSlug(_ slug: String) -> Bool {
        pinnedGoogleSlugs.contains(slug)
    }

    public static func isConnected(_ status: ConnectorStatus?) -> Bool {
        guard let status else { return false }
        if status.connected { return true }
        return status.accounts?.contains(where: \.isActive) == true
    }
}
