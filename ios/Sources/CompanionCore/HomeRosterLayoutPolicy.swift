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

    public static let profileDiameter: CGFloat = 56
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
        profileDiameter + headerTopPadding + headerBottomPadding
    }

    public static var rowContentLeadingInset: CGFloat {
        pagePadding + rowAvatar + rowAvatarSpacing
    }

    public static func rowContentLeadingInset(paneWidth: CGFloat) -> CGFloat {
        let scaled = referenceTextColumnX * paneWidth / referenceWidth
        return max(rowContentLeadingInset, scaled)
    }

    public static func pinnedShelfReservedHeight(nameBlockHeight: CGFloat) -> CGFloat {
        let targetAtReference = referenceFirstRowY
            - referenceSafeAreaTop
            - headerChromeHeight
            - shelfTopPadding
            - shelfBottomPadding
        let contentMinimum = PinnedChatShelfLayout.heroAvatar
            + PinnedChatShelfLayout.heroCaptionSpacing
            + nameBlockHeight
        return max(contentMinimum, targetAtReference)
    }
}
