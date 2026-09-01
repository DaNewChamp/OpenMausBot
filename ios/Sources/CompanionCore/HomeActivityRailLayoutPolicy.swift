import CoreGraphics

/// Layout metrics for the collapsed home activity rail. Accessibility text
/// uses compact, single-line visual copy with a larger vertical budget; keeping
/// the decision in core makes the view's sizing contract testable without Xcode.
public enum HomeActivityRailLayoutPolicy: Sendable {
    /// Quiet has no actionable activity and therefore should not reserve a
    /// bottom rail at all. Keeping this decision in core prevents a view from
    /// accidentally rendering a dead "All quiet" capsule.
    public static func showsRail(for state: HomeActivityPresentation.State) -> Bool {
        state != .quiet
    }

    /// A collapsed rail should wrap its copy; the expanded panel opts into a
    /// wider presentation so its detail rows have room to breathe.
    public static func usesContentHugging(isExpanded: Bool) -> Bool {
        !isExpanded
    }

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
