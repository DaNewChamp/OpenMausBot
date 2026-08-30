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

/// Pinned shelf metrics. One to three pins use a centered hero row with a
/// large avatar; four or more scroll horizontally in a compact strip. The
/// reserved height stays constant so the roster below does not jump.
public struct PinnedChatShelfLayout: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case hero
        case compact
    }

    public static let columns = 3
    public static let heroPinLimit = 3
    public static let gutter: CGFloat = 10
    public static let heroAvatar: CGFloat = 123
    public static let compactCoverAvatar: CGFloat = 72
    public static let cellPadding: CGFloat = 8
    public static let nameBlock: CGFloat = 28
    public static let pagePadding: CGFloat = HomeRosterLayoutPolicy.pagePadding
    public static let minimumAvatar: CGFloat = 64
    public static let heroCaptionSpacing: CGFloat = 7
    public static let heroTileSpacing: CGFloat = 20

    public var avatar: CGFloat
    public var tile: CGFloat
    public var spacing: CGFloat
    public var mode: Mode

    public static var reservedHeight: CGFloat { reservedHeight(nameBlockHeight: nameBlock) }

    public static func reservedHeight(nameBlockHeight: CGFloat) -> CGFloat {
        HomeRosterLayoutPolicy.pinnedShelfReservedHeight(nameBlockHeight: nameBlockHeight)
    }

    /// Zero pins / a cold loading roster must not keep the hero slot.
    /// Once pins exist, height stays at the hero reservation so the list does
    /// not jump; a collapsing last pin keeps that slot until the animation ends.
    public static func reservedHeight(
        pinCount: Int,
        rosterResolved: Bool,
        animatingCollapse: Bool,
        nameBlockHeight: CGFloat
    ) -> CGFloat {
        let coldEmpty = pinCount <= 0 && !rosterResolved && !animatingCollapse
        let resolvedEmpty = pinCount <= 0 && rosterResolved && !animatingCollapse
        if coldEmpty || resolvedEmpty { return 0 }
        guard CalmSurfacePolicy.reservesPinnedShelfRegion(
            pinCount: pinCount,
            animatingCollapse: animatingCollapse
        ) else { return 0 }
        return reservedHeight(nameBlockHeight: nameBlockHeight)
    }

    /// Single-line caption2 label area that scales with Dynamic Type.
    public static func nameBlockHeight(
        captionLineHeight: CGFloat,
        lines: CGFloat = 1
    ) -> CGFloat {
        max(nameBlock, ceil(captionLineHeight * lines))
    }

    public static func mode(for pinCount: Int) -> Mode {
        pinCount > heroPinLimit ? .compact : .hero
    }

    public static func overflows(pinCount: Int) -> Bool {
        pinCount > heroPinLimit
    }

    public static func metrics(paneWidth: CGFloat, pinCount: Int) -> PinnedChatShelfLayout {
        switch mode(for: pinCount) {
        case .hero:
            return heroMetrics(paneWidth: paneWidth, pinCount: pinCount)
        case .compact:
            return compactMetrics(paneWidth: paneWidth)
        }
    }

    private static func heroMetrics(paneWidth: CGFloat, pinCount: Int) -> PinnedChatShelfLayout {
        if pinCount <= 1 {
            return PinnedChatShelfLayout(
                avatar: heroAvatar,
                tile: heroAvatar,
                spacing: 0,
                mode: .hero
            )
        }
        let inner = max(paneWidth - pagePadding * 2, 1)
        var spacing = heroTileSpacing
        var tile = heroAvatar
        let needed = CGFloat(pinCount) * tile + CGFloat(pinCount - 1) * spacing
        if needed > inner {
            let spacingBudget = CGFloat(pinCount - 1) * spacing
            if spacingBudget + CGFloat(pinCount) <= inner {
                tile = (inner - spacingBudget) / CGFloat(pinCount)
            } else {
                tile = min(heroAvatar, inner / CGFloat(pinCount))
                spacing = pinCount > 1
                    ? max(0, (inner - tile * CGFloat(pinCount)) / CGFloat(pinCount - 1))
                    : 0
            }
        }
        return PinnedChatShelfLayout(
            avatar: tile,
            tile: tile,
            spacing: spacing,
            mode: .hero
        )
    }

    private static func compactMetrics(paneWidth: CGFloat) -> PinnedChatShelfLayout {
        let inner = max(paneWidth - pagePadding * 2, 1)
        let cell = max(0, inner / CGFloat(columns) - gutter * 2)
        let avatar = min(compactCoverAvatar, max(minimumAvatar, cell - cellPadding * 2))
        let tile = max(avatar, cell)
        return PinnedChatShelfLayout(
            avatar: avatar,
            tile: tile,
            spacing: gutter * 2,
            mode: .compact
        )
    }
}
