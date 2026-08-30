import Foundation

/// Guards a checked continuation so cancellation and completion cannot resume twice.
/// The box can be created before the continuation exists so `onCancel` cannot
/// race past assignment and hang the waiter.
public final class ResumeOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    private var pending: T?
    private var resumed = false

    public init() {}

    public init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    public func attach(_ continuation: CheckedContinuation<T, Never>) {
        let toResume: T?
        lock.lock()
        if resumed {
            toResume = pending
            pending = nil
            self.continuation = nil
        } else {
            self.continuation = continuation
            toResume = nil
        }
        lock.unlock()
        if let toResume {
            continuation.resume(returning: toResume)
        }
    }

    public func resume(returning value: T) {
        let toResume: CheckedContinuation<T, Never>?
        lock.lock()
        if resumed {
            toResume = nil
        } else if let continuation {
            resumed = true
            self.continuation = nil
            pending = nil
            toResume = continuation
        } else {
            resumed = true
            pending = value
            toResume = nil
        }
        lock.unlock()
        toResume?.resume(returning: value)
    }

    public var hasResumed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return resumed
    }
}
