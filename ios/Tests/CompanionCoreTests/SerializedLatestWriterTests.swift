import XCTest
@testable import CompanionCore

final class SerializedLatestWriterTests: XCTestCase {
    func testCoalescesToLatestIntentWithoutOverlappingPerforms() async {
        let writer = SerializedLatestWriter<String, String, String>()
        let probe = PerformProbe()
        await probe.block("A")

        async let first: String? = writer.submit(key: "bot", intent: "A") { intent in
            await probe.enter(intent)
            return intent
        }
        await probe.waitUntilStarted("A")

        let secondTask = Task {
            await writer.submit(key: "bot", intent: "B") { intent in
                await probe.enter(intent)
                return intent
            }
        }
        await waitUntilGeneration(writer, key: "bot", atLeast: 2)
        let thirdTask = Task {
            await writer.submit(key: "bot", intent: "C") { intent in
                await probe.enter(intent)
                return intent
            }
        }
        await waitUntilGeneration(writer, key: "bot", atLeast: 3)

        await probe.release("A")
        let results = await (first, secondTask.value, thirdTask.value)

        XCTAssertNil(results.0)
        XCTAssertNil(results.1)
        XCTAssertEqual(results.2, "C")
        let performed = await probe.performed
        XCTAssertEqual(performed, ["A", "C"])
        let maxOverlap = await probe.maxOverlap
        XCTAssertEqual(maxOverlap, 1)
    }

    func testInvalidateDropsQueuedIntentAndIgnoresInFlightResult() async {
        let writer = SerializedLatestWriter<String, String, String>()
        let probe = PerformProbe()
        await probe.block("A")

        async let first: String? = writer.submit(key: "bot", intent: "A") { intent in
            await probe.enter(intent)
            return intent
        }
        await probe.waitUntilStarted("A")

        let secondTask = Task {
            await writer.submit(key: "bot", intent: "B") { intent in
                await probe.enter(intent)
                return intent
            }
        }
        await waitUntilGeneration(writer, key: "bot", atLeast: 2)

        await writer.invalidate(key: "bot")
        await probe.release("A")
        let results = await (first, secondTask.value)

        XCTAssertNil(results.0)
        XCTAssertNil(results.1)
        let performed = await probe.performed
        XCTAssertEqual(performed, ["A"])
    }

    func testLaterSubmitAfterInvalidateRunsOnceInFlightFinishes() async {
        let writer = SerializedLatestWriter<String, String, String>()
        let probe = PerformProbe()
        await probe.block("A")

        async let first: String? = writer.submit(key: "bot", intent: "A") { intent in
            await probe.enter(intent)
            return intent
        }
        await probe.waitUntilStarted("A")
        await writer.invalidate(key: "bot")

        let secondTask = Task {
            await writer.submit(key: "bot", intent: "C") { intent in
                await probe.enter(intent)
                return intent
            }
        }
        await probe.release("A")
        let results = await (first, secondTask.value)

        XCTAssertNil(results.0)
        XCTAssertEqual(results.1, "C")
        let performed = await probe.performed
        XCTAssertEqual(performed, ["A", "C"])
        let maxOverlap = await probe.maxOverlap
        XCTAssertEqual(maxOverlap, 1)
    }
}

private actor PerformProbe {
    private var gates: [String: Gate] = [:]
    private var blocking: Set<String> = []
    private(set) var performed: [String] = []
    private var overlap = 0
    private(set) var maxOverlap = 0

    private struct Gate {
        var started: CheckedContinuation<Void, Never>?
        var startedSignaled = false
        var release: CheckedContinuation<Void, Never>?
        var released = false
    }

    func block(_ intent: String) {
        blocking.insert(intent)
    }

    func waitUntilStarted(_ intent: String) async {
        if gates[intent]?.startedSignaled == true { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var gate = gates[intent] ?? Gate()
            if gate.startedSignaled {
                continuation.resume()
            } else {
                gate.started = continuation
                gates[intent] = gate
            }
        }
    }

    func release(_ intent: String) {
        var gate = gates[intent] ?? Gate()
        gate.released = true
        if let continuation = gate.release {
            gate.release = nil
            continuation.resume()
        }
        gates[intent] = gate
    }

    func enter(_ intent: String) async {
        overlap += 1
        maxOverlap = max(maxOverlap, overlap)
        performed.append(intent)

        var gate = gates[intent] ?? Gate()
        gate.startedSignaled = true
        if let continuation = gate.started {
            gate.started = nil
            continuation.resume()
        }
        gates[intent] = gate

        guard blocking.contains(intent) else {
            overlap -= 1
            return
        }

        if gate.released {
            overlap -= 1
            return
        }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var current = gates[intent] ?? Gate()
            if current.released {
                continuation.resume()
            } else {
                current.release = continuation
                gates[intent] = current
            }
        }
        overlap -= 1
    }
}

private func waitUntilGeneration(
    _ writer: SerializedLatestWriter<String, String, String>,
    key: String,
    atLeast: Int
) async {
    for _ in 0..<1_000 {
        if await writer.currentGeneration(for: key) >= atLeast { return }
        await Task.yield()
    }
    XCTFail("timed out waiting for writer generation \(atLeast)")
}
