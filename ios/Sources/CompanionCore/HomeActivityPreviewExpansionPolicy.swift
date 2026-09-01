import Foundation
import CoreGraphics

/// Keeps the DEBUG StorePreview activity expansion deterministic when the
/// fixture arrives after the home view's first appearance.
public enum HomeActivityPreviewExpansionPolicy: Sendable {
    /// Reserve only the space the expanded activity rows need at regular text
    /// sizes. A fixed maximum made a one-row panel unnecessarily tall, which
    /// pushed it over the roster. Accessibility text receives a larger
    /// scrollable budget so the row remains readable without an overlay.
    public static func expandedPanelHeight(
        isAccessibilitySize: Bool,
        itemCount: Int,
        sectionCount: Int,
        hasNeedsYou: Bool = false
    ) -> CGFloat {
        guard itemCount > 0 else { return 0 }
        if isAccessibilitySize {
            // Approval details can be several lines long; keep the larger
            // scrollable budget. Work-only activity needs less room while
            // still fitting its enlarged title and subtitle.
            return hasNeedsYou ? 400 : 260
        }

        let rows = CGFloat(itemCount) * 48
        let headings = CGFloat(max(sectionCount, 1)) * 24
        return min(320, max(88, rows + headings + 8))
    }

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
