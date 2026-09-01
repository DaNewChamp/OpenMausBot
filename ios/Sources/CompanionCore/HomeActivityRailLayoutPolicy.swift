import CoreGraphics

/// Layout metrics for the collapsed home activity rail. Accessibility text
/// uses compact, single-line visual copy with a larger vertical budget; keeping
/// the decision in core makes the view's sizing contract testable without Xcode.
public enum HomeActivityRailLayoutPolicy: Sendable {
    public static func collapsedTitleLineLimit(isAccessibilitySize: Bool) -> Int {
        1
    }

    public static func collapsedSubtitleLineLimit(isAccessibilitySize: Bool) -> Int {
        1
    }

    public static func usesCompactCopy(isAccessibilitySize: Bool) -> Bool {
        isAccessibilitySize
    }

    public static func collapsedMinimumHeight(isAccessibilitySize: Bool) -> CGFloat {
        isAccessibilitySize ? 112 : 44
    }

    public static func collapsedVerticalPadding(isAccessibilitySize: Bool) -> CGFloat {
        isAccessibilitySize ? 8 : 0
    }
}
