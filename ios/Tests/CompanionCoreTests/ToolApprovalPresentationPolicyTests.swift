import XCTest
@testable import CompanionCore

final class ToolApprovalPresentationPolicyTests: XCTestCase {
    func testReadOnlyGitStatusCardPresentation() {
        let card = OptionCard(
            title: "Scout needs your approval",
            subtitle: "git status",
            options: ["Allow", "Deny", "Always allow"],
            requestId: "req-1",
            tool: "terminal",
            toolLabel: "Terminal",
            hostLabel: "Mac mini",
            actionSummary: "Run git status on Mac mini",
            details: "git status",
            executiveSummary: "Inspects repository status",
            changeSummary: "Nothing; read-only",
            riskLevel: "low",
            allowKey: "bridge:run_on_bridge:git"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "Scout", card: card)

        // 1. Compact card headline communicates actor / action / host
        XCTAssertEqual(presentation.headline, "Scout wants to run git status on Mac mini")

        // 2. Second line clearly says whether the requested tool changes anything
        XCTAssertEqual(presentation.changeDescription, "Does not change anything · read-only")
        XCTAssertTrue(presentation.isReadOnly)

        // 3. Details reveals raw tool / command / scope
        XCTAssertEqual(presentation.rawTool, "terminal")
        XCTAssertEqual(presentation.rawCommand, "git status")
        XCTAssertEqual(presentation.scope, "Mac mini (bridge:run_on_bridge:git)")

        let expectedDetails = """
        Tool: terminal
        Command: git status
        Scope: Mac mini (bridge:run_on_bridge:git)
        """
        XCTAssertEqual(presentation.detailsText, expectedDetails)
    }

    func testDestructiveCommandCardPresentation() {
        let card = OptionCard(
            title: "Worker needs your approval",
            subtitle: "rm -rf ./build",
            options: ["Allow", "Deny"],
            requestId: "req-2",
            tool: "terminal",
            toolLabel: "Terminal",
            hostLabel: "Mac mini",
            actionSummary: "Run a command on Mac mini",
            details: "rm -rf ./build",
            executiveSummary: "Deletes files or folders",
            changeSummary: "Deletes files or folders",
            riskLevel: "high"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "Worker", card: card)

        // 1. Compact card headline communicates actor / action / host
        XCTAssertEqual(presentation.headline, "Worker wants to run rm -rf ./build on Mac mini")

        // 2. Second line clearly says whether the requested tool changes anything
        XCTAssertEqual(presentation.changeDescription, "Changes files or system state · Deletes files or folders")
        XCTAssertFalse(presentation.isReadOnly)

        // 3. Details reveals raw tool / command / scope
        XCTAssertEqual(presentation.rawTool, "terminal")
        XCTAssertEqual(presentation.rawCommand, "rm -rf ./build")
        XCTAssertEqual(presentation.scope, "Mac mini")

        let expectedDetails = """
        Tool: terminal
        Command: rm -rf ./build
        Scope: Mac mini
        """
        XCTAssertEqual(presentation.detailsText, expectedDetails)
    }

    func testReadOnlyCommandWithGenericActionSummary() {
        let longCommand = "cd ~/Github/repo && git log -n 5 --oneline && git status --short"
        let card = OptionCard(
            title: "Scout needs your approval",
            subtitle: longCommand,
            options: ["Allow", "Deny"],
            requestId: "req-3",
            tool: "terminal",
            toolLabel: "Terminal",
            hostLabel: "Mac mini",
            actionSummary: "Run a read-only command on Mac mini",
            details: longCommand,
            executiveSummary: "Inspects Git log and status",
            changeSummary: "Nothing; read-only",
            riskLevel: "low"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "Scout", card: card)
        XCTAssertEqual(presentation.headline, "Scout wants to run a read-only command on Mac mini")
        XCTAssertEqual(presentation.changeDescription, "Does not change anything · read-only")
        XCTAssertTrue(presentation.isReadOnly)
        XCTAssertEqual(presentation.rawTool, "terminal")
        XCTAssertEqual(presentation.rawCommand, longCommand)
        XCTAssertEqual(presentation.scope, "Mac mini")
    }

    func testMutatingCommandWithBroadChanges() {
        let card = OptionCard(
            title: "Worker needs your approval",
            subtitle: "npm install",
            options: ["Allow", "Deny"],
            requestId: "req-4",
            tool: "terminal",
            toolLabel: "Terminal",
            hostLabel: "Mac mini",
            actionSummary: "Run a command on Mac mini",
            details: "npm install",
            executiveSummary: "Installs dependencies",
            changeSummary: "May create, modify, move, or delete data",
            riskLevel: "medium"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "Worker", card: card)
        XCTAssertEqual(presentation.headline, "Worker wants to run npm install on Mac mini")
        XCTAssertEqual(presentation.changeDescription, "Changes files or system state · May create, modify, move, or delete data")
        XCTAssertFalse(presentation.isReadOnly)
    }

    func testComputerToolPresentation() {
        let card = OptionCard(
            title: "Bot needs your approval",
            subtitle: "Click submit button",
            options: ["Allow", "Deny"],
            requestId: "req-5",
            tool: "mcp__ogb__computer_batch",
            toolLabel: "Computer",
            hostLabel: "Mac mini",
            actionSummary: "Use the computer on Mac mini",
            details: "Click submit button",
            executiveSummary: "Clicks the submit button",
            changeSummary: "May interact with an app or the desktop",
            riskLevel: "medium"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "Bot", card: card)
        XCTAssertEqual(presentation.headline, "Bot wants to use the computer on Mac mini")
        XCTAssertEqual(presentation.changeDescription, "Changes files or system state · May interact with an app or the desktop")
        XCTAssertFalse(presentation.isReadOnly)
        XCTAssertEqual(presentation.rawTool, "mcp__ogb__computer_batch")
        XCTAssertEqual(presentation.rawCommand, "Click submit button")
        XCTAssertEqual(presentation.scope, "Mac mini")
    }

    func testActorFallbackFromCardTitle() {
        let card = OptionCard(
            title: "Worker needs your approval",
            subtitle: "git status",
            options: ["Allow", "Deny"],
            requestId: "req-6",
            tool: "terminal",
            toolLabel: "Terminal",
            hostLabel: "Mac mini",
            actionSummary: "Run git status on Mac mini",
            details: "git status",
            changeSummary: "Nothing; read-only",
            riskLevel: "low"
        )

        let presentation = ToolApprovalPresentationPolicy.presentation(actor: "", card: card)
        XCTAssertEqual(presentation.headline, "Worker wants to run git status on Mac mini")
    }

    func testScopeFallbacks() {
        let cardWithOnlyResource = OptionCard(
            title: "Approval needed",
            subtitle: "cat secrets.txt",
            options: ["Allow", "Deny"],
            requestId: "req-7",
            tool: "Read",
            resourceSummary: "workspace files"
        )
        XCTAssertEqual(ToolApprovalPresentationPolicy.scope(for: cardWithOnlyResource), "workspace files")

        let cardWithoutScope = OptionCard(
            title: "Approval needed",
            subtitle: "test",
            options: ["Allow", "Deny"],
            requestId: "req-8",
            tool: "test_tool"
        )
        XCTAssertEqual(ToolApprovalPresentationPolicy.scope(for: cardWithoutScope), "local")
    }
}
