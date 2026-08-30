import Foundation

/// Compile-time scaffold for a future APNs relay. Intentionally inert until
/// production entitlements and a relay URL exist — see `docs/ios-push-apns.md`.
public enum PushRegistrationScaffold: Sendable {
    public static var isRelayConfigured: Bool { false }

    public static func registerIfOptedIn() async {
        // no-op until relay URL + `aps-environment` entitlement ship
    }

    public static func revokeToken() async {
        // no-op until relay registration exists
    }
}
