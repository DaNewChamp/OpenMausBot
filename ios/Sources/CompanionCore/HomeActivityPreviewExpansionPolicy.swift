import Foundation
import CoreGraphics

/// Keeps the DEBUG StorePreview activity expansion deterministic when the
/// fixture arrives after the home view's first appearance.
public enum HomeActivityPreviewExpansionPolicy: Sendable {
    public static func expandedPanelMinHeight(
        isAccessibilitySize: Bool,
        isExpanded: Bool
    ) -> CGFloat {
        isAccessibilitySize && isExpanded ? 400 : 0
    }

    public static func shouldAutoExpand(
        arguments: [String],
        presentation: HomeActivityPresentation,
        isExpanded: Bool
    ) -> Bool {
        guard !isExpanded,
              arguments.contains("-store-preview"),
              arguments.contains("-preview-expand-activity")
        else { return false }
        return !presentation.items.isEmpty
    }
}
