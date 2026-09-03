import XCTest
@testable import CompanionCore

final class HermesRuntimeCopyPolicyTests: XCTestCase {
    func testGlobalScreenExplainsControlPlaneAndOptionalRuntime() {
        let copy = HermesSetupPresentationPolicy.controlPlaneCopy
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("v bot"))
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("control plane"))
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("optional"))
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("runtime"))
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("paired") || copy.localizedCaseInsensitiveContains("computer"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("convert all"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("secret"))
    }

    func testGlobalDefaultIsForNewHermesBotsOnly() {
        XCTAssertEqual(
            HermesSetupPresentationPolicy.defaultForNewBotsTitle,
            "Default for new Hermes bots"
        )
        let detail = HermesSetupPresentationPolicy.defaultForNewBotsDetail
        XCTAssertTrue(detail.localizedCaseInsensitiveContains("new"))
        XCTAssertTrue(detail.localizedCaseInsensitiveContains("existing"))
        XCTAssertFalse(detail.localizedCaseInsensitiveContains("convert all"))
        XCTAssertFalse(HermesSetupPresentationPolicy.globalDefaultSelectionConvertsExistingBots)
        XCTAssertTrue(HermesSetupPresentationPolicy.persistDefaultOnGlobalSelection)
        XCTAssertFalse(HermesConversionConfirmationPolicy.shouldPersistDefaultOnConfirmedConversion())
    }

    func testConnectedCopyDoesNotImplyConvertingExistingBots() {
        let presentation = HermesSetupPresentationPolicy.presentation(
            status: HermesSetupStatus(state: .connected, profiles: [
                HermesSetupProfile(
                    profile: "chief",
                    handle: "chief",
                    displayName: "Chief",
                    description: "Chief",
                    botId: "bot-chief"
                ),
            ]),
            isLoading: false
        )
        XCTAssertEqual(presentation.title, "Hermes connected")
        XCTAssertFalse(presentation.message.localizedCaseInsensitiveContains("convert"))
        XCTAssertFalse(presentation.message.localizedCaseInsensitiveContains("all bots"))
    }

    func testPerBotSettingsUsePlainLanguageRuntimeCopy() {
        XCTAssertEqual(HermesRuntimePresentationPolicy.perBotSectionTitle, "AI runtime")
        XCTAssertEqual(HermesRuntimePresentationPolicy.useHermesForThisBotTitle, "Use Hermes for this bot")
        XCTAssertEqual(
            HermesRuntimePresentationPolicy.currentRuntimeLabel(
                isHermes: false,
                endpointLabel: "Mac mini / research",
                providerLabel: "Claude"
            ),
            "Claude"
        )
        XCTAssertEqual(
            HermesRuntimePresentationPolicy.currentRuntimeLabel(
                isHermes: true,
                endpointLabel: "Mac mini / research",
                providerLabel: "Claude"
            ),
            "Mac mini / research"
        )
    }

    func testConversionConfirmationNamesBotTargetAndOnlyThisBot() {
        let copy = HermesConversionConfirmationPolicy.confirmationCopy(
            botName: "Chief",
            computerName: "Mac mini",
            profile: "research"
        )
        XCTAssertTrue(copy.summary.contains("Chief"))
        XCTAssertTrue(copy.summary.contains("Mac mini"))
        XCTAssertTrue(copy.summary.contains("research"))
        XCTAssertTrue(copy.onlyThisBot.localizedCaseInsensitiveContains("only this bot"))
        XCTAssertTrue(copy.preserved.localizedCaseInsensitiveContains("name"))
        XCTAssertTrue(copy.preserved.localizedCaseInsensitiveContains("avatar"))
        XCTAssertTrue(copy.preserved.localizedCaseInsensitiveContains("rooms"))
        XCTAssertTrue(copy.preserved.localizedCaseInsensitiveContains("history"))
        XCTAssertFalse(copy.summary.localizedCaseInsensitiveContains("all bots"))
        XCTAssertFalse(copy.summary.localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(HermesConversionConfirmationPolicy.shouldPersistDefaultOnConfirmedConversion())
    }

    func testConversionSummaryStillPreservesIdentityWithoutSecrets() {
        let summary = HermesRuntimePresentationPolicy.conversionSummary(
            botName: "Helper",
            sourceLabel: "Claude",
            destinationLabel: "Mac mini / research"
        )
        XCTAssertTrue(summary.contains("Helper"))
        XCTAssertTrue(summary.contains("Mac mini / research"))
        XCTAssertTrue(summary.localizedCaseInsensitiveContains("only this bot"))
        XCTAssertTrue(summary.localizedCaseInsensitiveContains("avatar"))
        XCTAssertTrue(summary.localizedCaseInsensitiveContains("name"))
        XCTAssertTrue(summary.localizedCaseInsensitiveContains("rooms"))
        XCTAssertTrue(summary.localizedCaseInsensitiveContains("history"))
        XCTAssertFalse(summary.contains("token"))
        XCTAssertFalse(summary.contains("HERMES_HOME"))
    }

    func testGlobalDefaultSelectionDoesNotEmitConversionRequests() {
        let endpoint = HermesEndpointOption(
            id: "local:coder",
            computerName: "This computer",
            profile: "coder"
        )
        XCTAssertTrue(HermesConversionSheetPolicy.globalDefaultRequests(endpoint: endpoint).isEmpty)
        XCTAssertFalse(HermesSetupPresentationPolicy.globalDefaultSelectionConvertsExistingBots)
    }
}
