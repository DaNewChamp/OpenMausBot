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

    func testActiveKeyboardTransitionsToInactiveOnDismiss() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "echo hello")
        let next = VmKeyboardPresentationPolicy.transition(state: initial, event: .dismiss)
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testActiveKeyboardTransitionsToInactiveOnBack() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "cat file")
        let next = VmKeyboardPresentationPolicy.transition(state: initial, event: .back)
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testActiveKeyboardTransitionsToInactiveOnLeavingComputer() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "top")
        let next = VmKeyboardPresentationPolicy.transition(state: initial, event: .leavingComputer)
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testActiveKeyboardTransitionsToInactiveOnDestinationChange() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "ps aux")
        let next = VmKeyboardPresentationPolicy.transition(
            state: initial,
            event: .destinationChange(from: "vm", to: "cloud")
        )
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testKeyboardToggleTransitionsActiveToInactive() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "uname -a")
        let next = VmKeyboardPresentationPolicy.transition(
            state: initial,
            event: .toggle(canType: true)
        )
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testKeyboardToggleTransitionsInactiveToActiveWhenCanType() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: false, draftText: "")
        let next = VmKeyboardPresentationPolicy.transition(
            state: initial,
            event: .toggle(canType: true)
        )
        XCTAssertTrue(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testKeyboardToggleRemainsInactiveWhenCannotType() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: false, draftText: "")
        let next = VmKeyboardPresentationPolicy.transition(
            state: initial,
            event: .toggle(canType: false)
        )
        XCTAssertFalse(next.isPresented)
        XCTAssertEqual(next.draftText, "")
    }

    func testDestinationChangeToSameDestinationPreservesActiveState() {
        let initial = VmKeyboardPresentationPolicy.State(isPresented: true, draftText: "tail -f log")
        let next = VmKeyboardPresentationPolicy.transition(
            state: initial,
            event: .destinationChange(from: "vm", to: "vm")
        )
        XCTAssertTrue(next.isPresented)
        XCTAssertEqual(next.draftText, "tail -f log")
    }
}
