import XCTest
@testable import CompanionCore

final class EngineSyncTests: XCTestCase {
    func testDecodesEngineSyncAndPrimaryEnginePatch() throws {
        let sync = try JSONDecoder().decode(
            VBotEngineSync.self,
            from: Data(
                """
                {
                  "primaryEngine":"grokReconstructed",
                  "activeSource":"openmaus",
                  "fallback":true,
                  "fallbackCode":"installed-not-running",
                  "fallbackReason":"Grok Bot 0.18 Reconstructed is installed but not running. Open that desktop app to enable this engine.",
                  "engines":[
                    {"id":"openmaus","displayName":"OpenMaus","state":"available"},
                    {"id":"grokReconstructed","displayName":"Grok Reconstructed","state":"unavailable","code":"installed-not-running","reason":"installed"}
                  ],
                  "bots":[{"id":"bot_1","label":"Scout"}],
                  "groups":[{"id":"room_1","label":"Ops","memberIds":["bot_1"]}],
                  "modelCapabilities":{"defaultModel":"","models":[],"sendPrompt":true,"images":true,"queueing":true,"steer":true,"attachments":true}
                }
                """.utf8
            )
        )
        XCTAssertEqual(sync.selectedEngine, .grokReconstructed)
        XCTAssertEqual(sync.servingEngine, .openmaus)
        XCTAssertTrue(sync.fallback)
        XCTAssertEqual(sync.fallbackCode, "installed-not-running")
        XCTAssertEqual(sync.bots.count, 1)
        XCTAssertEqual(sync.groups.first?.memberIds, ["bot_1"])

        let body = try JSONEncoder().encode(VBotPrimaryEnginePatch(primaryEngine: .grokReconstructed))
        let json = try JSONSerialization.jsonObject(with: body) as? [String: String]
        XCTAssertEqual(json, ["primaryEngine": "grokReconstructed"])
    }
}
