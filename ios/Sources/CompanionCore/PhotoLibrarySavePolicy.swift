import Foundation

/// Add-only Photos save copy. The app target performs the Photos call;
/// this keeps denial/error strings and outcomes testable in CompanionCore.
public enum PhotoLibrarySavePolicy: Sendable {
    public static let addUsageDescription = "V Bot saves desktop screenshots to your photo library when you tap Save."
    public static let savedMessage = "Saved"
    public static let deniedMessage = "Photos access is off. Allow adding photos in Settings to save this screenshot."
    public static let failedMessage = "Couldn't save this screenshot. Try again."
    public static let settingsActionTitle = "Open Settings"

    public enum Authorization: Equatable, Sendable {
        case authorized
        case denied
        case restricted
        case undetermined
    }

    public enum Outcome: Equatable, Sendable {
        case saved
        case denied
        case failed
    }

    public static func outcome(authorization: Authorization, saved: Bool) -> Outcome {
        switch authorization {
        case .denied, .restricted: return .denied
        case .undetermined: return .failed
        case .authorized: return saved ? .saved : .failed
        }
    }

    public static func message(for outcome: Outcome) -> String {
        switch outcome {
        case .saved: return savedMessage
        case .denied: return deniedMessage
        case .failed: return failedMessage
        }
    }

    public static func offersSettingsLink(for outcome: Outcome) -> Bool {
        outcome == .denied
    }
}
