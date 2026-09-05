import XCTest
@testable import CompanionCore

/// Reworked: thinking suffixes are not 1M counterparts. Family fold lives on
/// `ModelFamilyPolicy`; this file keeps the Claude-facing regressions that
/// the old `ClaudeModelFamilyPolicy` got wrong.
final class ClaudeModelFamilyPolicyTests: XCTestCase {
    func testCollapsesStandardAndThinkingIntoOneFamilyWithoutFakeOneM() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-sonnet-5", label: "Claude Sonnet 5"),
            model("claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking"),
            model("claude-haiku-4-5", label: "Claude Haiku 4.5"),
        ])

        XCTAssertEqual(Set(rows.map(\.familyKey)), ["claude-sonnet-5", "claude-haiku-4-5"])
        let sonnet = rows.first { $0.familyKey == "claude-sonnet-5" }
        XCTAssertEqual(sonnet?.label, "Claude Sonnet 5")
        XCTAssertFalse(sonnet?.showsOneMToggle == true, "Thinking must not be treated as a 1M counterpart")
        XCTAssertTrue(sonnet?.showsThinkingToggle == true)
    }

    func testExplicitOneMPairUsesAdvertisedIdsOnly() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-opus-5", label: "Claude Opus 5"),
            model("claude-opus-5-1m", label: "Claude Opus 5 1M"),
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].familyKey, "claude-opus-5")
        XCTAssertTrue(rows[0].showsOneMToggle)
        XCTAssertEqual(rows[0].selectedModelId(oneMEnabled: false, thinking: false, fast: false, effort: nil), "claude-opus-5")
        XCTAssertEqual(rows[0].selectedModelId(oneMEnabled: true, thinking: false, fast: false, effort: nil), "claude-opus-5-1m")
    }

    func testStandaloneModelHasNoOneMOrThinkingToggle() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [model("claude-haiku-4-5")])
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(rows[0].showsOneMToggle)
        XCTAssertFalse(rows[0].showsThinkingToggle)
    }

    func testOrphanSelectionGetsRecoveryRow() {
        let rows = ClaudeModelFamilyPolicy.compactRows(
            from: [model("claude-sonnet-5")],
            preservingSelection: "claude-custom-orphan"
        )
        XCTAssertTrue(rows.contains { $0.familyKey == "claude-sonnet-5" })
        XCTAssertTrue(rows.contains { $0.rawModelIds.contains("claude-custom-orphan") })
        XCTAssertEqual(rows.last?.label, "Claude Custom Orphan")
        XCTAssertFalse(rows.last?.showsOneMToggle == true)
    }

    func testThinkingHighFastUsesExactAdvertisedId() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-opus-5-low", label: "Claude Opus 5 1M Low"),
            model("claude-opus-5-thinking-high", label: "Claude Opus 5 1M Thinking"),
            model("claude-opus-5-thinking-high-fast", label: "Claude Opus 5 1M Thinking Fast"),
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(
            rows[0].selectedModelId(oneMEnabled: false, thinking: true, fast: true, effort: "high"),
            "claude-opus-5-thinking-high-fast"
        )
        XCTAssertNil(rows[0].selectedModelId(oneMEnabled: true, thinking: true, fast: true, effort: "high"))
    }

    private func model(_ id: String, label: String? = nil, instanceId: String = "claude") -> MobileCatalogModel {
        MobileCatalogModel(
            id: id,
            label: label ?? id,
            instanceId: instanceId,
            isDefault: false
        )
    }
}
