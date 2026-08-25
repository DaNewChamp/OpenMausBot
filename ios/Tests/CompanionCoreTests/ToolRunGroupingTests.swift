// Consecutive tool activities fold into one disclosure. The view half —
// chevrons, the spinner — needs a simulator. The grouping, the labels, and
// the open-state rules are the decisions, and they have to stay independent
// of SwiftUI so a chat with twenty tool chips cannot silently become twenty
// cards again.
import XCTest
@testable import CompanionCore

final class ToolRunGroupingTests: XCTestCase {
    func text(_ id: String, at: Double = 1, role: Message.Role = .user) -> Message {
        var message = Message(id: id, role: role, kind: .text, at: at)
        message.text = id
        return message
    }

    func activity(
        _ id: String,
        name: String,
        ok: Bool? = nil,
        spoken: String? = nil,
        at: Double = 1,
        comm: CommChip? = nil
    ) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, ok: ok, spoken: spoken, setup: nil)
        message.comm = comm
        return message
    }

    func run(_ messages: Message...) -> ToolRun {
        ToolRun(messages: messages)
    }

    func segments(_ messages: Message...) -> [TranscriptSegment] {
        ToolRunGrouping.segments(in: messages)
    }

    // MARK: - Folding

    func testEmptyTranscriptProducesNothing() {
        XCTAssertEqual(ToolRunGrouping.segments(in: []), [])
    }

    func testPlainMessagesStayMessages() {
        let user = text("u")
        let bot = text("b", role: .bot)
        XCTAssertEqual(segments(user, bot), [.message(user), .message(bot)])
    }

    func testConsecutiveActivitiesFoldIntoOneRun() {
        let user = text("u")
        let a = activity("a", name: "WebSearch", ok: true, spoken: "searching the web")
        let b = activity("b", name: "WebFetch", ok: true, spoken: "reading a page")
        let c = activity("c", name: "Read", ok: true, spoken: "reading a file")
        let reply = text("r", role: .bot)

        XCTAssertEqual(
            segments(user, a, b, c, reply),
            [.message(user), .toolRun(run(a, b, c)), .message(reply)]
        )
    }

    func testATextBetweenActivitiesStartsANewRun() {
        let a = activity("a", name: "Bash", ok: true, spoken: "running a command")
        let note = text("n", role: .bot)
        let b = activity("b", name: "Read", ok: true, spoken: "reading a file")

        XCTAssertEqual(
            segments(a, note, b),
            [.toolRun(run(a)), .message(note), .toolRun(run(b))]
        )
    }

    func testActivitiesFromDifferentRoomBotsDoNotFoldTogether() {
        let ada = Sender(botId: "ada", name: "Ada", color: "orange")
        let grace = Sender(botId: "grace", name: "Grace", color: "blue")
        var a = activity("a", name: "Read", ok: true, spoken: "reading a file")
        var b = activity("b", name: "Bash", ok: true, spoken: "running a command")
        a.from = ada
        b.from = grace

        XCTAssertEqual(segments(a, b), [.toolRun(run(a)), .toolRun(run(b))])
    }

    func testActivitiesAcrossANewConversationStretchDoNotFoldTogether() {
        let a = activity("a", name: "Read", ok: true, spoken: "reading a file", at: 1)
        let b = activity("b", name: "Bash", ok: true, spoken: "running a command", at: 30 * 60 * 1_000 + 2)

        XCTAssertEqual(segments(a, b), [.toolRun(run(a)), .toolRun(run(b))])
    }

    func testACommChipIsNotAToolRunAndBreaksTheFold() {
        let comm = CommChip(
            groupId: "g1",
            withBotId: "other",
            withName: "Ada",
            withColor: "orange"
        )
        let a = activity("a", name: "Bash", ok: true, spoken: "running a command")
        let chip = activity("c", name: "Messaged Ada", ok: true, comm: comm)
        let b = activity("b", name: "Read", ok: true, spoken: "reading a file")

        XCTAssertEqual(
            segments(a, chip, b),
            [.toolRun(run(a)), .message(chip), .toolRun(run(b))]
        )
    }

    func testATurnErrorIsNotAToolRunAndBreaksTheFold() {
        let a = activity("a", name: "Bash", ok: true, spoken: "running a command")
        let err = activity("e", name: "error: claude exited 1")
        let b = activity("b", name: "Read", ok: true, spoken: "reading a file")

        XCTAssertEqual(
            segments(a, err, b),
            [.toolRun(run(a)), .message(err), .toolRun(run(b))]
        )
    }

    func testAnActivityWithoutAToolStaysAMessage() {
        var empty = Message(id: "e", role: .bot, kind: .activity, at: 1)
        empty.tool = nil
        let a = activity("a", name: "Bash", ok: true, spoken: "running a command")

        XCTAssertEqual(
            ToolRunGrouping.segments(in: [empty, a]),
            [.message(empty), .toolRun(run(a))]
        )
    }

    func testCardsAndScreensBreakTheFold() {
        var card = Message(id: "card", role: .bot, kind: .options, at: 2)
        card.card = OptionCard(title: "Allow?", subtitle: "", options: ["Allow", "Deny"])
        var screen = Message(id: "shot", role: .bot, kind: .screen, at: 4)
        screen.hasImage = true
        let a = activity("a", name: "Bash", ok: true, spoken: "running a command", at: 1)
        let b = activity("b", name: "Read", ok: true, spoken: "reading a file", at: 3)
        let c = activity("c", name: "Grep", ok: true, spoken: "searching", at: 5)

        XCTAssertEqual(
            ToolRunGrouping.segments(in: [a, card, b, screen, c]),
            [.toolRun(run(a)), .message(card), .toolRun(run(b)), .message(screen), .toolRun(run(c))]
        )
    }

    /// Search jumps to a message id. Folding chips must not drop those ids
    /// or the landing has nowhere to scroll.
    func testEveryMessageIdRemainsAddressableAfterFolding() {
        let messages = [
            text("u"),
            activity("a", name: "Bash", ok: true, spoken: "running a command"),
            activity("b", name: "Read", ok: nil, spoken: "reading a file"),
            text("r", role: .bot),
        ]
        let ids = ToolRunGrouping.segments(in: messages).flatMap { segment -> [String] in
            switch segment {
            case .message(let message): return [message.id]
            case .toolRun(let run): return run.messageIds
            }
        }
        XCTAssertEqual(ids, messages.map(\.id))
    }

    func testARunKeepsTheFirstMessageIdAsItsStableIdentity() {
        let first = activity("a1", name: "WebSearch", ok: true, spoken: "searching the web")
        let second = activity("a2", name: "WebFetch", ok: nil, spoken: "reading a page")
        XCTAssertEqual(run(first).id, "a1")
        XCTAssertEqual(run(first, second).id, "a1")
    }

    // MARK: - Live row

    func testUnsettledWorkUsesTheLatestFriendlyLabel() {
        let done = activity("a", name: "WebSearch", ok: true, spoken: "searching the web")
        let live = activity("b", name: "WebFetch", ok: nil, spoken: "reading a page")
        let grouped = run(done, live)

        XCTAssertFalse(grouped.isSettled)
        XCTAssertEqual(grouped.headerTitle, "reading a page")
        XCTAssertFalse(grouped.headerTitle.contains("Worked"))
    }

    func testUnsettledWorkFallsBackWhenTheLatestSpokenLabelIsMissing() {
        let live = activity("a", name: "mystery_tool", ok: nil)
        XCTAssertEqual(run(live).headerTitle, "Used a tool")
    }

    // MARK: - Settled summary

    func testSeveralSettledSuccessesCollapseToWorkedSteps() {
        let a = activity("a", name: "WebSearch", ok: true, spoken: "searching the web", at: 1_000)
        let b = activity("b", name: "WebFetch", ok: true, spoken: "reading a page", at: 8_000)
        let c = activity("c", name: "Read", ok: true, spoken: "reading a file", at: 13_000)
        let grouped = run(a, b, c)

        XCTAssertTrue(grouped.isSettled)
        XCTAssertFalse(grouped.hasFailure)
        XCTAssertEqual(grouped.headerTitle, "Worked · 3 steps")
        XCTAssertFalse(grouped.headerTitle.localizedCaseInsensitiveContains("sec"))
        XCTAssertFalse(grouped.headerTitle.contains("ms"))
        XCTAssertFalse(grouped.headerTitle.contains("12"))
        XCTAssertFalse(grouped.headerTitle.contains("for"))
    }

    func testASingleSuccessStaysCompact() {
        let one = activity("a", name: "WebSearch", ok: true, spoken: "searching the web")
        let grouped = run(one)

        XCTAssertEqual(grouped.headerTitle, "searching the web")
        XCTAssertFalse(grouped.headerTitle.contains("Worked"))
        XCTAssertFalse(grouped.headerTitle.contains("step"))
    }

    func testASingleSuccessWithoutSpokenStaysACompactGeneric() {
        XCTAssertEqual(run(activity("a", name: "mystery_tool", ok: true)).headerTitle, "Used a tool")
    }

    func testFailureHeaderNeverClaimsTheRunWorked() {
        let single = run(activity("a", name: "Bash", ok: false, spoken: "running a command"))
        let mixed = run(
            activity("b", name: "Read", ok: true, spoken: "reading a file"),
            activity("c", name: "Bash", ok: false, spoken: "running a command")
        )

        XCTAssertEqual(single.headerTitle, "Failed · running a command")
        XCTAssertEqual(mixed.headerTitle, "2 steps · 1 failed")
        XCTAssertFalse(mixed.headerTitle.contains("Worked"))
    }

    // MARK: - Friendly labels

    func testSpokenLabelsWinWhenTheyAreSafe() {
        let tool = ToolActivity(name: "mcp__github__list_issues", ok: true, spoken: "checking issues", setup: nil)
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: tool), "checking issues")
        XCTAssertEqual(tool.name, "mcp__github__list_issues")
    }

    func testMissingSpokenUsesASafeGenericFallbackNotTheRawName() {
        let tool = ToolActivity(name: "mcp__github__list_issues", ok: true, spoken: nil, setup: nil)
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: tool), "Used a tool")
        XCTAssertNotEqual(ToolRunGrouping.displayLabel(for: tool), tool.name)
    }

    func testBlankSpokenUsesTheGenericFallback() {
        let tool = ToolActivity(name: "Bash", ok: true, spoken: "   ", setup: nil)
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: tool), "Used a tool")
    }

    func testUnsafeSpokenLooksLikeACommandAndIsNotShown() {
        let quoted = ToolActivity(
            name: "Bash",
            ok: true,
            spoken: "curl -X POST \"https://example/x\" --data @{}",
            setup: nil
        )
        let dollars = ToolActivity(name: "Bash", ok: true, spoken: "echo $HOME | rm -rf", setup: nil)
        let backticks = ToolActivity(name: "Bash", ok: true, spoken: "run `ls -la`", setup: nil)
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: quoted), "Used a tool")
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: dollars), "Used a tool")
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: backticks), "Used a tool")
    }

    func testLongOrMultilineSpokenLabelsCannotGrowTheCollapsedRow() {
        let long = ToolActivity(name: "Bash", ok: true, spoken: String(repeating: "a", count: 81), setup: nil)
        let multiline = ToolActivity(name: "Bash", ok: true, spoken: "running\na command", setup: nil)
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: long), "Used a tool")
        XCTAssertEqual(ToolRunGrouping.displayLabel(for: multiline), "Used a tool")
    }

    func testExpandedStepsKeepFriendlyLabelsAndRawNamesApart() {
        let grouped = run(
            activity("a", name: "WebSearch", ok: true, spoken: "searching the web"),
            activity("b", name: "mcp__computer__click", ok: true, spoken: "using the computer")
        )
        XCTAssertEqual(
            grouped.steps.map(ToolRunGrouping.displayLabel(for:)),
            ["searching the web", "using the computer"]
        )
        XCTAssertEqual(grouped.steps.map(\.name), ["WebSearch", "mcp__computer__click"])
    }

    // MARK: - Open state

    func testFailuresExpandByDefaultAndSuccessesDoNot() {
        let ok = run(activity("ok", name: "Read", ok: true, spoken: "reading a file"))
        let failed = run(activity("bad", name: "Bash", ok: false, spoken: "running a command"))
        let mixed = run(
            activity("a", name: "Read", ok: true, spoken: "reading a file"),
            activity("b", name: "Bash", ok: false, spoken: "running a command")
        )

        XCTAssertFalse(ToolRunGrouping.isExpandedByDefault(ok))
        XCTAssertTrue(ToolRunGrouping.isExpandedByDefault(failed))
        XCTAssertTrue(ToolRunGrouping.isExpandedByDefault(mixed))
        XCTAssertFalse(ToolRunGrouping.isExpanded(ok, opened: [], closed: []))
        XCTAssertTrue(ToolRunGrouping.isExpanded(failed, opened: [], closed: []))
    }

    func testUnsettledWorkDoesNotAutoExpand() {
        let live = run(activity("a", name: "Read", ok: nil, spoken: "reading a file"))
        XCTAssertFalse(ToolRunGrouping.isExpandedByDefault(live))
        XCTAssertFalse(ToolRunGrouping.isExpanded(live, opened: [], closed: []))
    }

    func testManualOpenPersistsOnACollapsedSuccess() {
        let grouped = run(
            activity("a", name: "WebSearch", ok: true, spoken: "searching the web"),
            activity("b", name: "Read", ok: true, spoken: "reading a file")
        )
        XCTAssertTrue(ToolRunGrouping.isExpanded(grouped, opened: ["a"], closed: []))
        XCTAssertTrue(ToolRunGrouping.isExpanded(grouped, opened: ["a"], closed: ["a"]))
    }

    func testManualClosePersistsOnAnAutoExpandedFailure() {
        let grouped = run(activity("bad", name: "Bash", ok: false, spoken: "running a command"))
        XCTAssertFalse(ToolRunGrouping.isExpanded(grouped, opened: [], closed: ["bad"]))
    }

    func testOpenStateKeysOffTheStableRunIdAsStepsArrive() {
        let first = activity("a1", name: "WebSearch", ok: true, spoken: "searching the web")
        let growing = run(first, activity("a2", name: "Read", ok: nil, spoken: "reading a file"))
        XCTAssertTrue(ToolRunGrouping.isExpanded(growing, opened: ["a1"], closed: []))
        XCTAssertEqual(growing.id, first.id)
    }
}
