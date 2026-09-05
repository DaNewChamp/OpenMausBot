import XCTest
@testable import CompanionCore

final class ProviderCatalogPolicyTests: XCTestCase {
    func testNamedProviderOrderIsExact() {
        XCTAssertEqual(
            ProviderCatalogPolicy.namedOrder,
            ["openai", "claude", "cursor", "openrouter", "grok-auth"]
        )
    }

    func testOpenAIPreferredModelOrderIsStable() {
        XCTAssertEqual(
            ProviderCatalogPolicy.preferredOpenAIModelOrder,
            ["gpt-5.6-sol", "gpt-5.6-sol-1m", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]
        )
    }

    func testOpenAICatalogKeepsEveryAdvertisedModelAndRanksPreferredFirst() {
        let catalog = ProviderCatalogPolicy.catalog(from: [
            instance(
                id: "codex",
                driver: "codex",
                name: "Codex",
                models: [
                    ("gpt-5.5", "old label"),
                    ("gpt-5.6-terra", "Terra"),
                    ("gpt-4.1", "Retired"),
                    ("gpt-5.6-sol-1m", "Sol 1M"),
                    ("gpt-5.6-sol", "Sol"),
                ]
            ),
            instance(
                id: "codex-offline",
                driver: "codex",
                name: "Codex Offline",
                models: [("gpt-5.6-luna", "Luna")],
                state: "offline"
            ),
        ])

        let ids = catalog.providers.first { $0.id == "openai" }?.models.map(\.id) ?? []
        XCTAssertEqual(Array(ids.prefix(5)), ["gpt-5.6-sol", "gpt-5.6-sol-1m", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"])
        XCTAssertTrue(ids.contains("gpt-4.1"), "Do not hide advertised models behind a preferred whitelist")
        XCTAssertTrue(ids.contains("gpt-5.6-luna"), "Unavailable sources stay visible and annotated")
        let luna = catalog.providers.first { $0.id == "openai" }?.models.first { $0.id == "gpt-5.6-luna" }
        XCTAssertEqual(luna?.instanceId, "codex-offline")
    }

    func testMissingCurrentSelectionStaysVisible() {
        let advertised = [
            instance(
                id: "codex",
                driver: "codex",
                name: "Codex",
                models: [("gpt-5.6-sol", "GPT-5.6 Sol"), ("gpt-5.4", "GPT-5.4")]
            )
        ]
        let rails = ProviderCatalogPolicy.groupedInstances(
            advertised: advertised,
            selection: ModelSelection(instanceId: "codex", model: "retired-gpt")
        )

        XCTAssertTrue(ProviderCatalogPolicy.shouldDisplaySelection(
            ModelSelection(instanceId: "codex", model: "retired-gpt"),
            advertised: advertised
        ))
        XCTAssertTrue(rails.contains { rail in
            rail.models.options.contains { $0.id == "retired-gpt" && ($0.instanceId ?? rail.instanceId) == "codex" }
                || rail.instanceId == "codex"
        })
    }

    func testRoutesOpenAIClaudeCursorOpenRouterAndGrokAuth() {
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "codex", driverKind: "codex", modelId: "gpt-5.6-sol"),
            "openai"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "cursor", driverKind: "cursorAgent", modelId: "gpt-5.3-codex"),
            "openai"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "claude", driverKind: "claudeAgent", modelId: "claude-sonnet-5"),
            "claude"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(
                instanceId: "cursor",
                driverKind: "cursorAgent",
                modelId: "claude-sonnet-5-thinking-high"
            ),
            "claude"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "cursor", driverKind: "cursorAgent", modelId: "auto"),
            "cursor"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "cursor", driverKind: "cursorAgent", modelId: "composer-2.5"),
            "cursor"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(
                instanceId: "openai-compat",
                driverKind: "openai-compat",
                modelId: "meta-llama/llama-3.3-70b-instruct"
            ),
            "openrouter"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "grok", driverKind: "grokAgent", modelId: "grok-4.6"),
            "grok-auth"
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.classifyProvider(instanceId: "cursor", driverKind: "cursorAgent", modelId: "grok-4.6"),
            "cursor"
        )
    }

    func testRenamesBareAutoToCursorAuto() {
        XCTAssertEqual(
            ProviderCatalogPolicy.normalizeModelLabel(modelId: "auto", label: "Auto", providerId: "cursor"),
            "Cursor Auto"
        )
        XCTAssertEqual(AdvertisedModelCatalog.displayModelLabel("auto"), "Cursor Auto")
    }

    func testUnknownProvidersAppearAfterNamedOrder() {
        let catalog = ProviderCatalogPolicy.catalog(from: [
            instance(id: "gemini", driver: "geminiAgent", name: "Gemini", models: [("gemini-3.5-flash", "Gemini 3.5 Flash")]),
            instance(id: "grok", driver: "grokAgent", name: "Grok", models: [("grok-4.6", "Grok 4.6")]),
            instance(
                id: "openai-compat",
                driver: "openai-compat",
                name: "OpenRouter",
                models: [("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B")]
            ),
            instance(
                id: "cursor",
                driver: "cursorAgent",
                name: "Cursor",
                models: [
                    ("auto", "Auto"),
                    ("composer-2.5", "Composer 2.5"),
                    ("gpt-5.3-codex", "Codex 5.3"),
                    ("claude-sonnet-5-thinking-high", "Claude Sonnet 5"),
                ]
            ),
            instance(id: "codex", driver: "codex", name: "Codex", models: [("gpt-5.6-sol", "GPT-5.6 Sol")]),
            instance(id: "other-a", driver: "minimax", name: "MiniMax", models: [("minimax-m3", "MiniMax M3")]),
            instance(id: "claude", driver: "claudeAgent", name: "Claude", models: [("claude-haiku-4-5", "Claude Haiku 4.5")]),
        ])

        XCTAssertEqual(
            catalog.providers.map(\.id),
            ["openai", "claude", "cursor", "openrouter", "grok-auth", "google", "minimax"]
        )
        XCTAssertEqual(
            catalog.providers.prefix(5).map(\.label),
            ["OpenAI", "Claude", "Cursor", "OpenRouter", "Grok Auth"]
        )
        XCTAssertEqual(catalog.providers.first { $0.id == "openai" }?.models.map(\.id), ["gpt-5.6-sol", "gpt-5.3-codex"])
        XCTAssertEqual(catalog.providers.first { $0.id == "cursor" }?.models.map(\.id), ["auto", "composer-2.5"])
        XCTAssertEqual(catalog.providers.first { $0.id == "cursor" }?.models.first?.label, "Cursor Auto")
        XCTAssertFalse(catalog.providers.contains(where: { $0.label == "GPT-5.6 Sol" }))
        XCTAssertFalse(catalog.providers.contains(where: { $0.id == "codex" }))
    }

    func testSelectionSurvivesRefreshAndFallsBackDeterministically() {
        let advertised = [
            instance(
                id: "codex",
                driver: "codex",
                name: "Codex",
                models: [("gpt-5.6-sol", "GPT-5.6 Sol"), ("gpt-5.4", "GPT-5.4")],
                defaultId: "gpt-5.6-sol"
            ),
            instance(
                id: "cursor",
                driver: "cursorAgent",
                name: "Cursor",
                models: [("auto", "Auto"), ("composer-2.5", "Composer 2.5")]
            ),
        ]
        XCTAssertEqual(
            ProviderCatalogPolicy.resolveSelection(
                ModelSelection(instanceId: "cursor", model: "composer-2.5"),
                in: advertised
            ),
            ModelSelection(instanceId: "cursor", model: "composer-2.5")
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.resolveSelection(
                ModelSelection(instanceId: "codex", model: "retired-gpt"),
                in: advertised
            ),
            ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.resolveSelection(
                ModelSelection(instanceId: "gone", model: "gone-1"),
                in: advertised
            ),
            ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )
    }

    func testSerializedMobileCatalogOmitsSecretFields() {
        let catalog = ProviderCatalogPolicy.catalog(from: [
            instance(id: "cursor", driver: "cursorAgent", name: "Cursor", models: [("auto", "Auto")]),
        ])
        XCTAssertTrue(ProviderCatalogPolicy.serializedCatalogOmitsSecrets(catalog))
        let data = try? JSONEncoder().encode(catalog)
        let json = String(data: data ?? Data(), encoding: .utf8) ?? ""
        XCTAssertFalse(json.localizedCaseInsensitiveContains("apiKey"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("api_key"))
        XCTAssertFalse(json.contains("cliCandidates"))
        XCTAssertFalse(json.contains("install"))
        XCTAssertEqual(catalog.managedBy, "Managed by your V Bot server.")
    }

    func testProviderTapDoesNotSelectOrSaveAModel() {
        let advertised = [
            instance(id: "codex", driver: "codex", name: "Codex", models: [("gpt-5.6-sol", "GPT-5.6 Sol")]),
        ]
        let current = ModelSelection(instanceId: "cursor", model: "auto")
        let rails = ProviderCatalogPolicy.groupedInstances(advertised: advertised, selection: current)
        let openai = rails.first { $0.instanceId == "openai" }
        XCTAssertNil(
            ProviderCatalogPolicy.selectionAfterProviderTap(
                current: current,
                tapped: openai!,
                advertised: advertised
            )
        )
        XCTAssertEqual(current.instanceId, "cursor")
        XCTAssertEqual(current.model, "auto")
    }

    func testGroupedOpenAIRowsUseCompositeIdentityForDuplicateModelIds() {
        let advertised = [
            instance(id: "droid", driver: "droidAgent", name: "Droid", models: [("gpt-5.6-sol", "GPT-5.6 Sol")], state: "offline"),
            instance(id: "codex", driver: "codex", name: "Codex", models: [("gpt-5.6-sol", "GPT-5.6 Sol")]),
        ]
        let catalog = ProviderCatalogPolicy.catalog(from: advertised)
        let models = catalog.providers.first { $0.id == "openai" }?.models ?? []
        XCTAssertEqual(models.filter { $0.id == "gpt-5.6-sol" }.count, 2)
        XCTAssertEqual(Set(models.map { ProviderCatalogPolicy.rowIdentity($0) }).count, models.count)
        let rail = ProviderCatalogPolicy.groupedInstances(
            advertised: advertised,
            selection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        ).first { $0.instanceId == "openai" }
        XCTAssertEqual(
            ProviderCatalogPolicy.selectionAfterModelTap(
                current: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
                rail: rail,
                modelId: "gpt-5.6-sol",
                sourceInstanceId: "codex"
            )?.instanceId,
            "codex"
        )
        XCTAssertNotEqual(
            ProviderCatalogPolicy.selectionAfterModelTap(
                current: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
                rail: rail,
                modelId: "gpt-5.6-sol"
            )?.instanceId,
            "droid"
        )
    }

    private func instance(
        id: String,
        driver: String,
        name: String,
        models: [(String, String)],
        defaultId: String? = nil,
        state: String = "available"
    ) -> Instance {
        Instance(
            instanceId: id,
            driverKind: driver,
            displayName: name,
            snapshot: ProviderSnapshot(state: state, reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(
                default: defaultId ?? models.first?.0 ?? "",
                options: models.map { ModelOption(id: $0.0, label: $0.1) }
            )
        )
    }
}
