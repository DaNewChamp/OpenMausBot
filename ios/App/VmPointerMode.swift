import Foundation

/// How finger input maps to the Local VM desktop.
enum VmPointerMode: String, CaseIterable, Identifiable {
    case touch
    case trackpad

    var id: String { rawValue }

    var title: String {
        switch self {
        case .touch: return "Touch"
        case .trackpad: return "Trackpad"
        }
    }

    var systemImage: String {
        switch self {
        case .touch: return "hand.tap"
        case .trackpad: return "rectangle.and.hand.point.up.left"
        }
    }

    var accessibilityHint: String {
        switch self {
        case .touch:
            return "Tap where you want to click on the remote desktop."
        case .trackpad:
            return "Drag to move the cursor, pinch to zoom, tap to click."
        }
    }
}
