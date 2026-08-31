import XCTest
@testable import CompanionCore

final class ApprovalReviewerTests: XCTestCase {
    func testModeLabelsMatchDesktopCopy() {
        XCTAssertEqual(ApprovalReviewerMode.off.label, "Off")
        XCTAssertEqual(ApprovalReviewerMode.whenUnclear.label, "When unclear")
        XCTAssertEqual(ApprovalReviewerMode.always.label, "Always")
        XCTAssertEqual(ApprovalReviewerMode.whenUnclear.rawValue, "when-unclear")
    }

    func testDecodesReviewerStatusWithoutSecrets() throws {
        let json = """
        {
          "mode": "when-unclear",
          "selection": { "instanceId": "openaiCompat", "model": "llama" },
          "providers": [
            {
              "id": "openrouter",
              "label": "OpenRouter",
              "instanceId": "openaiCompat",
              "available": true,
              "configured": true,
              "reason": null,
              "models": [{ "id": "llama", "label": "Llama" }]
            },
            {
              "id": "openai",
              "label": "OpenAI",
              "instanceId": "codex",
              "available": false,
              "configured": true,
              "reason": "Codex CLI has no no-tools or ask mode for isolated review.",
              "models": [{ "id": "gpt-5.4", "label": "GPT-5.4" }]
            }
          ]
        }
        """
        let status = try JSONDecoder().decode(ApprovalReviewerStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.mode, .whenUnclear)
        XCTAssertEqual(status.selection?.instanceId, "openaiCompat")
        XCTAssertEqual(status.providers.count, 2)
        XCTAssertEqual(status.providers[0].available, true)
        XCTAssertEqual(status.providers[1].available, false)
        XCTAssertEqual(status.providers[1].reason, "Codex CLI has no no-tools or ask mode for isolated review.")
        let encoded = String(data: try JSONEncoder().encode(status), encoding: .utf8) ?? ""
        XCTAssertFalse(encoded.contains("apiKey"))
        XCTAssertFalse(encoded.contains("cliCandidates"))
        XCTAssertFalse(encoded.contains("https://"))
    }

    func testPatchOmitsNilSelectionKeys() throws {
        let patch = ApprovalReviewerPatch(mode: .off)
        let data = try JSONEncoder().encode(patch)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["mode"] as? String, "off")
        XCTAssertNil(object?["instanceId"])
        XCTAssertNil(object?["model"])
        XCTAssertEqual(object?.count, 1)
    }
}
