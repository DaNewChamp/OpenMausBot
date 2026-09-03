import Foundation

/// Browser QR approval. Distinct from `openmausbot://pair`, which remains the
/// first-device desktop→phone credential handoff.
public struct WebPairingRequest: Equatable, Sendable, Identifiable {
    public var id: String { requestId }
    public static let linkVersion = 1
    public static let linkHost = "web-pair"

    public let version: Int
    public let hubOrigin: String
    public let hubId: String
    public let requestId: String
    public let challengeHash: String
    public let deviceName: String
    public let expiresAt: Int64

    public init(
        version: Int = WebPairingRequest.linkVersion,
        hubOrigin: String,
        hubId: String,
        requestId: String,
        challengeHash: String,
        deviceName: String,
        expiresAt: Int64
    ) {
        self.version = version
        self.hubOrigin = hubOrigin
        self.hubId = hubId
        self.requestId = requestId
        self.challengeHash = challengeHash
        self.deviceName = deviceName
        self.expiresAt = expiresAt
    }

    private static let forbiddenKeys: Set<String> = [
        "token", "code", "credential", "secret", "redeemsecret", "redeem", "pair",
    ]

    public static func parse(_ url: URL) -> WebPairingRequest? {
        guard url.scheme?.lowercased() == "openmausbot",
              url.host?.lowercased() == linkHost,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }

        var values: [String: String] = [:]
        // Read the raw percent-encoded query: form-style "+" means a space in
        // links produced by URLSearchParams, and URLComponents would keep it
        // literally. A real "+" always arrives as %2B, so this stays lossless.
        for item in components.percentEncodedQueryItems ?? [] {
            let name = item.name.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? item.name
            let encodedValue = item.value?.replacingOccurrences(of: "+", with: " ") ?? ""
            let value = encodedValue.removingPercentEncoding ?? encodedValue
            if forbiddenKeys.contains(name.lowercased()) { return nil }
            guard values[name] == nil else { return nil }
            values[name] = value
        }

        guard let versionText = values["v"], let version = Int(versionText), version == linkVersion,
              let hubOrigin = canonicalHubOrigin(values["hub"] ?? ""),
              let hubId = values["hid"], (1...256).contains(hubId.utf8.count),
              hubId.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e }),
              let requestId = values["rid"], isRequestId(requestId),
              let challengeHash = values["ch"], isChallengeHash(challengeHash),
              let expiresText = values["exp"], let expiresAt = Int64(expiresText), expiresAt > 0
        else { return nil }

        return WebPairingRequest(
            hubOrigin: hubOrigin,
            hubId: hubId,
            requestId: requestId,
            challengeHash: challengeHash,
            deviceName: sanitizeDeviceName(values["n"] ?? ""),
            expiresAt: expiresAt
        )
    }

    public static func sanitizeDeviceName(_ raw: String) -> String {
        let mapped = raw.map { character -> Character in
            if let ascii = character.asciiValue, ascii < 32 || ascii == 127 { return " " }
            return character
        }
        let collapsed = String(mapped)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if collapsed.isEmpty { return "Web browser" }
        return String(collapsed.prefix(60))
    }

    public static func canonicalHubOrigin(_ value: String) -> String? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.user == nil,
              url.password == nil,
              (url.path.isEmpty || url.path == "/"),
              url.query == nil,
              url.fragment == nil,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        guard var origin = components.string, !origin.isEmpty else { return nil }
        if origin.hasSuffix("/") { origin.removeLast() }
        return origin
    }

    static func isRequestId(_ value: String) -> Bool {
        let count = value.utf8.count
        guard (22...128).contains(count) else { return false }
        return value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    static func isChallengeHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

public enum OpenMausBotLink: Equatable, Sendable {
    case firstDevicePair(PairingInvite)
    case webPairing(WebPairingRequest)

    public static func parse(_ url: URL) -> OpenMausBotLink? {
        if let web = WebPairingRequest.parse(url) { return .webPairing(web) }
        if let invite = PairingInvite.parse(url) { return .firstDevicePair(invite) }
        return nil
    }
}

public enum WebPairingScanPolicy {
    public enum Outcome: Equatable, Sendable {
        case confirmWebPairing(WebPairingRequest)
        case beginFirstDevicePair(PairingInvite)
        case reject(String)
    }

    public static func shouldAutoApprove(_ request: WebPairingRequest) -> Bool {
        _ = request
        return false
    }

    public static func canApprove(_ request: WebPairingRequest, pairedOrigins: [String]) -> Bool {
        guard let expected = WebPairingRequest.canonicalHubOrigin(request.hubOrigin) else { return false }
        return pairedOrigins.contains { origin in
            let candidate = WebPairingRequest.canonicalHubOrigin(origin)
                ?? URL(string: origin).flatMap { WebPairingRequest.canonicalHubOrigin($0.originString) }
            guard let candidate else { return false }
            return candidate.caseInsensitiveCompare(expected) == .orderedSame
        }
    }

    public static func authorizedOrigins(for connection: Connection) -> [String] {
        var origins = [connection.pairingConsentOrigin]
        origins.append(contentsOf: connection.orderedEndpoints.map(\.url))
        if let base = connection.baseURL?.absoluteString { origins.append(base) }
        return origins
    }

    public static func confirmationTitle(deviceName: String) -> String {
        "Approve \(deviceName)?"
    }

    public static func confirmationMessage(deviceName: String, hubName: String) -> String {
        "\(deviceName) wants to pair with \(hubName). This iPhone must already be paired with that hub."
    }

    public static func outcome(
        for url: URL,
        isPaired: Bool,
        pairingRequested: Bool,
        pairedOrigins: [String]
    ) -> Outcome {
        switch OpenMausBotLink.parse(url) {
        case .webPairing(let request):
            guard isPaired else {
                return .reject("Scan this code from an already-paired iPhone to approve the browser.")
            }
            guard request.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else {
                return .reject("This code expired. Refresh the code on the web page and scan again.")
            }
            guard !shouldAutoApprove(request) else {
                return .reject("This browser cannot be approved automatically.")
            }
            guard canApprove(request, pairedOrigins: pairedOrigins) else {
                return .reject("This code is for a different hub than the one this iPhone is paired with.")
            }
            return .confirmWebPairing(request)
        case .firstDevicePair(let invite):
            if isPaired && !pairingRequested {
                return .reject("This phone is already paired. Unpair it in Settings before connecting it to another computer.")
            }
            return .beginFirstDevicePair(invite)
        case nil:
            return .reject("That pairing invitation is not valid. Start pairing again on your computer.")
        }
    }
}

public struct WebPairingApproveResponse: Codable, Equatable, Sendable {
    public let ok: Bool
}

private extension URL {
    var originString: String {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.string ?? absoluteString
    }
}
