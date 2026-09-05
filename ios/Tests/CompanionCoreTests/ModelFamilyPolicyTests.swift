import XCTest
@testable import CompanionCore

final class ModelFamilyPolicyTests: XCTestCase {
    func testCompositeIdentityKeepsDuplicateModelIdsDistinct() {
        XCTAssertEqual(
            ModelFamilyPolicy.compositeId(instanceId: "codex", modelId: "gpt-5.6-sol"),
            ModelFamilyPolicy.compositeId(instanceId: "codex", modelId: "gpt-5.6-sol")
        )
        XCTAssertNotEqual(
            ModelFamilyPolicy.compositeId(instanceId: "codex", modelId: "gpt-5.6-sol"),
            ModelFamilyPolicy.compositeId(instanceId: "droid", modelId: "gpt-5.6-sol")
        )
        XCTAssertNotEqual(
            ModelFamilyPolicy.compositeId(instanceId: "cursor", modelId: "claude-sonnet-5"),
            ModelFamilyPolicy.compositeId(instanceId: "claude", modelId: "claude-sonnet-5")
        )
    }

    func testCursorEffortFastAndThinkingSuffixesParseWithoutConsumingFamily() {
        let sol = ModelFamilyPolicy.parse("gpt-5.6-sol-high-fast")
        XCTAssertEqual(sol.familyKey, "gpt-5.6-sol")
        XCTAssertEqual(sol.axes.effort, "high")
        XCTAssertTrue(sol.axes.fast)
        XCTAssertFalse(sol.axes.thinking)
        XCTAssertFalse(sol.axes.explicitOneM)

        let extra = ModelFamilyPolicy.parse("gpt-5.5-extra-high-fast")
        XCTAssertEqual(extra.familyKey, "gpt-5.5")
        XCTAssertEqual(extra.axes.effort, "extra-high")
        XCTAssertTrue(extra.axes.fast)

        let thinkingBefore = ModelFamilyPolicy.parse("claude-sonnet-5-thinking-high")
        XCTAssertEqual(thinkingBefore.familyKey, "claude-sonnet-5")
        XCTAssertEqual(thinkingBefore.axes.effort, "high")
        XCTAssertTrue(thinkingBefore.axes.thinking)
        XCTAssertFalse(thinkingBefore.axes.explicitOneM)

        let thinkingAfter = ModelFamilyPolicy.parse("claude-4.6-sonnet-medium-thinking")
        XCTAssertEqual(thinkingAfter.familyKey, "claude-4.6-sonnet")
        XCTAssertEqual(thinkingAfter.axes.effort, "medium")
        XCTAssertTrue(thinkingAfter.axes.thinking)

        let thinkingOnly = ModelFamilyPolicy.parse("claude-4.5-sonnet-thinking")
        XCTAssertEqual(thinkingOnly.familyKey, "claude-4.5-sonnet")
        XCTAssertTrue(thinkingOnly.axes.thinking)
        XCTAssertNil(thinkingOnly.axes.effort)

        let explicitOneM = ModelFamilyPolicy.parse("gpt-5.6-sol-1m")
        XCTAssertEqual(explicitOneM.familyKey, "gpt-5.6-sol")
        XCTAssertTrue(explicitOneM.axes.explicitOneM)
        XCTAssertFalse(explicitOneM.axes.thinking)
    }

    func testThinkingIsNeverInferredAsOneMContext() {
        for id in [
            "claude-sonnet-5-thinking-high",
            "claude-opus-5-thinking-high-fast",
            "claude-4.5-sonnet-thinking",
            "claude-4.6-opus-high-thinking",
        ] {
            let parsed = ModelFamilyPolicy.parse(id)
            XCTAssertTrue(parsed.axes.thinking, id)
            XCTAssertFalse(parsed.axes.explicitOneM, "Thinking must not imply 1M for \(id)")
        }
    }

    func testModelVersionIntegrityDoesNotCollapseDistinctFamilies() {
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-opus-5").familyKey, "claude-opus-5")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-opus-4-8-high").familyKey, "claude-opus-4-8")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-opus-4-7-xhigh").familyKey, "claude-opus-4-7")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-4.6-opus-high").familyKey, "claude-4.6-opus")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-4.5-opus-high").familyKey, "claude-4.5-opus")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-fable-5-high").familyKey, "claude-fable-5")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-fable-5-1-high").familyKey, "claude-fable-5-1")
        XCTAssertEqual(ModelFamilyPolicy.parse("gpt-5.4-high").familyKey, "gpt-5.4")
        XCTAssertEqual(ModelFamilyPolicy.parse("gpt-5.4-mini-high").familyKey, "gpt-5.4-mini")
        XCTAssertEqual(ModelFamilyPolicy.parse("gpt-5.4-nano-low").familyKey, "gpt-5.4-nano")
        XCTAssertEqual(ModelFamilyPolicy.parse("gpt-5.3-codex-high-fast").familyKey, "gpt-5.3-codex")
        XCTAssertEqual(ModelFamilyPolicy.parse("gpt-5.3-codex-spark").familyKey, "gpt-5.3-codex-spark")
        XCTAssertEqual(ModelFamilyPolicy.parse("gemini-3.6-flash-minimal").familyKey, "gemini-3.6-flash-minimal")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-haiku-4-5-20251001").familyKey, "claude-haiku-4-5-20251001")
        XCTAssertEqual(ModelFamilyPolicy.parse("claude-haiku-4-5").familyKey, "claude-haiku-4-5")
    }

    func testContextToggleRequiresUnambiguousExplicitOneMPair() {
        let mixed = [
            variant("codex", "gpt-5.6-sol", "GPT-5.6 Sol"),
            variant("codex", "gpt-5.6-sol-1m", "GPT-5.6 Sol 1M"),
        ]
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: mixed), .toggle)

        let onlyOneM = [
            variant("cursor", "gpt-5.6-sol-1m", "GPT-5.6 Sol 1M"),
            variant("cursor", "gpt-5.6-sol-1m-fast", "GPT-5.6 Sol 1M Fast"),
        ]
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: onlyOneM), .included)

        let labelOnly = [
            variant("cursor", "gpt-5.6-sol-medium", "GPT-5.6 Sol 1M"),
            variant("cursor", "gpt-5.6-sol-medium-fast", "GPT-5.6 Sol 1M Fast"),
        ]
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: labelOnly), .included)

        let fastOmitsLabel = [
            variant("cursor", "gpt-5.5-medium", "GPT-5.5 1M"),
            variant("cursor", "gpt-5.5-medium-fast", "GPT-5.5 Fast"),
        ]
        XCTAssertEqual(
            ModelFamilyPolicy.contextClaim(for: fastOmitsLabel),
            .none,
            "Absence of 1M in a Fast label is not evidence the context changed"
        )
    }

    func testThinkingToggleOnlyWhenIndependentVariantsExist() {
        let independent = [
            variant("cursor", "claude-4.5-sonnet", "Claude Sonnet 4.5"),
            variant("cursor", "claude-4.5-sonnet-thinking", "Claude Sonnet 4.5 Thinking"),
        ]
        XCTAssertTrue(ModelFamilyPolicy.thinkingIsIndependent(in: independent))

        let thinkingOnly = [
            variant("cursor", "claude-sonnet-5-thinking-high", "Claude Sonnet 5 1M Thinking"),
        ]
        XCTAssertFalse(ModelFamilyPolicy.thinkingIsIndependent(in: thinkingOnly))
    }

    func testFastToggleLooksUpExactSameFamilyAndInstanceVariant() {
        let family = familyFrom([
            variant("cursor", "gpt-5.3-codex-high", "Codex 5.3 High"),
            variant("cursor", "gpt-5.3-codex-high-fast", "Codex 5.3 High Fast"),
            variant("cursor", "gpt-5.3-codex-low", "Codex 5.3 Low"),
        ])
        let fast = ModelFamilyPolicy.resolveVariant(
            in: family,
            instanceId: "cursor",
            effort: "high",
            thinking: false,
            fast: true,
            oneM: false
        )
        XCTAssertEqual(fast?.modelId, "gpt-5.3-codex-high-fast")
        XCTAssertEqual(fast?.instanceId, "cursor")

        XCTAssertNil(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "cursor",
                effort: "low",
                thinking: false,
                fast: true,
                oneM: false
            ),
            "Must not concatenate a missing -fast id"
        )
        XCTAssertNil(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "codex",
                effort: "high",
                thinking: false,
                fast: true,
                oneM: false
            ),
            "Must not silently switch source to satisfy Fast"
        )
    }

    func testUnsupportedCombinationsAreRefusedRatherThanInvented() {
        let family = familyFrom([
            variant("cursor", "claude-4.5-sonnet", "Claude Sonnet 4.5"),
            variant("cursor", "claude-4.5-sonnet-thinking", "Claude Sonnet 4.5 Thinking"),
        ])
        XCTAssertNil(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "cursor",
                effort: nil,
                thinking: false,
                fast: true,
                oneM: false
            )
        )
        XCTAssertNil(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "cursor",
                effort: "high",
                thinking: true,
                fast: false,
                oneM: true
            )
        )
        XCTAssertEqual(
            ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: "cursor",
                effort: nil,
                thinking: true,
                fast: false,
                oneM: false
            )?.modelId,
            "claude-4.5-sonnet-thinking"
        )
    }

    func testPrivacyNoticesSurviveFamilyFold() {
        let family = familyFrom([
            variant("cursor", "claude-fable-5-high", "Claude Fable 5 1M (NO ZDR)"),
            variant("cursor", "claude-fable-5-thinking-high", "Claude Fable 5 1M Thinking (NO ZDR)"),
        ])
        XCTAssertEqual(Set(family.privacyNotices), ["NO ZDR"])
        XCTAssertEqual(
            ModelFamilyPolicy.privacyNotice(from: "Claude Fable 5 1M Thinking (NO ZDR)"),
            "NO ZDR"
        )
        XCTAssertNil(ModelFamilyPolicy.privacyNotice(from: "Claude Sonnet 5 1M"))
    }

    func testUnknownIdsStaySelectableSingletonsWithRawIdentity() {
        let parsed = ModelFamilyPolicy.parse("vendor-custom-experimental[foo]")
        XCTAssertEqual(parsed.familyKey, "vendor-custom-experimental[foo]")
        let family = familyFrom([
            variant("cursor", "vendor-custom-experimental[foo]", "Mystery Build"),
        ])
        XCTAssertEqual(family.key, "vendor-custom-experimental[foo]")
        XCTAssertEqual(family.sources.first?.variants.first?.modelId, "vendor-custom-experimental[foo]")
    }

    func testSourceCapabilitiesAreNotAggregatedFromTheFirstSource() throws {
        let instances = [
            instance(
                id: "codex",
                driver: "codex",
                name: "Codex",
                models: [("gpt-5.6-sol", "GPT-5.6 Sol")],
                effort: ["low", "medium", "high", "xhigh", "max"]
            ),
            instance(
                id: "droid",
                driver: "droidAgent",
                name: "Droid",
                models: [("gpt-5.6-sol", "GPT-5.6 Sol")],
                effort: nil,
                state: "unavailable",
                reason: "`droid` CLI not found"
            ),
        ]
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )
        let family = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.6-sol" })
        let codex = try XCTUnwrap(family.sources.first { $0.instanceId == "codex" })
        let droid = try XCTUnwrap(family.sources.first { $0.instanceId == "droid" })
        XCTAssertEqual(codex.capabilityEffortLevels, ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(droid.capabilityEffortLevels, [])
        XCTAssertTrue(codex.available)
        XCTAssertFalse(droid.available)
        XCTAssertEqual(droid.unavailableReason, "`droid` CLI not found")
    }

    func testSelectingAFamilyPreservesTheCurrentSourceWhenItAdvertisesThatFamily() {
        let instances = [
            instance(id: "claude", driver: "claudeAgent", name: "Claude", models: [
                ("claude-sonnet-5", "Claude Sonnet 5"),
                ("claude-opus-5", "Claude Opus 5"),
            ]),
            instance(id: "cursor", driver: "cursorAgent", name: "Cursor", models: [
                ("claude-sonnet-5-thinking-high", "Claude Sonnet 5 1M Thinking"),
                ("claude-opus-5-thinking-high", "Claude Opus 5 1M Thinking"),
            ]),
        ]
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: "claude", model: "claude-sonnet-5")
        )
        XCTAssertEqual(
            ModelFamilyPolicy.preservedSource(
                currentInstanceId: "claude",
                familyKey: "claude-opus-5",
                in: catalog
            ),
            "claude"
        )
        XCTAssertNil(
            ModelFamilyPolicy.preservedSource(
                currentInstanceId: "claude",
                familyKey: "claude-4.5-sonnet",
                in: catalog
            ),
            "Must not silently switch onto Cursor"
        )
    }

    func testMissingCurrentModelIsUnavailableRatherThanRewritten() {
        let instances = [
            instance(id: "codex", driver: "codex", name: "Codex", models: [("gpt-5.6-sol", "GPT-5.6 Sol")]),
        ]
        let selection = ModelSelection(instanceId: "codex", model: "retired-gpt")
        let catalog = ModelFamilyPolicy.catalog(from: instances, selection: selection)
        XCTAssertFalse(catalog.currentIsAdvertised)
        XCTAssertEqual(catalog.currentUnavailableLabel, ModelSelectionPolicy.currentModelUnavailable)
        XCTAssertEqual(catalog.current.model, "retired-gpt")
        XCTAssertEqual(catalog.current.instanceId, "codex")
    }

    private func variant(_ instanceId: String, _ modelId: String, _ label: String) -> ModelAdvertisedVariant {
        ModelAdvertisedVariant(
            instanceId: instanceId,
            modelId: modelId,
            label: label,
            axes: ModelFamilyPolicy.parse(modelId).axes,
            privacyNotice: ModelFamilyPolicy.privacyNotice(from: label)
        )
    }

    private func familyFrom(_ variants: [ModelAdvertisedVariant]) -> ModelFamily {
        let key = ModelFamilyPolicy.parse(variants[0].modelId).familyKey
        let grouped = Dictionary(grouping: variants, by: \.instanceId)
        return ModelFamily(
            key: key,
            providerId: "openai",
            label: "Family",
            sources: grouped.keys.sorted().map { instanceId in
                ModelFamilySource(
                    instanceId: instanceId,
                    displayName: instanceId,
                    available: true,
                    unavailableReason: nil,
                    variants: grouped[instanceId] ?? [],
                    capabilityEffortLevels: [],
                    effortEncodedInModelId: (grouped[instanceId] ?? []).contains { $0.axes.effort != nil }
                )
            },
            privacyNotices: variants.compactMap(\.privacyNotice)
        )
    }

    private func instance(
        id: String,
        driver: String,
        name: String,
        models: [(String, String)],
        effort: [String]? = nil,
        state: String = "available",
        reason: String? = nil
    ) -> Instance {
        Instance(
            instanceId: id,
            driverKind: driver,
            displayName: name,
            snapshot: ProviderSnapshot(state: state, reason: reason, authenticated: true, version: nil),
            models: ModelCatalog(
                default: models.first?.0 ?? "",
                options: models.map { ModelOption(id: $0.0, label: $0.1) }
            ),
            capabilities: effort.map { InstanceCapabilities(computerMcp: nil, localComputerMcp: nil, effortLevels: $0) }
        )
    }
}
