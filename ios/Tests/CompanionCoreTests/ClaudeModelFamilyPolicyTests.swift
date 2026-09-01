import XCTest
@testable import CompanionCore

final class ClaudeModelFamilyPolicyTests: XCTestCase {
    private func model(_ id: String, label: String? = nil, instanceId: String = "claude") -> MobileCatalogModel {
        MobileCatalogModel(
            id: id,
            label: label ?? id,
            instanceId: instanceId,
            isDefault: false
        )
    }

    func testCollapsesStandardAndThinkingIntoOneFamilyRow() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-sonnet-5", label: "Claude Sonnet 5"),
            model("claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking"),
            model("claude-haiku-4-5", label: "Claude Haiku 4.5"),
        ])

        XCTAssertEqual(rows.count, 2)
        let sonnet = rows.first { $0.standardModelId == "claude-sonnet-5" }
        XCTAssertNotNil(sonnet)
        XCTAssertEqual(sonnet?.oneMModelId, "claude-sonnet-5-thinking-high")
        XCTAssertEqual(sonnet?.label, "Claude Sonnet 5")
        XCTAssertTrue(sonnet?.showsOneMToggle == true)
        XCTAssertEqual(rows.map(\.standardModelId).sorted(), ["claude-haiku-4-5", "claude-sonnet-5"])
    }

    func testOneMToggleSelectsAdvertisedCounterpart() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-sonnet-5"),
            model("claude-sonnet-5-thinking-high"),
        ])
        let row = rows[0]
        XCTAssertEqual(row.selectedModelId(forOneMEnabled: false), "claude-sonnet-5")
        XCTAssertEqual(row.selectedModelId(forOneMEnabled: true), "claude-sonnet-5-thinking-high")
        XCTAssertEqual(row.oneMEnabled(for: "claude-sonnet-5-thinking-high"), true)
        XCTAssertEqual(row.oneMEnabled(for: "claude-sonnet-5"), false)
    }

    func testStandaloneModelHasNoOneMToggle() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [model("claude-haiku-4-5")])
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].oneMModelId)
        XCTAssertFalse(rows[0].showsOneMToggle)
    }

    func testOrphanSelectionGetsRecoveryRow() {
        let rows = ClaudeModelFamilyPolicy.compactRows(
            from: [model("claude-sonnet-5")],
            preservingSelection: "claude-custom-orphan"
        )
        XCTAssertEqual(rows.map(\.standardModelId), ["claude-sonnet-5", "claude-custom-orphan"])
        XCTAssertEqual(rows.last?.label, "Claude Custom Orphan")
        XCTAssertFalse(rows.last?.showsOneMToggle == true)
    }

    func testExplicitOneMPairUsesAdvertisedIdsOnly() {
        let rows = ClaudeModelFamilyPolicy.compactRows(from: [
            model("claude-opus-5"),
            model("claude-opus-5-1m"),
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].oneMModelId, "claude-opus-5-1m")
    }
}
