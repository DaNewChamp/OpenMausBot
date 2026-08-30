import Foundation

/// Pure reconnect, banner, and endpoint-refresh rules. Session owns sockets
/// and Tasks; this keeps generations, hosted no-downgrade, and status copy
/// deterministic without a network or a clock.
public enum ConnectionResiliencePolicy: Sendable {
    public static let connectingCopy = "Connecting…"
    public static let reconnectingCopy = "Reconnecting…"
    public static let unauthorizedCopy = "This phone was unpaired on the computer."
    public static let reconnectingAccessibility = "Reconnecting to your computer"
    public static let connectingAccessibility = "Connecting to your computer"

    public enum BannerKind: Equatable, Sendable {
        case hidden
        case connecting
        case reconnecting
        case offline
        case unauthorized
    }

    public struct Banner: Equatable, Sendable {
        public var kind: BannerKind
        public var text: String
        public var systemImage: String
        public var accessibilityLabel: String

        public var isVisible: Bool { kind != .hidden }
    }

    /// What the roster and settings should show for a stream phase.
    public static func banner(
        unpaired: Bool = false,
        unauthorized: Bool = false,
        live: Bool = false,
        previouslyLive: Bool,
        connecting: Bool = false,
        offlineReason: String? = nil
    ) -> Banner {
        if unpaired || live {
            return Banner(
                kind: .hidden,
                text: "",
                systemImage: "",
                accessibilityLabel: ""
            )
        }
        if unauthorized {
            return Banner(
                kind: .unauthorized,
                text: unauthorizedCopy,
                systemImage: "lock.slash",
                accessibilityLabel: unauthorizedCopy
            )
        }
        if connecting {
            if previouslyLive {
                return Banner(
                    kind: .reconnecting,
                    text: reconnectingCopy,
                    systemImage: "arrow.triangle.2.circlepath",
                    accessibilityLabel: reconnectingAccessibility
                )
            }
            return Banner(
                kind: .connecting,
                text: connectingCopy,
                systemImage: "arrow.triangle.2.circlepath",
                accessibilityLabel: connectingAccessibility
            )
        }
        if let offlineReason {
            let text = sanitizedAdvice(offlineReason)
            return Banner(
                kind: .offline,
                text: text,
                systemImage: "wifi.slash",
                accessibilityLabel: text
            )
        }
        return Banner(
            kind: .hidden,
            text: "",
            systemImage: "",
            accessibilityLabel: ""
        )
    }

    /// Stale stream or endpoint-refresh work must not mutate live state.
    public static func shouldApply(startedGeneration: Int, currentGeneration: Int) -> Bool {
        EngineSyncPolicy.shouldApply(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
    }

    public static func nextGeneration(after current: Int) -> Int {
        EngineSyncPolicy.nextGeneration(after: current)
    }

    /// Foreground / pull-to-refresh should cut backoff sleep so Wi-Fi coming
    /// back does not sit on a 15s timer until the person force-quits.
    public static func shouldNudgeReconnect(
        streamRunning: Bool,
        inBackoff: Bool,
        isLive: Bool,
        isUnauthorized: Bool,
        isUnpaired: Bool
    ) -> Bool {
        streamRunning && inBackoff && !isLive && !isUnauthorized && !isUnpaired
    }

    /// Retryable address and gateway failures stay on the reconnecting banner
    /// instead of flashing a hard offline state between attempts.
    public static func keepsRetryVisible(after error: Error) -> Bool {
        if error is CancellationError { return false }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .cancelled:
                return false
            default:
                return true
            }
        }
        return ConnectionAdvice.shouldTryAnotherRoute(after: error)
    }

    /// Last screenshot remains useful while the stream retries. Pairing loss
    /// is the case that must not keep showing a computer that is gone.
    public static func shouldPreserveCachedScreen(
        unpaired: Bool,
        unauthorized: Bool
    ) -> Bool {
        !unpaired && !unauthorized
    }

    /// Rebuild the live walk after an authenticated refresh. The currently
    /// working route stays first when it is still in policy; a cleartext
    /// route that policy already dropped cannot sneak back in front of HTTPS.
    public static func liveRotation(
        working: CompanionEndpoint?,
        ordered: [CompanionEndpoint]
    ) -> [CompanionEndpoint] {
        let combined: [CompanionEndpoint]
        if let working, ordered.contains(where: { $0.url == working.url }) {
            combined = [working] + ordered.filter { $0.url != working.url }
        } else {
            combined = ordered
        }
        return CompanionEndpoint.automaticCandidates(from: combined)
    }

    public static func shouldApplyEndpointRefresh(
        startedGeneration: Int,
        currentGeneration: Int,
        connectionID: String,
        currentConnectionID: String?,
        sourceBaseURL: String?,
        currentBaseURL: String?
    ) -> Bool {
        shouldApply(startedGeneration: startedGeneration, currentGeneration: currentGeneration)
            && currentConnectionID == connectionID
            && sourceBaseURL != nil
            && sourceBaseURL == currentBaseURL
    }

    /// Host-only label for banners and logs. No scheme, path, query, or token.
    public static func sanitizedRouteLabel(_ endpoint: CompanionEndpoint) -> String {
        let host = endpoint.host.trimmingCharacters(in: .whitespacesAndNewlines)
        return host.isEmpty ? "your computer" : host
    }

    public static func sanitizedRouteLabel(host: String) -> String {
        var value = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if let schemeRange = value.range(of: "://") {
            value = String(value[schemeRange.upperBound...])
        }
        if let pathIndex = value.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
            value = String(value[..<pathIndex])
        }
        if let at = value.lastIndex(of: "@") {
            value = String(value[value.index(after: at)...])
        }
        if value.hasPrefix("["), let end = value.firstIndex(of: "]") {
            value = String(value[value.index(after: value.startIndex)..<end])
        } else if let colon = value.firstIndex(of: ":"), value.contains(".") {
            value = String(value[..<colon])
        }
        value = value.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return value.isEmpty ? "your computer" : value
    }

    public static func sanitizedAdvice(_ message: String) -> String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Log-only stream failure summary. Type plus URLError/HTTP code; never
    /// hosts, query strings, tokens, or `localizedDescription`.
    public static func safeFailureLog(_ error: Error) -> String {
        if error is CancellationError {
            return "CancellationError"
        }
        if let urlError = error as? URLError {
            return "URLError code=\(urlError.code.rawValue)"
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "URLError code=\(nsError.code)"
        }
        if let api = error as? APIError {
            switch api {
            case let .status(code, _):
                return "APIError status=\(code)"
            case .transport:
                return "APIError transport"
            case .badURL:
                return "APIError badURL"
            }
        }
        return String(describing: type(of: error))
    }
}
