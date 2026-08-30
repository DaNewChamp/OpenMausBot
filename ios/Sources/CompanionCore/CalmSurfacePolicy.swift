import Foundation

/// Presentation policy for premium surfaces. Views own SwiftUI; this keeps
/// loading, reconnect, and pinned-shelf geometry deterministic and testable.
public enum CalmSurfacePolicy: Sendable {
    public static let reconnectToEdit = "Reconnect to edit."

    public static func canEditRemoteContent(isLive: Bool, hasConnection: Bool) -> Bool {
        isLive && hasConnection
    }

    /// Skeleton only when there is nothing cached to show — never blank a
    /// known identity while a reload is in flight.
    public static func showsSkeleton(isLoading: Bool, hasCachedRows: Bool) -> Bool {
        isLoading && !hasCachedRows
    }

    /// Failed reloads keep the last good catalog so profile/computer identity
    /// does not flash empty while disconnected.
    public static func selectCatalog<T>(cached: [T], incoming: [T], failed: Bool) -> [T] {
        failed ? cached : incoming
    }

    /// Destination rows and skeleton are mutually exclusive while instances load.
    public static func showsDestinationRows(isLoading: Bool, instanceResolved: Bool) -> Bool {
        !showsSkeleton(isLoading: isLoading, hasCachedRows: instanceResolved)
    }

    /// Unknown instances stay visible but untappable until capabilities resolve.
    public static func destinationsSelectable(isLoading: Bool, instanceResolved: Bool) -> Bool {
        !isLoading && instanceResolved
    }

    /// Reserve the pinned shelf slot after the first pin so 0↔1 transitions
    /// do not shove the roster; skip reservation on a cold roster with no pins.
    public static func reservesPinnedShelfRegion(pinCount: Int, animatingCollapse: Bool) -> Bool {
        pinCount > 0 || animatingCollapse
    }
}

/// Three-across pinned shelf metrics. Extra pins scroll horizontally; the
/// reserved height stays constant so the roster below does not jump.
public struct PinnedChatShelfLayout: Equatable, Sendable {
    public static let columns = 3
    public static let gutter: CGFloat = 10
    public static let coverAvatar: CGFloat = 80
    public static let cellPadding: CGFloat = 8
    public static let nameBlock: CGFloat = 36
    public static let pagePadding: CGFloat = 16
    public static let minimumAvatar: CGFloat = 64

    public var avatar: CGFloat
    public var tile: CGFloat
    public var spacing: CGFloat

    public static var reservedHeight: CGFloat { reservedHeight(nameBlockHeight: nameBlock) }

    public static func reservedHeight(nameBlockHeight: CGFloat) -> CGFloat {
        coverAvatar + 7 + nameBlockHeight
    }

    /// Two-line caption2 label area that scales with Dynamic Type.
    public static func nameBlockHeight(
        captionLineHeight: CGFloat,
        lines: CGFloat = 2
    ) -> CGFloat {
        max(nameBlock, ceil(captionLineHeight * lines))
    }

    public static func overflows(pinCount: Int) -> Bool {
        pinCount > columns
    }

    public static func metrics(paneWidth: CGFloat) -> PinnedChatShelfLayout {
        let inner = max(paneWidth - pagePadding * 2, 1)
        let cell = max(0, inner / CGFloat(columns) - gutter * 2)
        let avatar = min(coverAvatar, max(minimumAvatar, cell - cellPadding * 2))
        let tile = max(avatar, cell)
        return PinnedChatShelfLayout(avatar: avatar, tile: tile, spacing: gutter * 2)
    }
}
