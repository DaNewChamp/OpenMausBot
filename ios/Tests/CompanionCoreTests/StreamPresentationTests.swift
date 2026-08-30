// Streaming presentation: the phone must never paint raw token jitter.
//
// These are the contracts the chat bubble actually needs — cadence, stable
// markdown, ordering/dedup, final replacement, cancel/error/reconnect — and
// they live in CompanionCore so they can fail without a simulator.
import XCTest
@testable import CompanionCore

final class StreamCoalescerTests: XCTestCase {
    private func delta(
        _ text: String,
        thread: String = "t1",
        id: String? = nil,
        kind: String = "assistant_text"
    ) -> RuntimeEvent {
        RuntimeEvent(
            type: "content.delta",
            threadId: thread,
            delta: text,
            streamKind: kind,
            eventId: id
        )
    }

    func testTokenBurstsScheduleASingleFrameFriendlyFlush() {
        var coalescer = StreamCoalescer()
        XCTAssertEqual(
            coalescer.ingest(delta("Hel"), nowMs: 0),
            .scheduleFlush(atMs: StreamCoalescer.flushIntervalMs)
        )
        XCTAssertEqual(coalescer.ingest(delta("lo"), nowMs: 8), .none)
        XCTAssertEqual(coalescer.ingest(delta("!"), nowMs: 16), .none)

        let flushed = coalescer.flush(nowMs: StreamCoalescer.flushIntervalMs)
        XCTAssertEqual(flushed.map(\.delta), ["Hel", "lo", "!"])
        XCTAssertTrue(coalescer.flush(nowMs: StreamCoalescer.flushIntervalMs + 1).isEmpty)
    }

    func testATerminalEventFlushesPendingDeltasImmediately() {
        var coalescer = StreamCoalescer()
        XCTAssertEqual(
            coalescer.ingest(delta("half"), nowMs: 0),
            .scheduleFlush(atMs: StreamCoalescer.flushIntervalMs)
        )
        let action = coalescer.ingest(
            RuntimeEvent(type: "turn.completed", threadId: "t1"),
            nowMs: 10
        )
        guard case let .flushNow(events) = action else {
            return XCTFail("expected an immediate flush, got \(action)")
        }
        XCTAssertEqual(events.map(\.type), ["content.delta", "turn.completed"])
        XCTAssertEqual(events.first?.delta, "half")
    }

    func testFailedAndAbortedTurnsAlsoFlushImmediately() {
        for ending in ["turn.failed", "turn.aborted"] {
            var coalescer = StreamCoalescer()
            _ = coalescer.ingest(delta("partial"), nowMs: 0)
            let action = coalescer.ingest(
                RuntimeEvent(type: ending, threadId: "t1"),
                nowMs: 4
            )
            guard case let .flushNow(events) = action else {
                return XCTFail("\(ending) should flush immediately")
            }
            XCTAssertEqual(events.last?.type, ending)
        }
    }

    func testTurnStartedFlushesAndOpensANewGeneration() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("stale"), nowMs: 0)
        let action = coalescer.ingest(
            RuntimeEvent(type: "turn.started", threadId: "t1", eventId: "turn-1"),
            nowMs: 5
        )
        guard case let .flushNow(events) = action else {
            return XCTFail("turn.started should flush so the next turn starts clean")
        }
        XCTAssertEqual(events.map(\.type), ["content.delta", "turn.started"])
    }

    func testDuplicateEventIdsAreDroppedEvenAcrossAFlush() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("Hello", id: "e1"), nowMs: 0)
        XCTAssertEqual(coalescer.ingest(delta("Hello", id: "e1"), nowMs: 4), .none)
        let flushed = coalescer.flush(nowMs: StreamCoalescer.flushIntervalMs)
        XCTAssertEqual(flushed.map(\.delta), ["Hello"])
        XCTAssertEqual(coalescer.ingest(delta("Hello", id: "e1"), nowMs: 40), .none)
    }

    func testLateDeltasAfterATerminalEventAreIgnoredUntilANewTurn() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("ok", id: "e1"), nowMs: 0)
        _ = coalescer.ingest(RuntimeEvent(type: "turn.completed", threadId: "t1"), nowMs: 10)
        XCTAssertEqual(
            coalescer.ingest(delta(" leftover", id: "late"), nowMs: 12),
            .none
        )
        XCTAssertTrue(coalescer.flush(nowMs: 50).isEmpty)

        let restart = coalescer.ingest(
            RuntimeEvent(type: "turn.started", threadId: "t1", eventId: "next"),
            nowMs: 80
        )
        guard case .flushNow = restart else {
            return XCTFail("a new turn must accept deltas again")
        }
        XCTAssertEqual(
            coalescer.ingest(delta("Next", id: "e2"), nowMs: 81),
            .scheduleFlush(atMs: 81 + StreamCoalescer.flushIntervalMs)
        )
    }

    func testThreadsCoalesceIndependently() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("one", thread: "t1"), nowMs: 0)
        _ = coalescer.ingest(delta("two", thread: "t2"), nowMs: 0)
        let action = coalescer.ingest(
            RuntimeEvent(type: "turn.completed", threadId: "t1"),
            nowMs: 4
        )
        guard case let .flushNow(events) = action else {
            return XCTFail("t1's completion should flush t1 only")
        }
        XCTAssertEqual(events.map(\.threadId), ["t1", "t1"])
        let rest = coalescer.flush(nowMs: StreamCoalescer.flushIntervalMs)
        XCTAssertEqual(rest.map(\.delta), ["two"])
    }

    func testHasPendingReportsAnotherThreadAfterAPartialFlush() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("one", thread: "t1"), nowMs: 0)
        _ = coalescer.ingest(delta("two", thread: "t2"), nowMs: 0)
        _ = coalescer.ingest(RuntimeEvent(type: "turn.completed", threadId: "t1"), nowMs: 4)
        XCTAssertTrue(coalescer.hasPending)
    }

    func testResetDropsPendingWorkForReconnectHydration() {
        var coalescer = StreamCoalescer()
        _ = coalescer.ingest(delta("ghost"), nowMs: 0)
        coalescer.reset()
        XCTAssertTrue(coalescer.flush(nowMs: StreamCoalescer.flushIntervalMs).isEmpty)
        XCTAssertEqual(
            coalescer.ingest(delta("fresh"), nowMs: 100),
            .scheduleFlush(atMs: 100 + StreamCoalescer.flushIntervalMs)
        )
    }

    func testEmptyAndUnknownDeltasNeverScheduleAFlush() {
        var coalescer = StreamCoalescer()
        XCTAssertEqual(coalescer.ingest(delta(""), nowMs: 0), .none)
        XCTAssertEqual(
            coalescer.ingest(delta("???", kind: "some_future_kind"), nowMs: 0),
            .none
        )
        XCTAssertEqual(
            coalescer.ingest(
                RuntimeEvent(type: "item.started", threadId: "t1"),
                nowMs: 0
            ),
            .none
        )
    }
}

final class MarkdownRevealTests: XCTestCase {
    func testEmptyAndTinyPrefixesStayHidden() {
        XCTAssertNil(MarkdownReveal.visiblePrefix(""))
        XCTAssertNil(MarkdownReveal.visiblePrefix("H"))
        XCTAssertNil(MarkdownReveal.visiblePrefix("Hel"))
        XCTAssertNil(MarkdownReveal.visiblePrefix("**bo"))
        XCTAssertNil(MarkdownReveal.visiblePrefix("["))
        XCTAssertNil(MarkdownReveal.visiblePrefix("```"))
    }

    func testACompletedWordIsSafeToShow() {
        XCTAssertEqual(MarkdownReveal.visiblePrefix("Hello "), "Hello ")
        XCTAssertEqual(MarkdownReveal.visiblePrefix("Hello world"), "Hello world")
    }

    func testALongRunRevealsEvenWithoutWhitespace() {
        let run = String(repeating: "a", count: MarkdownReveal.minimumRevealCount)
        XCTAssertEqual(MarkdownReveal.visiblePrefix(run), run)
        XCTAssertNil(MarkdownReveal.visiblePrefix(String(repeating: "a", count: MarkdownReveal.minimumRevealCount - 1)))
    }

    func testIncompleteEmphasisIsHeldBack() {
        XCTAssertEqual(MarkdownReveal.visiblePrefix("Hello **bo"), "Hello ")
        XCTAssertEqual(MarkdownReveal.visiblePrefix("Hello **bold**"), "Hello **bold**")
    }

    func testAnOpenFenceIsShownAsCodeOnceItHasABody() {
        XCTAssertEqual(
            MarkdownReveal.visiblePrefix("here:\n```py\nprint(1)"),
            "here:\n```py\nprint(1)"
        )
    }

    func testFinalizedTextRevealsEvenUnstableMarkdown() {
        XCTAssertEqual(MarkdownReveal.visiblePrefix("**bo", finalized: true), "**bo")
        XCTAssertEqual(MarkdownReveal.visiblePrefix("H", finalized: true), "H")
    }

    func testNewlinesAreAStableRevealBoundary() {
        XCTAssertEqual(MarkdownReveal.visiblePrefix("Hi\n"), "Hi\n")
    }
}

final class StreamAccessibilityTests: XCTestCase {
    func testWorkingAndCompletionAreAnnouncedOnce() {
        XCTAssertEqual(
            StreamAccessibility.announcement(from: .idle, to: .working, speaker: "Scout"),
            "Scout is working"
        )
        XCTAssertNil(StreamAccessibility.announcement(from: .working, to: .working, speaker: "Scout"))
        XCTAssertNil(StreamAccessibility.announcement(from: .working, to: .streaming, speaker: "Scout"))
        XCTAssertNil(StreamAccessibility.announcement(from: .streaming, to: .streaming, speaker: "Scout"))
        XCTAssertEqual(
            StreamAccessibility.announcement(from: .streaming, to: .complete, speaker: "Scout"),
            "Scout finished their reply"
        )
        XCTAssertEqual(
            StreamAccessibility.announcement(from: .streaming, to: .idle, speaker: "Scout"),
            "Scout finished their reply"
        )
    }

    func testPhaseDoesNotTrackTokenGrowth() {
        XCTAssertEqual(
            StreamAccessibility.phase(isBusy: true, hasVisibleText: false),
            .working
        )
        XCTAssertEqual(
            StreamAccessibility.phase(isBusy: true, hasVisibleText: true),
            .streaming
        )
        XCTAssertEqual(
            StreamAccessibility.phase(isBusy: false, hasVisibleText: false),
            .idle
        )
        XCTAssertEqual(
            StreamAccessibility.phase(isBusy: false, hasVisibleText: true),
            .complete
        )
    }
}

final class ChatFollowTests: XCTestCase {
    func testAutoscrollOnlyWhileFollowing() {
        XCTAssertTrue(ChatFollow.shouldScrollToLatest(following: true))
        XCTAssertFalse(ChatFollow.shouldScrollToLatest(following: false))
    }

    func testScrollingUpPastTheThresholdDetaches() {
        XCTAssertFalse(
            ChatFollow.updatedFollowing(
                following: true,
                previousDistanceFromBottom: 8,
                distanceFromBottom: 80
            )
        )
    }

    func testASmallMovementInsideTheZoneKeepsFollowing() {
        XCTAssertTrue(
            ChatFollow.updatedFollowing(
                following: true,
                previousDistanceFromBottom: 8,
                distanceFromBottom: 20
            )
        )
    }

    func testASmallUpwardNudgeInsideTheZoneDoesNotRePin() {
        XCTAssertFalse(
            ChatFollow.updatedFollowing(
                following: false,
                previousDistanceFromBottom: 4,
                distanceFromBottom: 12
            )
        )
    }

    func testScrollingDownToTheEndRePins() {
        XCTAssertTrue(
            ChatFollow.updatedFollowing(
                following: false,
                previousDistanceFromBottom: 80,
                distanceFromBottom: 0
            )
        )
    }

    func testDownwardMovementAwayFromTheEndStaysDetached() {
        XCTAssertFalse(
            ChatFollow.updatedFollowing(
                following: false,
                previousDistanceFromBottom: 120,
                distanceFromBottom: 80
            )
        )
    }

    func testAlreadyFollowingNearTheBottomStaysPinned() {
        XCTAssertTrue(
            ChatFollow.updatedFollowing(
                following: true,
                previousDistanceFromBottom: 4,
                distanceFromBottom: 0
            )
        )
    }
}
