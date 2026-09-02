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

    /// The compact base pill always hugs its copy. Expansion fans upward only;
    /// widening is reserved for the detail panel above the pill.
    public static func collapsedUsesContentHugging(isExpanded: Bool) -> Bool {
        true
    }

    /// Premium width budget for the expanded detail panel above the base pill.
    public static let expandedPanelMaxWidth: CGFloat = 430

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

    public enum ExpansionDirection: String, Sendable {
        case upward
    }

    public enum ExpandedPanelAnchor: String, Sendable {
        case aboveCollapsedPill
    }

    /// Temporary-agent and home activity controls fan upward only. Text may
    /// widen; the control cluster never fans sideways.
    public static let expansionDirection: ExpansionDirection = .upward
    public static let expandsSideways = false
    public static let expandedPanelAnchor: ExpandedPanelAnchor = .aboveCollapsedPill
}
