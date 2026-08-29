// Transcript follow: only pin to the latest line when the reader is already
// at the bottom. A Grok-like chat that yanks you down while you scroll up to
// copy a citation is not a chat; it is a fight.
import Foundation

public enum ChatFollow {
    /// Matches the desktop near-bottom zone. Small layout jitter inside this
    /// window must not look like the reader left the latest message.
    public static let nearBottomThreshold: CGFloat = 48

    public static func shouldScrollToLatest(following: Bool) -> Bool {
        following
    }

    /// Resume only when the reader is moving toward the latest message *and*
    /// is already inside the near-bottom zone. An upward flick that is still
    /// within the threshold must never re-pin.
    public static func updatedFollowing(
        following: Bool,
        previousDistanceFromBottom: CGFloat,
        distanceFromBottom: CGFloat
    ) -> Bool {
        if following {
            return distanceFromBottom <= nearBottomThreshold
        }
        let movedTowardLatest = distanceFromBottom < previousDistanceFromBottom
        return movedTowardLatest && distanceFromBottom < nearBottomThreshold
    }
}
