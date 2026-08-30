import Foundation

/// Phone-side Box / cloud-desktop viewer rules. The join URL is a short-lived
/// credential: validate it, show only a sanitized origin, and never persist it.
public enum CloudViewerPolicy: Sendable {
    public static let externalSemantics =
        "Opens an external cloud desktop in a secure browser. This phone does not keep the viewer address."
    public static let interactiveUnavailable =
        "Interactive control isn't available on this phone."
    public static let vpsWatchCopy =
        "Cloud runs on your VPS. Interactive control isn't available on this phone. Send a message to start a turn, then watch the desktop here."
    public static let vpsBusyWatchCopy =
        "Watch the desktop here while the agent works. Interactive control isn't available on this phone."
    public static let boxReadyTitle = "Cloud desktop ready"
    public static let boxReadyCopy =
        "Live preview appears while the agent works. Open the secure cloud desktop to control it in the in-app browser."
    public static let openDesktopTitle = "Open cloud desktop"
    public static let confirmTitle = "Open live cloud desktop?"
    public static let invalidAddressMessage =
        "The cloud desktop address wasn't valid. Try again from ···."
    public static let originUnavailable = "Cloud desktop"
    public static let originAccessibilityPrefix = "External cloud desktop,"

    /// Join URLs are memory-only. Nothing in this set is ever written to disk.
    public static let persistableViewerKeys: Set<String> = []

    /// HTTPS, public DNS host, no userinfo. Query and fragment may exist on
    /// the minted URL and are stripped from the visible origin.
    public static func validatedJoinURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 2_048,
              let url = URL(string: trimmed)
        else { return nil }
        return validatedJoinURL(url)
    }

    public static func validatedJoinURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              !isForbiddenViewerHost(host)
        else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        components.scheme = "https"
        components.host = host.lowercased()
        guard let normalized = components.url else { return nil }
        return normalized
    }

    public static func sanitizedOrigin(for url: URL) -> String? {
        guard let valid = validatedJoinURL(url),
              var components = URLComponents(url: valid, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty
        else { return nil }
        components.user = nil
        components.password = nil
        components.path = ""
        components.query = nil
        components.fragment = nil
        if components.port == 443 { components.port = nil }
        return components.string
    }

    public static func originAccessibilityLabel(for url: URL) -> String {
        let origin = sanitizedOrigin(for: url) ?? originUnavailable
        return "\(originAccessibilityPrefix) \(origin)"
    }

    public static func isForbiddenViewerHost(_ host: String) -> Bool {
        var canonical = host.lowercased()
        if canonical.hasPrefix("[") && canonical.hasSuffix("]") {
            canonical = String(canonical.dropFirst().dropLast())
        }
        while canonical.hasSuffix(".") { canonical.removeLast() }
        if canonical.isEmpty { return true }
        if canonical == "localhost" || canonical == "localhost.localdomain" { return true }
        if canonical.hasSuffix(".localhost") || canonical.hasSuffix(".local") { return true }
        if canonical.contains(":") { return true }
        if isIPv4(canonical) { return true }
        if !canonical.contains(".") { return true }
        return false
    }

    private static func isIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard part.count <= 3, part.allSatisfy(\.isNumber), let value = Int(part) else {
                return false
            }
            return (0...255).contains(value)
        }
    }
}
