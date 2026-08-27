import Foundation

/// User-visible product name for the iPhone companion. Bundle identifiers,
/// URL schemes, Bonjour service types, and pairing protocol tokens stay on
/// the existing technical identity.
public enum ProductIdentity: Sendable {
    public static let displayName = "V Bot"
    public static let desktopCompanionPairingPath =
        "\(displayName) → Settings → Companion → Set up a phone"
}
