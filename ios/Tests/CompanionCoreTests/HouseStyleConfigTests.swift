// Config decode and patch encode for the house-style and provider-key
// sections of `configStatus()`.
//
// Fixtures/config.json is captured bytes that predate `houseStyle` and the
// `zai`/`xai`/`vps`/`opencodeGo` flags, so these tests carry inline JSON
// that mirrors server/index.ts `configStatus()` field for field. The moment
// the capture script is re-run against a hub with these sections, that
// fixture picks them up too and DecodingTests stays the wire-contract alarm.
import XCTest
@testable import CompanionCore

final class HouseStyleConfigTests: XCTestCase {
    private func decode(_ json: String) throws -> ConfigStatus {
        try JSONDecoder().decode(ConfigStatus.self, from: Data(json.utf8))
    }

    func testDecodesHouseStyleAndProviderConfiguredFlags() throws {
        let status = try decode("""
        {
          "xai": { "configured": false },
          "composio": { "configured": true, "mode": "cloud" },
          "box": { "configured": false },
          "vps": { "configured": true, "sshAlias": "vps" },
          "opencodeGo": { "configured": true },
          "zai": { "configured": true },
          "tts": { "configured": false, "ready": false, "voice": "" },
          "imageGen": { "configured": false },
          "profile": { "name": "Ada Lovelace", "email": "ada@example.com" },
          "permissions": { "defaultMode": "ask" },
          "houseStyle": {
            "enabled": true,
            "instructions": "Keep replies short and plain."
          }
        }
        """)

        XCTAssertEqual(status.houseStyle?.enabled, true)
        XCTAssertEqual(status.houseStyle?.instructions, "Keep replies short and plain.")
        XCTAssertEqual(status.zai?.configured, true)
        XCTAssertEqual(status.xai?.configured, false)
        XCTAssertEqual(status.opencodeGo?.configured, true)
        XCTAssertEqual(status.vps?.configured, true)
    }

    func testAConfigWithoutTheNewSectionsStillDecodes() throws {
        let status = try decode("""
        { "profile": { "name": "Ada Lovelace", "email": "ada@example.com" } }
        """)

        XCTAssertNil(status.houseStyle)
        XCTAssertNil(status.zai?.configured)
        XCTAssertNil(status.xai?.configured)
    }

    func testHouseStylePatchEncodesTheNarrowBody() throws {
        let data = try JSONEncoder().encode(HouseStylePatch(enabled: false, instructions: "No greetings."))
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["enabled", "instructions"])
        XCTAssertEqual(body["enabled"] as? Bool, false)
        XCTAssertEqual(body["instructions"] as? String, "No greetings.")
    }

    func testAKeyPatchIsWriteOnlyAndEnvelopesDecodeServerAnswers() throws {
        let keyData = try JSONEncoder().encode(ZAIKeyPatch(apiKey: "zai-key"))
        let keyBody = try XCTUnwrap(try JSONSerialization.jsonObject(with: keyData) as? [String: Any])
        XCTAssertEqual(Set(keyBody.keys), ["apiKey"])
        XCTAssertEqual(keyBody["apiKey"] as? String, "zai-key")

        let houseJSON = """
        {"houseStyle": {"enabled": false, "instructions": "No greetings."}}
        """
        let house = try JSONDecoder().decode(HouseStyleEnvelope.self, from: Data(houseJSON.utf8))
        XCTAssertEqual(house.houseStyle.enabled, false)

        let zaiJSON = """
        {"zai": {"configured": true}}
        """
        let zai = try JSONDecoder().decode(ZAIKeyEnvelope.self, from: Data(zaiJSON.utf8))
        XCTAssertEqual(zai.zai.configured, true)
    }
}
