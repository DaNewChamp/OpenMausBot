import Foundation

/// The bounded text-size choices exposed by the companion chat settings.
///
/// Keeping this policy in the portable core gives the app one source of truth
/// for persistence and prevents individual chat surfaces from inventing their
/// own scale factors.
public enum ConversationTextSize: String, CaseIterable, Codable, Sendable {
    case small
    case standard
    case large

    public var scale: CGFloat {
        switch self {
        case .small: return 0.9
        case .standard: return 1.0
        case .large: return 1.15
        }
    }
}
