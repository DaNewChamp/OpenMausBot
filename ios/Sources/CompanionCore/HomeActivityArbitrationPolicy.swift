/// Parent-level ownership for the home activity rail and needs-you island.
/// An expanded activity panel owns the home interaction surface so the island
/// and its dismissal layer cannot cover it or intercept its taps.
public enum HomeActivityArbitrationPolicy: Sendable {
    public enum Surface: String, Equatable, Sendable {
        case idle
        case activity
        case needsYouIsland
    }

    public struct State: Equatable, Sendable {
        public let activityExpanded: Bool
        public let needsYouAvailable: Bool

        public init(activityExpanded: Bool, needsYouAvailable: Bool) {
            self.activityExpanded = activityExpanded
            self.needsYouAvailable = needsYouAvailable
        }

        public var surface: Surface {
            if activityExpanded { return .activity }
            return needsYouAvailable ? .needsYouIsland : .idle
        }

        /// The collapsed hardware shell remains available on a normal home,
        /// but an expanded activity panel suppresses the whole island view.
        public var islandPresentationAllowed: Bool {
            surface != .activity
        }

        /// Only an active needs-you surface may install the full-screen
        /// dismissal layer. The activity panel never competes for that layer.
        public var islandDismissalLayerAllowed: Bool {
            surface == .needsYouIsland
        }

        public func settingActivityExpanded(_ expanded: Bool) -> State {
            State(activityExpanded: expanded, needsYouAvailable: needsYouAvailable)
        }

        public func settingNeedsYouAvailable(_ available: Bool) -> State {
            State(activityExpanded: activityExpanded, needsYouAvailable: available)
        }
    }
}
