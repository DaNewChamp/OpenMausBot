import Foundation

/// Tracks the state replacements that are authoritative enough for views to
/// discard local assumptions. A resumed stream only replays frames and must
/// not advance this revision.
public struct HydrationRevision: Equatable, Sendable {
    public private(set) var value: Int

    public init() {
        value = 0
    }

    /// Records a successful hello. Callers must invoke this after a full
    /// hydrate succeeds; a resumed hello leaves the revision unchanged.
    @discardableResult
    public mutating func record(resumed: Bool) -> Int {
        guard !resumed else { return value }
        value += 1
        return value
    }
}
