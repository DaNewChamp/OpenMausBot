import XCTest
@testable import CompanionCore

final class EngineSyncTests: XCTestCase {
    func testMissingEngineSyncDefaultsMutationsToOpenMaus() {
        XCTAssertEqual(VBotMutationRouting.target(for: nil), .openmaus)
        XCTAssertEqual(VBotMutationRouting.composerCapabilities(for: nil), .openmaus)
        XCTAssertEqual(VBotEngineSync.openMausOnly.selectedEngine, .openmaus)
        XCTAssertEqual(VBotEngineSync.openMausOnly.servingEngine, .openmaus)
    }

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
        XCTAssertTrue(sync.usesReconstructedMutations)
        XCTAssertFalse(sync.reconstructedMutationsReady)
        XCTAssertEqual(sync.fallbackCode, "installed-not-running")
        XCTAssertEqual(sync.bots.count, 1)
        XCTAssertEqual(sync.groups.first?.memberIds, ["bot_1"])
        XCTAssertEqual(sync.modelCapabilities?.canStop, true)

        let body = try JSONEncoder().encode(VBotPrimaryEnginePatch(primaryEngine: .grokReconstructed))
        let json = try JSONSerialization.jsonObject(with: body) as? [String: String]
        XCTAssertEqual(json, ["primaryEngine": "grokReconstructed"])
    }

    func testDecodesReconstructedRouterAndTypedError() throws {
        let sync = try JSONDecoder().decode(
            VBotEngineSync.self,
            from: Data(
                """
                {
                  "primaryEngine":"grokReconstructed",
                  "activeSource":"grokReconstructed",
                  "fallback":false,
                  "engines":[],
                  "bots":[],
                  "groups":[],
                  "modelCapabilities":{"defaultModel":"grok-4.5","models":[],"sendPrompt":true,"images":false,"queueing":false,"steer":true,"stop":false,"attachments":false},
                  "router":{
                    "scope":"host",
                    "perBotSelection":false,
                    "currentProvider":"cursor",
                    "currentModelId":"grok-4.5",
                    "providers":[{"id":"cursor","label":"Cursor","current":true,"selectable":true,"modelSelectable":true,"models":[{"id":"grok-4.5","current":true,"selectable":true}]}],
                    "selected":{"provider":"cursor","modelId":"grok-4.5","scope":"host"}
                  }
                }
                """.utf8
            )
        )
        XCTAssertTrue(sync.reconstructedMutationsReady)
        XCTAssertEqual(sync.router?.selected.provider, "cursor")
        XCTAssertEqual(sync.modelCapabilities?.canStop, false)
        XCTAssertEqual(sync.router?.asInstances.first?.instanceId, "cursor")
        XCTAssertEqual(sync.router?.asInstances.first?.allowsModelChange, true)
        XCTAssertEqual(sync.router?.asInstances.first?.allowsInstanceChange, true)

        let error = try JSONDecoder().decode(
            VBotEngineErrorBody.self,
            from: Data(#"{"error":"This action stays on Grok Reconstructed and cannot fall back to OpenMaus.","code":"engine-mutation-blocked"}"#.utf8)
        )
        XCTAssertEqual(error.code, "engine-mutation-blocked")

        let patch = try JSONEncoder().encode(VBotRouterPatch(provider: "cursor", modelId: "grok-4.6"))
        let patchJSON = try JSONSerialization.jsonObject(with: patch) as? [String: String]
        XCTAssertEqual(patchJSON, ["provider": "cursor", "modelId": "grok-4.6"])
    }

    func testRefreshOrderingIgnoresStaleAsyncResults() {
        XCTAssertEqual(EngineSyncPolicy.nextGeneration(after: 4), 5)
        XCTAssertTrue(EngineSyncPolicy.shouldApply(startedGeneration: 5, currentGeneration: 5))
        XCTAssertFalse(EngineSyncPolicy.shouldApply(startedGeneration: 4, currentGeneration: 5))
        XCTAssertFalse(EngineSyncPolicy.shouldApply(startedGeneration: 6, currentGeneration: 5))
    }

    func testCatalogSourceAndFallbackDisplay() throws {
        XCTAssertEqual(EngineSyncPolicy.catalogSource(for: nil), .unknown)
        XCTAssertEqual(EngineSyncPolicy.catalogSource(for: .openMausOnly), .advertised)
        XCTAssertFalse(EngineSyncPolicy.hostWideSelection(.openMausOnly))

        let fallback = try JSONDecoder().decode(
            VBotEngineSync.self,
            from: Data("""
            {
              "primaryEngine":"grokReconstructed",
              "activeSource":"openmaus",
              "fallback":true,
              "fallbackReason":"Installed but not running.",
              "engines":[],
              "bots":[],
              "groups":[]
            }
            """.utf8)
        )
        XCTAssertEqual(
            EngineSyncPolicy.catalogSource(for: fallback),
            .reconstructedUnavailable("Installed but not running.")
        )
        XCTAssertEqual(EngineSyncPolicy.fallbackReason(for: fallback), "Installed but not running.")
        XCTAssertEqual(EngineSyncPolicy.displayEngineName(fallback), VBotPrimaryEngine.openmaus.displayName)
        XCTAssertTrue(EngineSyncPolicy.hostWideSelection(fallback))

        let ready = try JSONDecoder().decode(
            VBotEngineSync.self,
            from: Data("""
            {
              "primaryEngine":"grokReconstructed",
              "activeSource":"grokReconstructed",
              "fallback":false,
              "engines":[],
              "bots":[],
              "groups":[],
              "modelCapabilities":{"defaultModel":"x","models":[],"sendPrompt":true,"images":false,"queueing":false,"steer":true,"stop":true,"attachments":false},
              "router":{
                "scope":"host","perBotSelection":false,
                "currentProvider":"alpha","currentModelId":"alpha-1",
                "providers":[{"id":"alpha","label":"Alpha","current":true,"selectable":true,"modelSelectable":false,"models":[{"id":"alpha-1","current":true,"selectable":false}]}],
                "selected":{"provider":"alpha","modelId":"alpha-1","scope":"host"}
              }
            }
            """.utf8)
        )
        XCTAssertEqual(EngineSyncPolicy.catalogSource(for: ready), .reconstructed)
        XCTAssertTrue(EngineSyncPolicy.hostWideSelection(ready))
        XCTAssertFalse(ready.router?.asInstances.first?.allowsModelChange ?? true)
        XCTAssertEqual(EngineSyncPolicy.fallbackReason(for: ready), nil)
        XCTAssertEqual(EngineSyncPolicy.displayEngineName(ready), VBotPrimaryEngine.grokReconstructed.displayName)
    }

    func testBusyTransitionAndMissingModelStayHonest() {
        let instance = Instance(
            instanceId: "alpha",
            driverKind: "alpha",
            displayName: "Alpha",
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(default: "alpha-1", options: [ModelOption(id: "alpha-1", label: "Alpha 1")])
        )
        XCTAssertTrue(EngineSyncPolicy.modelAvailable("alpha-1", in: instance))
        XCTAssertFalse(EngineSyncPolicy.modelAvailable("gone", in: instance))
        XCTAssertFalse(EngineSyncPolicy.modelAvailable("alpha-1", in: nil))
        XCTAssertTrue(ModelSelectionPolicy.shouldRevertDraft(wasWorking: false, isWorking: true))
        XCTAssertTrue(ModelSelectionPolicy.allowsSwitch(working: false))
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: true))
    }
}
