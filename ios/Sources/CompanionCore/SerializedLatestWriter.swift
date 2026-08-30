import Foundation

/// Serializes work per key and coalesces to the latest submitted intent.
///
/// Concurrent `submit` calls for the same key never overlap `perform`. A newer
/// intent replaces a queued one so the server and UI honor last user intent.
/// `invalidate` drops queued work, cancels the in-flight `perform` Task, and
/// prevents that result from applying.
///
/// Cancellation cannot roll back a sidecar PATCH after the request body has
/// already been sent. Callers must not treat a reverted local selection as
/// authoritative: skip sending a new turn against it and hydrate first.
public actor SerializedLatestWriter<Key: Hashable & Sendable, Intent: Sendable, Output: Sendable> {
    private var generation: [Key: Int] = [:]
    private var pending: [Key: Pending] = [:]
    private var waiters: [Key: [Int: CheckedContinuation<Output?, Never>]] = [:]
    private var running: Set<Key> = []
    private var inFlight: [Key: Task<Output?, Never>] = [:]

    private struct Pending {
        var intent: Intent
        var generation: Int
    }

    public init() {}

    public func invalidate(key: Key) {
        generation[key] = EngineSyncPolicy.nextGeneration(after: generation[key] ?? 0)
        pending[key] = nil
        if let task = inFlight.removeValue(forKey: key) {
            task.cancel()
        }
        resumeAll(key: key, value: nil)
    }

    public func submit(
        key: Key,
        intent: Intent,
        perform: @escaping @Sendable (Intent) async -> Output?
    ) async -> Output? {
        let nextGeneration = EngineSyncPolicy.nextGeneration(after: generation[key] ?? 0)
        generation[key] = nextGeneration
        if let previous = pending.removeValue(forKey: key) {
            resume(key: key, generation: previous.generation, value: nil)
        }
        pending[key] = Pending(intent: intent, generation: nextGeneration)

        return await withCheckedContinuation { continuation in
            waiters[key, default: [:]][nextGeneration] = continuation
            guard !running.contains(key) else { return }
            running.insert(key)
            Task {
                await self.drain(key: key, perform: perform)
            }
        }
    }

    private func drain(
        key: Key,
        perform: @escaping @Sendable (Intent) async -> Output?
    ) async {
        while let work = pending.removeValue(forKey: key) {
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: work.generation,
                currentGeneration: generation[key] ?? 0
            ) else {
                resume(key: key, generation: work.generation, value: nil)
                continue
            }
            let task = Task<Output?, Never> {
                await perform(work.intent)
            }
            inFlight[key] = task
            let output = await task.value
            inFlight[key] = nil
            let apply = EngineSyncPolicy.shouldApply(
                startedGeneration: work.generation,
                currentGeneration: generation[key] ?? 0
            )
            resume(key: key, generation: work.generation, value: apply ? output : nil)
        }
        running.remove(key)
        if pending[key] != nil {
            running.insert(key)
            await drain(key: key, perform: perform)
        }
    }

    func currentGeneration(for key: Key) -> Int {
        generation[key] ?? 0
    }

    private func resume(key: Key, generation: Int, value: Output?) {
        guard let continuation = waiters[key]?.removeValue(forKey: generation) else { return }
        continuation.resume(returning: value)
    }

    private func resumeAll(key: Key, value: Output?) {
        let pendingWaiters = waiters.removeValue(forKey: key) ?? [:]
        for continuation in pendingWaiters.values {
            continuation.resume(returning: value)
        }
    }
}
