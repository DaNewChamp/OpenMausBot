import XCTest
@testable import CompanionCore

final class WorkCardPresentationTests: XCTestCase {
    func testMessageDecodesOptionalProviderNeutralWorkMetadata() throws {
        let json = #"""
        {
          "id":"work-1","role":"bot","kind":"text","at":1,
          "text":"Implemented the change.",
          "work": {
            "title":"Provider-neutral work cards",
            "status":"ready for review",
            "branch":"feat/work-card",
            "prNumber":42,
            "filesChanged":3,
            "additions":18,
            "deletions":4,
            "prUrl":"https://github.com/example/project/pull/42",
            "cursorUrl":"cursor://open?file=%2Ftmp%2Fproject"
          }
        }
        """#

        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        let work = try XCTUnwrap(message.work)
        XCTAssertEqual(work.title, "Provider-neutral work cards")
        XCTAssertEqual(work.status, "ready for review")
        XCTAssertEqual(work.branch, "feat/work-card")
        XCTAssertEqual(work.prNumber, 42)
        XCTAssertEqual(work.filesChanged, 3)
        XCTAssertEqual(work.additions, 18)
        XCTAssertEqual(work.deletions, 4)
        XCTAssertEqual(work.prURL, "https://github.com/example/project/pull/42")
        XCTAssertEqual(work.cursorURL, "cursor://open?file=%2Ftmp%2Fproject")
        XCTAssertEqual(message.text, "Implemented the change.")
    }

    func testOrdinaryMessageAndMalformedWorkMetadataRemainDecodable() throws {
        let ordinary = #"{"id":"ordinary","role":"bot","kind":"text","at":1,"text":"hello"}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(ordinary.utf8))
        XCTAssertNil(message.work)

        let malformed = #"{"id":"malformed","role":"bot","kind":"text","at":1,"text":"hello","work":"future-shape"}"#
        let fallback = try JSONDecoder().decode(Message.self, from: Data(malformed.utf8))
        XCTAssertNil(fallback.work)
        XCTAssertEqual(fallback.text, "hello")

        let user = #"{"id":"user-work","role":"user","kind":"text","at":1,"text":"hello","work":{"title":"ignored"}}"#
        let userMessage = try JSONDecoder().decode(Message.self, from: Data(user.utf8))
        XCTAssertEqual(userMessage.text, "hello")
    }

    func testWorkCardPresentationRequiresHTTPSPRURL() throws {
        let work = WorkCard(
            title: "Review",
            status: "ready",
            branch: "main",
            prNumber: 7,
            filesChanged: 1,
            additions: 2,
            deletions: 1,
            prURL: "https://github.com/example/project/pull/7"
        )
        let valid = WorkCardPresentation(work: work, canOpenCursor: false)
        XCTAssertEqual(valid.pullRequestURL?.absoluteString, work.prURL)
        XCTAssertTrue(valid.showsViewPR)

        for raw in [
            "http://github.com/example/project/pull/7",
            "javascript:alert(1)",
            "https://",
            "https://user:pass@example.com/pull/7",
            "https://"
        ] {
            let invalid = WorkCard(
                title: "Review", status: nil, branch: nil, prNumber: nil,
                filesChanged: nil, additions: nil, deletions: nil, prURL: raw
            )
            let presentation = WorkCardPresentation(work: invalid, canOpenCursor: false)
            XCTAssertNil(presentation.pullRequestURL, raw)
            XCTAssertFalse(presentation.showsViewPR, raw)
        }
    }

    func testCursorActionRequiresValidDeepLinkAndCanOpenURL() {
        let work = WorkCard(
            title: "Review", status: nil, branch: nil, prNumber: nil,
            filesChanged: nil, additions: nil, deletions: nil,
            prURL: nil, cursorURL: "cursor://open?file=%2Ftmp%2Fproject"
        )
        XCTAssertFalse(WorkCardPresentation(work: work, canOpenCursor: false).showsOpenInCursor)
        XCTAssertTrue(WorkCardPresentation(work: work, canOpenCursor: true).showsOpenInCursor)

        let invalid = WorkCard(
            title: "Review", status: nil, branch: nil, prNumber: nil,
            filesChanged: nil, additions: nil, deletions: nil,
            prURL: nil, cursorURL: "https://example.com/not-cursor"
        )
        XCTAssertFalse(WorkCardPresentation(work: invalid, canOpenCursor: true).showsOpenInCursor)
    }

    func testMissingDisplayMetadataDoesNotCreateAWorkCard() {
        let work = WorkCard(
            title: nil, status: nil, branch: nil, prNumber: nil,
            filesChanged: nil, additions: nil, deletions: nil,
            prURL: nil, cursorURL: nil
        )
        XCTAssertFalse(WorkCardPresentation(work: work, canOpenCursor: true).isRenderable)
    }
}
