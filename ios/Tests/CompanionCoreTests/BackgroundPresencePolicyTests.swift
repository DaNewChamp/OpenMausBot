import XCTest
@testable import CompanionCore

final class BackgroundPresencePolicyTests: XCTestCase {
    private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func bot(
        id: String = "bot-1",
        kind: BackgroundPresencePolicy.PresenceKind,
        requestId: String? = nil
    ) -> BackgroundPresencePolicy.WantedBot {
        BackgroundPresencePolicy.WantedBot(
            botId: id,
            threadId: "thread-\(id)",
            name: "Scout",
            color: "green",
            shape: "droplet",
            face: "working",
            kind: kind,
            requestId: requestId,
            options: requestId == nil ? [] : ["Allow", "Deny"],
            isPermission: requestId != nil
        )
    }

    private func context(
        isBackground: Bool = false,
        hydrated: Bool = true,
        activitiesEnabled: Bool = true,
        notificationsEnabled: Bool = true,
        backgroundedAt: Date? = nil,
        now: Date? = nil
    ) -> BackgroundPresencePolicy.Context {
        BackgroundPresencePolicy.Context(
            activitiesEnabled: activitiesEnabled,
            notificationsEnabled: notificationsEnabled,
            isBackground: isBackground,
            hydrated: hydrated,
            backgroundedAt: backgroundedAt,
            now: now ?? self.now
        )
    }

    func testWorkingStartsActivityWithPrivacySafeCopy() {
        let plan = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .working)],
            tracked: [:],
            context: context()
        )
        XCTAssertEqual(plan.commands.count, 1)
        guard case let .start(_, presentation) = plan.commands[0] else {
            return XCTFail("expected start")
        }
        XCTAssertEqual(presentation.headline, "Scout is working")
        XCTAssertEqual(presentation.line, "Working…")
        XCTAssertNil(presentation.requestId)
    }

    func testWorkingBackgroundFinishShowsFinishedBeforeEnd() {
        let working = bot(kind: .working)
        let started = BackgroundPresencePolicy.sync(
            wanted: [working],
            tracked: [:],
            context: context()
        )
        let tracked = started.tracked
        let backgroundedAt = now
        let backgroundPlan = BackgroundPresencePolicy.sync(
            wanted: [],
            tracked: tracked,
            context: context(
                isBackground: true,
                hydrated: false,
                backgroundedAt: backgroundedAt
            )
        )
        XCTAssertEqual(backgroundPlan.commands.count, 1)
        guard case let .update(_, presentation, alert) = backgroundPlan.commands[0] else {
            return XCTFail("expected finished update")
        }
        XCTAssertEqual(presentation.kind, .finished)
        XCTAssertEqual(presentation.headline, "Scout finished")
        XCTAssertFalse(alert)
        XCTAssertFalse(backgroundPlan.commands.contains(where: {
            if case .end = $0 { return true }
            return false
        }))
    }

    func testForegroundHydratedCleanupEndsStaleActivity() {
        let ends = BackgroundPresencePolicy.reconcileForeground(
            wantedIds: [],
            activeBotIds: ["bot-1", "bot-2"],
            hydrated: true
        )
        XCTAssertEqual(ends, ["bot-1", "bot-2"])
    }

    func testForegroundCleanupWaitsForHydration() {
        let ends = BackgroundPresencePolicy.reconcileForeground(
            wantedIds: [],
            activeBotIds: ["bot-1"],
            hydrated: false
        )
        XCTAssertTrue(ends.isEmpty)
    }

    func testDuplicatePresentationIsDeduped() {
        let first = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .working)],
            tracked: [:],
            context: context()
        )
        let second = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .working)],
            tracked: first.tracked,
            context: context()
        )
        XCTAssertTrue(second.commands.isEmpty)
    }

    func testReconnectDuplicateNeedsYouDoesNotRealert() {
        let working = bot(kind: .needsYou, requestId: "req-1")
        let first = BackgroundPresencePolicy.sync(
            wanted: [working],
            tracked: [:],
            context: context()
        )
        let second = BackgroundPresencePolicy.sync(
            wanted: [working],
            tracked: first.tracked,
            context: context()
        )
        XCTAssertTrue(second.commands.isEmpty)
        XCTAssertFalse(
            BackgroundPresencePolicy.shouldAlert(
                for: working,
                previousRequestId: "req-1",
                context: context()
            )
        )
    }

    func testDisabledActivitiesEndsTracked() {
        let tracked = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .working)],
            tracked: [:],
            context: context()
        ).tracked
        let plan = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .working)],
            tracked: tracked,
            context: context(activitiesEnabled: false)
        )
        XCTAssertEqual(plan.commands, [.end(botId: "bot-1")])
        XCTAssertTrue(plan.tracked.isEmpty)
    }

    func testUnsupportedNotificationsStillSyncWithoutAlerts() {
        let plan = BackgroundPresencePolicy.sync(
            wanted: [bot(kind: .needsYou, requestId: "req-1")],
            tracked: [:],
            context: context(notificationsEnabled: false)
        )
        XCTAssertEqual(plan.commands.count, 1)
        guard case .start = plan.commands[0] else {
            return XCTFail("expected start")
        }
        XCTAssertFalse(
            BackgroundPresencePolicy.shouldAlert(
                for: bot(kind: .needsYou, requestId: "req-1"),
                previousRequestId: nil,
                context: context(notificationsEnabled: false)
            )
        )
    }

    func testTwoMinuteExpiryEndsBackgroundActivity() {
        let working = bot(kind: .working)
        let tracked = BackgroundPresencePolicy.sync(
            wanted: [working],
            tracked: [:],
            context: context()
        ).tracked
        let backgroundedAt = now.addingTimeInterval(-BackgroundPresencePolicy.lingerDuration)
        let plan = BackgroundPresencePolicy.sync(
            wanted: [],
            tracked: tracked,
            context: context(
                isBackground: true,
                hydrated: false,
                backgroundedAt: backgroundedAt,
                now: now
            )
        )
        XCTAssertEqual(plan.commands, [.end(botId: "bot-1")])
        XCTAssertTrue(plan.tracked.isEmpty)
    }

    func testStreamLingerMatchesPresenceDurationWhileBackgrounded() {
        XCTAssertEqual(
            BackgroundPresencePolicy.streamLingerSeconds(isBackground: true),
            BackgroundPresencePolicy.lingerDuration
        )
        XCTAssertEqual(BackgroundPresencePolicy.streamLingerSeconds(isBackground: false), 0)
    }
}
