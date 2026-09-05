import XCTest
@testable import CompanionCore

final class GlobalStylePresentationPolicyTests: XCTestCase {
    func testPublicCopyUsesGlobalStyleAndNeverHouseStyle() {
        XCTAssertEqual(GlobalStylePresentationPolicy.sectionTitle, "Global style")
        XCTAssertFalse(GlobalStylePresentationPolicy.sectionTitle.localizedCaseInsensitiveContains("house"))
        XCTAssertFalse(GlobalStylePresentationPolicy.sectionFooter.localizedCaseInsensitiveContains("house"))
        XCTAssertFalse(GlobalStylePresentationPolicy.sectionFooter.contains("[house-style: off]"))
        XCTAssertEqual(GlobalStylePresentationPolicy.instructionsAccessibilityLabel, "Global style instructions")
        XCTAssertFalse(GlobalStylePresentationPolicy.instructionsAccessibilityLabel.localizedCaseInsensitiveContains("house"))
    }

    func testGlobalStyleAppliesByDefaultWhenEnabled() {
        let config = ConfigStatus(
            houseStyle: HouseStyleStatus(enabled: true, instructions: "Keep answers succinct.")
        )
        XCTAssertTrue(GlobalStylePresentationPolicy.applies(config: config, instructions: "Be helpful."))
        XCTAssertEqual(
            GlobalStylePresentationPolicy.statusDescription(config: config, instructions: "Be helpful."),
            "Global style applies to this bot."
        )
    }

    func testGlobalStyleDoesNotApplyWhenDisabledInSettings() {
        let config = ConfigStatus(
            houseStyle: HouseStyleStatus(enabled: false, instructions: "Keep answers succinct.")
        )
        XCTAssertFalse(GlobalStylePresentationPolicy.applies(config: config, instructions: "Be helpful."))
        XCTAssertEqual(
            GlobalStylePresentationPolicy.statusDescription(config: config, instructions: "Be helpful."),
            "Global style is turned off in Settings."
        )
    }

    func testBotOptOutSuppressesGlobalStyle() {
        let config = ConfigStatus(
            houseStyle: HouseStyleStatus(enabled: true, instructions: "Keep answers succinct.")
        )

        let instructionsWithLegacyMarker = "You are a pirate.\n[house-style: off]"
        XCTAssertTrue(GlobalStylePresentationPolicy.isOptedOut(instructions: instructionsWithLegacyMarker))
        XCTAssertFalse(GlobalStylePresentationPolicy.applies(config: config, instructions: instructionsWithLegacyMarker))
        XCTAssertEqual(
            GlobalStylePresentationPolicy.statusDescription(config: config, instructions: instructionsWithLegacyMarker),
            "Global style is turned off for this bot."
        )

        let instructionsWithGlobalMarker = "You are a pirate.\n[global-style: off]"
        XCTAssertTrue(GlobalStylePresentationPolicy.isOptedOut(instructions: instructionsWithGlobalMarker))
        XCTAssertFalse(GlobalStylePresentationPolicy.applies(config: config, instructions: instructionsWithGlobalMarker))
        XCTAssertEqual(
            GlobalStylePresentationPolicy.statusDescription(config: config, instructions: instructionsWithGlobalMarker),
            "Global style is turned off for this bot."
        )
    }

    func testStripAndComposeOptOutMarkersWithoutExposingInternalImplementation() {
        let textWithMarker = "Friendly and direct.\n[house-style: off]"
        XCTAssertEqual(
            GlobalStylePresentationPolicy.stripOptOutMarkers(from: textWithMarker),
            "Friendly and direct."
        )

        let textWithGlobalMarker = "Friendly and direct.\n[global-style: off]"
        XCTAssertEqual(
            GlobalStylePresentationPolicy.stripOptOutMarkers(from: textWithGlobalMarker),
            "Friendly and direct."
        )

        let composedEnabled = GlobalStylePresentationPolicy.composeInstructions(
            userText: "Friendly and direct.",
            applyGlobalStyle: true
        )
        XCTAssertEqual(composedEnabled, "Friendly and direct.")
        XCTAssertFalse(composedEnabled.contains("[house-style: off]"))

        let composedDisabled = GlobalStylePresentationPolicy.composeInstructions(
            userText: "Friendly and direct.",
            applyGlobalStyle: false
        )
        XCTAssertEqual(composedDisabled, "Friendly and direct.\n[house-style: off]")
        XCTAssertTrue(GlobalStylePresentationPolicy.isOptedOut(instructions: composedDisabled))
    }
}
