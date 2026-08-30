import CoreGraphics
import Foundation

/// Observable conversation metrics derived from the 590×1280 reference
/// canvas. Views scale from these constants; tests lock the policy.
public enum ConversationLayoutPolicy: Sendable {
    public static let referenceWidth: CGFloat = 590
    public static let referenceHeight: CGFloat = 1280

    /// Top chrome band in the reference screenshot (back, identity pill, desktop).
    public static let referenceChromeTopY: CGFloat = 92
    public static let referenceChromeBottomY: CGFloat = 150

    public static let chromeButtonDiameter: CGFloat = 44
    public static let chromeButtonGap: CGFloat = 8
    public static let chromeHorizontalPadding: CGFloat = 12
    public static let chromeTopPadding: CGFloat = 4
    public static let chromeBottomPadding: CGFloat = 6

    public static let identityAvatar: CGFloat = 30
    public static let identityStatusDot: CGFloat = 8

    public static let transcriptHorizontalMargin: CGFloat = 22
    public static let bubbleMaxWidthFraction: CGFloat = 0.83
    public static let bubbleCornerRadius: CGFloat = 24
    public static let transcriptRowSpacing: CGFloat = 10
    public static let dateSeparatorTopPadding: CGFloat = 14
    public static let dateSeparatorBottomPadding: CGFloat = 6

    public static let scrollContentTopInset: CGFloat = 50

    public static let composerButtonDiameter: CGFloat = 44
    public static let composerHorizontalPadding: CGFloat = 12
    public static let composerBarHeight: CGFloat = 44
    public static let composerControlGap: CGFloat = 10

    public static let floatingWorkingAvatarSize: CGFloat = 30
    public static let floatingScrollButtonSize: CGFloat = 44
    public static let floatingAdornmentBottomPadding: CGFloat = 8

    public static var headerChromeHeight: CGFloat {
        chromeButtonDiameter + chromeTopPadding + chromeBottomPadding
    }

    public static func identityTitle(name: String, modelLabel: String) -> String {
        let trimmed = modelLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return name }
        return "\(name) · \(trimmed)"
    }

    public static func bubbleMaxWidth(paneWidth: CGFloat) -> CGFloat {
        paneWidth * bubbleMaxWidthFraction
    }

    public static func bubbleEdgeReserve(paneWidth: CGFloat) -> CGFloat {
        let content = max(0, paneWidth - transcriptHorizontalMargin * 2)
        return max(12, content - bubbleMaxWidth(paneWidth: paneWidth))
    }

    public static func showsScrollToBottomButton(
        followingLatest: Bool,
        hasTranscript: Bool
    ) -> Bool {
        hasTranscript && !followingLatest
    }

    public static func showsFloatingWorkingAvatar(
        showsWorkingRow: Bool,
        followingLatest: Bool
    ) -> Bool {
        showsWorkingRow && !followingLatest
    }

    public static func referenceCanvasY(_ y: CGFloat, paneWidth: CGFloat) -> CGFloat {
        y * paneWidth / referenceWidth
    }
}
