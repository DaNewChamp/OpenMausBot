import Foundation
import CoreGraphics

/// Observable home-roster metrics derived from the 590×1280 reference
/// canvas. Views scale from these constants; tests lock the policy.
public enum HomeRosterLayoutPolicy: Sendable {
    public static let referenceWidth: CGFloat = 590
    public static let referenceHeight: CGFloat = 1280
    public static let referenceFirstRowY: CGFloat = 400
    public static let referenceSafeAreaTop: CGFloat = 59
    public static let referenceTextColumnX: CGFloat = 110

    /// Visible account avatar on the 590×1280 reference (~59px ≈ 40pt at 402pt pane).
    public static let profileDiameter: CGFloat = 40
    /// Minimum tap target for the account control; the rendered circle stays smaller.
    public static let profileTapDiameter: CGFloat = 44
    public static let chromeButtonDiameter: CGFloat = 58
    public static let chromeButtonGap: CGFloat = 12

    public static let pagePadding: CGFloat = 14
    public static let headerTopPadding: CGFloat = 8
    public static let headerBottomPadding: CGFloat = 12

    public static let rowAvatar: CGFloat = 58
    public static let rowAvatarSpacing: CGFloat = 14
    public static let rowMinHeight: CGFloat = 104
    public static let rowVerticalPadding: CGFloat = 11

    public static let shelfTopPadding: CGFloat = 8
    public static let shelfBottomPadding: CGFloat = 8

    public static var headerChromeHeight: CGFloat {
        chromeButtonDiameter + headerTopPadding + headerBottomPadding
    }

    public static var rowContentLeadingInset: CGFloat {
        pagePadding + rowAvatar + rowAvatarSpacing
    }

    public static func rowContentLeadingInset(paneWidth: CGFloat) -> CGFloat {
        let scaled = referenceTextColumnX * paneWidth / referenceWidth
        return max(rowContentLeadingInset, scaled)
    }

    /// Hero avatar + caption. Not stretched to screenshot-pixel y=400;
    /// that canvas is a scaled iPhone shot, not a 590pt layout.
    public static func pinnedShelfReservedHeight(nameBlockHeight: CGFloat) -> CGFloat {
        PinnedChatShelfLayout.heroAvatar
            + PinnedChatShelfLayout.heroCaptionSpacing
            + nameBlockHeight
    }

    /// Convert a Y coordinate from the 590×1280 reference screenshot into
    /// points on a phone whose width is `paneWidth`.
    public static func referenceCanvasY(_ y: CGFloat, paneWidth: CGFloat) -> CGFloat {
        y * paneWidth / referenceWidth
    }

    public static func screenshotY(pointY: CGFloat, paneWidth: CGFloat) -> CGFloat {
        pointY * referenceWidth / paneWidth
    }
}
