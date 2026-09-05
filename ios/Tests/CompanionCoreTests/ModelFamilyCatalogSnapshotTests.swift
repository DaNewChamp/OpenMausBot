import XCTest
@testable import CompanionCore

final class ModelFamilyCatalogSnapshotTests: XCTestCase {
    func testCapturedCatalogRoundtripsEveryAdvertisedVariant() throws {
        let instances = try loadCapturedCatalog()
        let advertised = advertisedTuples(in: instances)
        XCTAssertGreaterThanOrEqual(advertised.count, 200)

        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "cursor", model: "auto")
        )

        let openai = catalog.families.filter { $0.providerId == "openai" }
        let claude = catalog.families.filter { $0.providerId == "claude" }
        XCTAssertLessThan(openai.count, 40, "OpenAI 93-option catalog must collapse into families")
        XCTAssertLessThan(claude.count, 40, "Claude 108-option catalog must collapse into families")
        XCTAssertGreaterThanOrEqual(openai.count, 8)
        XCTAssertGreaterThanOrEqual(claude.count, 8)

        var seen = Set<String>()
        for family in catalog.families {
            for source in family.sources {
                for variant in source.variants {
                    XCTAssertEqual(ModelFamilyPolicy.parse(variant.modelId).familyKey, family.key, variant.modelId)
                    XCTAssertEqual(variant.instanceId, source.instanceId)
                    XCTAssertTrue(seen.insert(variant.id).inserted, "Duplicate UI id \(variant.id)")
                    XCTAssertEqual(
                        variant.id,
                        ModelFamilyPolicy.compositeId(instanceId: variant.instanceId, modelId: variant.modelId)
                    )
                }
            }
        }

        for tuple in advertised {
            XCTAssertTrue(
                seen.contains(ModelFamilyPolicy.compositeId(instanceId: tuple.instanceId, modelId: tuple.modelId)),
                "Lost advertised model \(tuple.instanceId) \(tuple.modelId)"
            )
        }

        XCTAssertEqual(seen.count, advertised.count)
    }

    func testEveryCursorOpenAIAndClaudeOptionRoundtripsThroughExactLookup() throws {
        let instances = try loadCapturedCatalog()
        let cursor = try XCTUnwrap(instances.first { $0.instanceId == "cursor" })
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "cursor", model: "auto")
        )

        var openaiCount = 0
        var claudeCount = 0
        for option in cursor.models.options {
            let provider = ProviderCatalogPolicy.classifyProvider(
                instanceId: cursor.instanceId,
                driverKind: cursor.driverKind,
                modelId: option.id
            )
            guard provider == "openai" || provider == "claude" else { continue }
            if provider == "openai" { openaiCount += 1 } else { claudeCount += 1 }

            let parsed = ModelFamilyPolicy.parse(option.id)
            let family = try XCTUnwrap(
                catalog.families.first { $0.providerId == provider && $0.key == parsed.familyKey },
                option.id
            )
            let resolved = ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "cursor",
                effort: parsed.axes.effort,
                thinking: parsed.axes.thinking,
                fast: parsed.axes.fast,
                oneM: parsed.axes.explicitOneM
            )
            XCTAssertEqual(resolved?.modelId, option.id, option.id)
            XCTAssertEqual(resolved?.instanceId, "cursor", option.id)
        }
        XCTAssertEqual(openaiCount, 83)
        XCTAssertEqual(claudeCount, 98)
    }

    func testDuplicateIdsAcrossOfflineDroidCodexAndCursorStayOnTheirSource() throws {
        let instances = try loadCapturedCatalog()
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )
        let family = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.6-sol" && $0.providerId == "openai" })
        let ids = Set(family.sources.map(\.instanceId))
        XCTAssertTrue(ids.contains("codex"))
        XCTAssertTrue(ids.contains("droid"))
        XCTAssertTrue(ids.contains("cursor"))

        let droid = try XCTUnwrap(family.sources.first { $0.instanceId == "droid" })
        XCTAssertFalse(droid.available)
        XCTAssertEqual(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "codex",
                effort: nil,
                thinking: false,
                fast: false,
                oneM: false
            )?.instanceId,
            "codex"
        )
        XCTAssertNotEqual(
            ModelFamilyPolicy.compositeId(instanceId: "codex", modelId: "gpt-5.6-sol"),
            ModelFamilyPolicy.compositeId(instanceId: "droid", modelId: "gpt-5.6-sol")
        )
    }

    func testThinkingFastEffortCombinationsStayOnAdvertisedIds() throws {
        let instances = try loadCapturedCatalog()
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "cursor", model: "claude-opus-5-thinking-high")
        )
        let family = try XCTUnwrap(catalog.families.first { $0.key == "claude-opus-5" && $0.providerId == "claude" })

        XCTAssertEqual(
            ModelFamilyPolicy.resolveVariant(
                in: family, instanceId: "cursor", effort: "high", thinking: true, fast: false, oneM: false
            )?.modelId,
            "claude-opus-5-thinking-high"
        )
        XCTAssertEqual(
            ModelFamilyPolicy.resolveVariant(
                in: family, instanceId: "cursor", effort: "high", thinking: true, fast: true, oneM: false
            )?.modelId,
            "claude-opus-5-thinking-high-fast"
        )
        XCTAssertEqual(
            ModelFamilyPolicy.resolveVariant(
                in: family, instanceId: "cursor", effort: "low", thinking: false, fast: true, oneM: false
            )?.modelId,
            "claude-opus-5-low-fast"
        )
        XCTAssertNil(
            ModelFamilyPolicy.resolveVariant(
                in: family, instanceId: "claude", effort: "high", thinking: true, fast: true, oneM: false
            ),
            "Native Claude does not advertise thinking-fast; do not invent it"
        )
    }

    func testOnlyOneMAndLabelOnlyContextSemanticsOnCapturedCatalog() throws {
        let instances = try loadCapturedCatalog()
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )
        let sol = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.6-sol" && $0.providerId == "openai" })
        let codex = try XCTUnwrap(sol.sources.first { $0.instanceId == "codex" })
        XCTAssertEqual(
            ModelFamilyPolicy.contextClaim(for: codex.variants),
            .none,
            "Captured Codex Sol has no explicit -1m id"
        )

        let cursorSol = try XCTUnwrap(sol.sources.first { $0.instanceId == "cursor" })
        XCTAssertEqual(
            ModelFamilyPolicy.contextClaim(for: cursorSol.variants),
            .included,
            "All Cursor Sol variants advertise 1M in their labels"
        )
        XCTAssertFalse(
            catalog.families.contains { family in
                family.sources.contains { ModelFamilyPolicy.contextClaim(for: $0.variants) == .toggle }
            },
            "This captured catalog has no unambiguous -1m ID pairs"
        )

        let gpt55 = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.5" && $0.providerId == "openai" })
        let cursor55 = try XCTUnwrap(gpt55.sources.first { $0.instanceId == "cursor" })
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: cursor55.variants), .none)
    }

    func testNoConstructedModelIdsLeaveTheCatalog() throws {
        let instances = try loadCapturedCatalog()
        let advertised = Set(advertisedTuples(in: instances).map { "\($0.instanceId)\u{1F}\($0.modelId)" })
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "cursor", model: "auto")
        )
        for family in catalog.families {
            for source in family.sources {
                for variant in source.variants {
                    XCTAssertTrue(
                        advertised.contains("\(variant.instanceId)\u{1F}\(variant.modelId)"),
                        "Catalog invented \(variant.instanceId) \(variant.modelId)"
                    )
                }
            }
        }
    }

    func testFeaturedRailIsSmallAndCurrentFamilyStaysVisible() throws {
        let instances = try loadCapturedCatalog()
        let selection = ModelSelection(instanceId: "cursor", model: "gpt-5.4-nano-high")
        let catalog = ModelFamilyPolicy.catalog(from: instances, selection: selection)
        let openai = catalog.families.filter { $0.providerId == "openai" }
        let featured = ModelFamilyPolicy.featuredFamilies(openai, selection: selection, limit: 6)
        XCTAssertLessThanOrEqual(featured.count, 6)
        XCTAssertGreaterThanOrEqual(featured.count, 1)
        XCTAssertTrue(featured.contains { $0.key == "gpt-5.4-nano" })
        XCTAssertTrue(openai.count > featured.count)
    }

    func testFablePrivacyNoticeIsNotDroppedOnCapturedClaude() throws {
        let instances = try loadCapturedCatalog()
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "cursor", model: "claude-fable-5-high")
        )
        let fable = try XCTUnwrap(catalog.families.first { $0.key == "claude-fable-5" })
        XCTAssertTrue(fable.privacyNotices.contains("NO ZDR"))
        XCTAssertTrue(
            fable.sources.first { $0.instanceId == "cursor" }?.variants.contains {
                $0.privacyNotice == "NO ZDR" && $0.modelId == "claude-fable-5-high"
            } == true
        )
    }

    private func loadCapturedCatalog() throws -> [Instance] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "model-catalog-20260905", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "model-catalog-20260905", withExtension: "json")
        )
        return try JSONDecoder().decode(InstanceList.self, from: Data(contentsOf: url)).instances
    }

    private func advertisedTuples(in instances: [Instance]) -> [(instanceId: String, modelId: String)] {
        instances.flatMap { instance in
            instance.models.options.map { (instance.instanceId, $0.id) }
        }
    }
}
