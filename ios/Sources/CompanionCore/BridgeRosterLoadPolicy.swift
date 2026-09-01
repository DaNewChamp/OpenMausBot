import Foundation

/// Identifies one authenticated bridge-roster request. The connection id is
/// part of the identity because a phone may switch computers while an older
/// host is still answering.
public struct BridgeRosterRefreshRequest: Equatable, Sendable {
    public let generation: Int
    public let connectionID: String

    public init(generation: Int, connectionID: String) {
        self.generation = generation
        self.connectionID = connectionID
    }
}

/// Last-authoritative bridge-roster refresh. Only the newest request for the
/// selected connection may publish rows or settle the loading state.
public struct BridgeRosterRefreshGate: Equatable, Sendable {
    public private(set) var generation: Int
    public private(set) var connectionID: String?
    public private(set) var refreshing: Bool

    public init(
        generation: Int = 0,
        connectionID: String? = nil,
        refreshing: Bool = false
    ) {
        self.generation = generation
        self.connectionID = connectionID
        self.refreshing = refreshing
    }

    public mutating func beginLoad(for connectionID: String) -> BridgeRosterRefreshRequest {
        generation = ConnectionResiliencePolicy.nextGeneration(after: generation)
        self.connectionID = connectionID
        refreshing = true
        return BridgeRosterRefreshRequest(generation: generation, connectionID: connectionID)
    }

    /// Switching or removing a computer drops any in-flight result and
    /// leaves the next selected connection with an empty, non-loading roster.
    public mutating func invalidate() {
        generation = ConnectionResiliencePolicy.nextGeneration(after: generation)
        connectionID = nil
        refreshing = false
    }

    /// Applies only when both the request generation and selected connection
    /// still match. A stale host can therefore never overwrite the new host.
    @discardableResult
    public mutating func finishLoad(
        _ request: BridgeRosterRefreshRequest,
        currentConnectionID: String?
    ) -> Bool {
        guard refreshing,
              request.generation == generation,
              request.connectionID == connectionID,
              request.connectionID == currentConnectionID
        else { return false }
        refreshing = false
        return true
    }
}

public enum BridgeRosterLoadPolicy: Sendable {
    public static func shouldApply(
        request: BridgeRosterRefreshRequest,
        currentGeneration: Int,
        currentConnectionID: String?
    ) -> Bool {
        request.generation == currentGeneration && request.connectionID == currentConnectionID
    }
}
