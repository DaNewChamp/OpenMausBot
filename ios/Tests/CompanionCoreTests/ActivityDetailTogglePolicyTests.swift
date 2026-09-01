import XCTest
@testable import CompanionCore

final class ActivityDetailTogglePolicyTests: XCTestCase {
    func testGlobalToggleOnForReducedAndLegacyFull() {
        XCTAssertTrue(ActivityDetailTogglePolicy.globalShowsToolActivity(.reduced))
        XCTAssertTrue(ActivityDetailTogglePolicy.globalShowsToolActivity(.full))
        XCTAssertFalse(ActivityDetailTogglePolicy.globalShowsToolActivity(.hidden))
    }

    func testGlobalToggleOffWritesHiddenOn() {
        XCTAssertEqual(ActivityDetailTogglePolicy.globalStoredValue(showToolActivity: false), .hidden)
    }

    func testGlobalToggleOnAlwaysWritesReducedEvenFromLegacyFull() {
        XCTAssertEqual(
            ActivityDetailTogglePolicy.globalStoredValue(showToolActivity: true, previous: .full),
            .reduced
        )
        XCTAssertEqual(
            ActivityDetailTogglePolicy.globalStoredValue(showToolActivity: true, previous: .reduced),
            .reduced
        )
    }

    func testLegacyFullStaysFullUntilUserChangesToggle() {
        XCTAssertEqual(ActivityDetailTogglePolicy.storedValuePreservingLegacyFull(showToolActivity: true, previous: .full), .full)
        XCTAssertEqual(ActivityDetailTogglePolicy.storedValuePreservingLegacyFull(showToolActivity: false, previous: .full), .hidden)
        XCTAssertEqual(ActivityDetailTogglePolicy.storedValuePreservingLegacyFull(showToolActivity: true, previous: .full, userChanged: true), .reduced)
    }

    func testPerBotUsesGlobalWhenOverrideMissing() {
        XCTAssertTrue(ActivityDetailTogglePolicy.usesGlobalSetting(for: "thread-a", in: "{}"))
        XCTAssertFalse(ActivityDetailTogglePolicy.usesGlobalSetting(for: "thread-a", in: #"{"thread-a":"hidden"}"#))
    }

    func testPerBotOverrideToggleMapsToHiddenAndReduced() {
        let hidden = ActivityDetailTogglePolicy.perBotStoredValue(useGlobal: false, showToolActivity: false, previous: nil)
        XCTAssertEqual(hidden, .hidden)
        let reduced = ActivityDetailTogglePolicy.perBotStoredValue(useGlobal: false, showToolActivity: true, previous: .full)
        XCTAssertEqual(reduced, .reduced)
    }

    func testPerBotUseGlobalClearsOverride() {
        XCTAssertNil(ActivityDetailTogglePolicy.perBotStoredValue(useGlobal: true, showToolActivity: true, previous: .hidden))
    }

    func testPerBotShowsToolActivityReflectsOverrideOrGlobal() {
        XCTAssertFalse(ActivityDetailTogglePolicy.perBotShowsToolActivity(override: nil, global: .hidden))
        XCTAssertFalse(ActivityDetailTogglePolicy.perBotShowsToolActivity(override: .hidden, global: .reduced))
        XCTAssertTrue(ActivityDetailTogglePolicy.perBotShowsToolActivity(override: .full, global: .hidden))
    }
}
