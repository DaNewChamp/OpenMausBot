import XCTest
@testable import CompanionCore

final class HermesConversionConfirmationPolicyTests: XCTestCase {
    func testModelPickerRequiresConfirmationBeforeApply() {
        XCTAssertTrue(HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: true))
        XCTAssertFalse(HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: false))
    }

    func testEndpointSelectionHasNoPreConfirmationSideEffects() {
        XCTAssertFalse(HermesConversionConfirmationPolicy.shouldPersistDefaultOnEndpointSelection())
        XCTAssertFalse(HermesConversionConfirmationPolicy.shouldApplyRuntimeOnEndpointSelection())
    }

    func testCancelClearsDraftWithoutChangingPersistedDefault() {
        let persisted = HermesEndpointOption(
            id: "local:default",
            computerName: "This computer",
            profile: "default"
        )
        let draft = HermesEndpointOption(
            id: "local:coder",
            computerName: "This computer",
            profile: "coder"
        )
        XCTAssertNil(HermesConversionConfirmationPolicy.draftEndpointAfterCancel())
        XCTAssertEqual(
            HermesConversionConfirmationPolicy.endpointForConfirmedConversion(
                draft: HermesConversionConfirmationPolicy.draftEndpointAfterCancel(),
                persistedDefault: persisted
            )?.id,
            persisted.id
        )
        XCTAssertNotEqual(draft.id, persisted.id)
    }

    func testConfirmedConversionUsesDraftEndpointAndPersistsDefault() {
        let persisted = HermesEndpointOption(
            id: "local:default",
            computerName: "This computer",
            profile: "default"
        )
        let draft = HermesEndpointOption(
            id: "bridge:bridge-mini:research",
            computerName: "Mac mini",
            profile: "research"
        )
        XCTAssertTrue(HermesConversionConfirmationPolicy.shouldPersistDefaultOnConfirmedConversion())
        XCTAssertEqual(
            HermesConversionConfirmationPolicy.endpointForConfirmedConversion(
                draft: draft,
                persistedDefault: persisted
            )?.id,
            draft.id
        )
        XCTAssertEqual(
            HermesConversionConfirmationPolicy.endpointForConfirmedConversion(
                draft: nil,
                persistedDefault: persisted
            )?.id,
            persisted.id
        )
    }

    func testApplyRequestHonorsContextHandoffChoice() {
        let endpoint = HermesEndpointOption(
            id: "local:coder",
            computerName: "This computer",
            profile: "coder"
        )
        let withSummary = HermesConversionConfirmationPolicy.applyRequest(
            endpoint: endpoint,
            includeContextSummary: true
        )
        XCTAssertEqual(withSummary.contextMode, "summary")

        let withoutSummary = HermesConversionConfirmationPolicy.applyRequest(
            endpoint: endpoint,
            includeContextSummary: false
        )
        XCTAssertEqual(withoutSummary.contextMode, "none")
        XCTAssertEqual(withoutSummary.kind, "local")
        XCTAssertEqual(withoutSummary.profile, "coder")
    }

    func testContextHandoffCopyNeverMentionsSecrets() {
        for copy in [
            HermesConversionConfirmationPolicy.contextHandoffDetail,
            HermesConversionConfirmationPolicy.preservedSummary,
        ] {
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("token"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("api_key"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("secret"))
        }
    }
}
