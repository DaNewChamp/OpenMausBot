import CoreGraphics
import XCTest
@testable import CompanionCore

final class VmInteractionPolicyTests: XCTestCase {
    func testTrackpadCursorUsesFingerTranslationFromExistingCursor() {
        let cursor = VmInteractionPolicy.trackpadCursor(
            initialCursor: CGPoint(x: 120, y: 80),
            startLocation: CGPoint(x: 30, y: 40),
            location: CGPoint(x: 55, y: 10),
            bounds: CGRect(x: 10, y: 5, width: 200, height: 150)
        )

        XCTAssertEqual(cursor, CGPoint(x: 145, y: 50))
    }

    func testTrackpadCursorClampsToRenderedDesktopBounds() {
        let cursor = VmInteractionPolicy.trackpadCursor(
            initialCursor: CGPoint(x: 120, y: 80),
            startLocation: CGPoint(x: 30, y: 40),
            location: CGPoint(x: -500, y: 900),
            bounds: CGRect(x: 10, y: 5, width: 200, height: 150)
        )

        XCTAssertEqual(cursor, CGPoint(x: 10, y: 155))
    }

    func testPinnedCaptionUsesBotNameOnly() {
        XCTAssertEqual(PinnedChatCaptionPolicy.caption(name: "Chief Keef", title: "S-M"), "Chief Keef")
        XCTAssertEqual(PinnedChatCaptionPolicy.caption(name: "Chief Keef", title: ""), "Chief Keef")
    }
}
