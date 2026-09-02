import XCTest
@testable import CompanionCore

final class HermesConversionConfirmationPolicyTests: XCTestCase {
    func testModelPickerRequiresConfirmationBeforeApply() {
        XCTAssertTrue(HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: true))
        XCTAssertFalse(HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: false))
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
