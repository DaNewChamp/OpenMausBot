import Foundation

/// In-sheet picker state. Provider/family/toggle edits stay local until Apply.
public struct ModelPickerDraft: Equatable, Sendable {
    public var browsingProviderId: String
    public var searchText: String
    public var showingMore: Bool
    public var familyKey: String
    public var instanceId: String
    public var modelId: String
    public var effort: String?
    public var thinking: Bool
    public var fast: Bool
    public var oneM: Bool
    public var openedWith: ModelSelection

    public init(
        browsingProviderId: String,
        searchText: String = "",
        showingMore: Bool = false,
        familyKey: String,
        instanceId: String,
        modelId: String,
        effort: String?,
        thinking: Bool,
        fast: Bool,
        oneM: Bool,
        openedWith: ModelSelection
    ) {
        self.browsingProviderId = browsingProviderId
        self.searchText = searchText
        self.showingMore = showingMore
        self.familyKey = familyKey
        self.instanceId = instanceId
        self.modelId = modelId
        self.effort = effort
        self.thinking = thinking
        self.fast = fast
        self.oneM = oneM
        self.openedWith = openedWith
    }
}

public enum ModelPickerApplyBlock: Equatable, Sendable {
    case busy
    case offline
    case saving
    case invalid
    case unchanged
    case remoteUpdated
    case catalogLoading
    case hostWide
}

public enum ModelPickerDraftPolicy: Sendable {
    public static func makeDraft(
        selection: ModelSelection,
        instances: [Instance],
        catalog: ModelFamilyCatalog
    ) -> ModelPickerDraft {
        let parsed = ModelFamilyPolicy.parse(selection.model)
        let family = ModelFamilyPolicy.family(for: selection, in: catalog)
        let source = family.flatMap { ModelFamilyPolicy.source(for: selection, in: $0) }
        let providerId = ProviderCatalogPolicy.classifyProvider(
            instanceId: selection.instanceId,
            driverKind: instances.first { $0.instanceId == selection.instanceId }?.driverKind ?? selection.instanceId,
            modelId: selection.model
        )
        let encodedEffort = source?.effortEncodedInModelId == true
        return ModelPickerDraft(
            browsingProviderId: providerId,
            familyKey: family?.key ?? parsed.familyKey,
            instanceId: selection.instanceId,
            modelId: selection.model,
            effort: encodedEffort ? parsed.axes.effort : selection.effort,
            thinking: parsed.axes.thinking,
            fast: parsed.axes.fast,
            oneM: parsed.axes.explicitOneM,
            openedWith: selection
        )
    }

    public static func browseProvider(_ providerId: String, draft: ModelPickerDraft) -> ModelPickerDraft {
        var next = draft
        next.browsingProviderId = providerId
        return next
    }

    public static func setSearch(_ text: String, draft: ModelPickerDraft) -> ModelPickerDraft {
        var next = draft
        next.searchText = text
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            next.showingMore = true
        }
        return next
    }

    public static func setShowingMore(_ showing: Bool, draft: ModelPickerDraft) -> ModelPickerDraft {
        var next = draft
        next.showingMore = showing
        return next
    }

    public static func selectFamily(
        _ familyKey: String,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
        )
        guard let sourceId = ModelFamilyPolicy.preservedSource(
            currentInstanceId: draft.instanceId,
            familyKey: familyKey,
            in: catalog
        ) else { return nil }
        guard let family = catalog.families.first(where: { $0.key == familyKey && $0.sources.contains { $0.instanceId == sourceId } }) else {
            return nil
        }
        return applyResolved(
            family: family,
            instanceId: sourceId,
            effort: draft.effort,
            thinking: draft.thinking,
            fast: draft.fast,
            oneM: draft.oneM,
            draft: draft,
            fallbackToSourceDefault: true
        )
    }

    public static func selectSource(
        _ instanceId: String,
        familyKey: String,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
        )
        guard let family = catalog.families.first(where: {
            $0.key == familyKey && $0.sources.contains { $0.instanceId == instanceId }
        }) else { return nil }
        return applyResolved(
            family: family,
            instanceId: instanceId,
            effort: draft.effort,
            thinking: draft.thinking,
            fast: draft.fast,
            oneM: draft.oneM,
            draft: draft,
            fallbackToSourceDefault: true
        )
    }

    /// Advanced fallback preserves opaque or ambiguous advertised variants.
    public static func selectRawVariant(_ modelId: String, draft: ModelPickerDraft, instances: [Instance]) -> ModelPickerDraft? {
        guard let source = instances.first(where: { $0.instanceId == draft.instanceId }),
              source.snapshot.isAvailable, source.allowsModelChange,
              source.models.options.contains(where: { $0.id == modelId }),
              ModelFamilyPolicy.parse(modelId).familyKey == draft.familyKey else { return nil }
        let selection = ModelSelection(instanceId: draft.instanceId, model: modelId, effort: draft.effort)
        var next = makeDraft(selection: selection, instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: selection))
        next.openedWith = draft.openedWith
        next.browsingProviderId = draft.browsingProviderId
        next.showingMore = draft.showingMore
        next.searchText = draft.searchText
        return next
    }

    public static func setEffort(
        _ effort: String?,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        mutateAxes(draft: draft, instances: instances) { family, source, next in
            if source.effortEncodedInModelId {
                next.effort = effort
                return ModelFamilyPolicy.resolveVariant(
                    in: family,
                    instanceId: source.instanceId,
                    effort: effort,
                    thinking: next.thinking,
                    fast: next.fast,
                    oneM: next.oneM
                )
            }
            if let effort, !source.capabilityEffortLevels.contains(effort) {
                return nil
            }
            next.effort = effort
            return source.variants.first { $0.modelId == next.modelId } ?? source.variants.first
        }
    }

    public static func setFast(
        _ fast: Bool,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        mutateAxes(draft: draft, instances: instances) { family, source, next in
            next.fast = fast
            return ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: source.instanceId,
                effort: source.effortEncodedInModelId ? next.effort : nil,
                thinking: next.thinking,
                fast: fast,
                oneM: next.oneM
            )
        }
    }

    public static func setThinking(
        _ thinking: Bool,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        mutateAxes(draft: draft, instances: instances) { family, source, next in
            next.thinking = thinking
            return ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: source.instanceId,
                effort: source.effortEncodedInModelId ? next.effort : nil,
                thinking: thinking,
                fast: next.fast,
                oneM: next.oneM
            )
        }
    }

    public static func setOneM(
        _ enabled: Bool,
        draft: ModelPickerDraft,
        instances: [Instance]
    ) -> ModelPickerDraft? {
        mutateAxes(draft: draft, instances: instances) { family, source, next in
            next.oneM = enabled
            return ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: source.instanceId,
                effort: source.effortEncodedInModelId ? next.effort : nil,
                thinking: next.thinking,
                fast: next.fast,
                oneM: enabled
            )
        }
    }

    public static func resolvedSelection(draft: ModelPickerDraft, instances: [Instance]) -> ModelSelection? {
        guard ModelFamilyPolicy.parse(draft.modelId).familyKey == draft.familyKey else { return nil }
        if cancelDiscardsWithoutPatch(draft: draft, openedWith: draft.openedWith) { return draft.openedWith }
        guard advertised(instanceId: draft.instanceId, modelId: draft.modelId, in: instances) else {
            if draft.instanceId == draft.openedWith.instanceId, draft.modelId == draft.openedWith.model {
                return draft.openedWith
            }
            return nil
        }
        let effort = capabilityEffort(for: draft.instanceId, in: instances) ? draft.effort : nil
        return ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: effort)
    }

    public static func applyBlock(
        draft: ModelPickerDraft,
        remote: ModelSelection,
        working: Bool,
        canEdit: Bool,
        saving: Bool,
        catalogLoading: Bool,
        hostWide: Bool,
        instances: [Instance]
    ) -> ModelPickerApplyBlock? {
        if working { return .busy }
        if !canEdit { return .offline }
        if saving { return .saving }
        if catalogLoading { return .catalogLoading }
        if hostWide { return .hostWide }
        if remote != draft.openedWith { return .remoteUpdated }
        if ModelFamilyPolicy.parse(draft.modelId).familyKey != draft.familyKey {
            return .invalid
        }
        guard let resolved = resolvedSelection(draft: draft, instances: instances) else {
            return .invalid
        }
        if resolved == remote { return .unchanged }
        guard let source = instances.first(where: { $0.instanceId == resolved.instanceId }) else {
            return resolved == remote ? .unchanged : .invalid
        }
        if !source.snapshot.isAvailable || !source.allowsModelChange
            || (resolved.instanceId != remote.instanceId && !source.allowsInstanceChange) {
            return .invalid
        }
        if let effort = resolved.effort, capabilityEffort(for: source.instanceId, in: instances),
           !(source.capabilities?.effortLevels ?? []).contains(effort), resolved != remote {
            return .invalid
        }
        if resolved.instanceId == remote.instanceId,
           resolved.model == remote.model,
           resolved.effort == remote.effort {
            return .unchanged
        }
        return nil
    }

    public static func patch(from draft: ModelPickerDraft, instances: [Instance]) -> BotModelPatch? {
        guard let resolved = resolvedSelection(draft: draft, instances: instances) else { return nil }
        let effort: BotModelPatch.EffortUpdate
        if capabilityEffort(for: resolved.instanceId, in: instances) {
            effort = resolved.effort.map(BotModelPatch.EffortUpdate.set) ?? .clear
        } else {
            // Model-encoded reasoning must not retain an old independent
            // reasoning override from a different source or variant.
            effort = draft.openedWith.effort == nil ? .omitted : .clear
        }
        return BotModelPatch(instanceId: resolved.instanceId, model: resolved.model, effort: effort)
    }

    public static func cancelDiscardsWithoutPatch(draft: ModelPickerDraft, openedWith: ModelSelection) -> Bool {
        guard draft.instanceId == openedWith.instanceId, draft.modelId == openedWith.model,
              draft.familyKey == ModelFamilyPolicy.parse(openedWith.model).familyKey else { return false }
        let axes = ModelFamilyPolicy.parse(openedWith.model).axes
        return draft.effort == (axes.effort ?? openedWith.effort)
            && draft.fast == axes.fast && draft.thinking == axes.thinking && draft.oneM == axes.explicitOneM
    }

    public static func canApply(_ block: ModelPickerApplyBlock?) -> Bool {
        block == nil
    }

    private static func mutateAxes(
        draft: ModelPickerDraft,
        instances: [Instance],
        _ body: (ModelFamily, ModelFamilySource, inout ModelPickerDraft) -> ModelAdvertisedVariant?
    ) -> ModelPickerDraft? {
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
        )
        guard let family = catalog.families.first(where: {
            $0.key == draft.familyKey && $0.sources.contains { $0.instanceId == draft.instanceId }
        }) ?? catalog.families.first(where: { $0.key == draft.familyKey }),
              let source = family.sources.first(where: { $0.instanceId == draft.instanceId })
        else { return nil }
        var next = draft
        guard let variant = body(family, source, &next) else { return nil }
        next.familyKey = family.key
        next.instanceId = variant.instanceId
        next.modelId = variant.modelId
        next.thinking = variant.axes.thinking
        next.fast = variant.axes.fast
        next.oneM = variant.axes.explicitOneM
        if source.effortEncodedInModelId {
            next.effort = variant.axes.effort
        }
        return next
    }

    private static func applyResolved(
        family: ModelFamily,
        instanceId: String,
        effort: String?,
        thinking: Bool,
        fast: Bool,
        oneM: Bool,
        draft: ModelPickerDraft,
        fallbackToSourceDefault: Bool
    ) -> ModelPickerDraft? {
        guard let source = family.sources.first(where: { $0.instanceId == instanceId }) else { return nil }
        let encodedEffort = source.effortEncodedInModelId ? effort : nil
        var variant = ModelFamilyPolicy.resolveVariant(
            in: family,
            instanceId: instanceId,
            effort: encodedEffort,
            thinking: thinking,
            fast: fast,
            oneM: oneM
        )
        if variant == nil, fallbackToSourceDefault {
            variant = ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: instanceId,
                effort: encodedEffort,
                thinking: thinking,
                fast: false,
                oneM: oneM
            )
            ?? ModelFamilyPolicy.resolveVariant(
                in: family,
                instanceId: instanceId,
                effort: encodedEffort,
                thinking: false,
                fast: false,
                oneM: false
            )
            ?? source.variants.first
        }
        guard let variant else { return nil }
        var next = draft
        next.familyKey = family.key
        next.instanceId = variant.instanceId
        next.modelId = variant.modelId
        next.thinking = variant.axes.thinking
        next.fast = variant.axes.fast
        next.oneM = variant.axes.explicitOneM
        if source.effortEncodedInModelId {
            next.effort = variant.axes.effort
        } else if let effort, source.capabilityEffortLevels.contains(effort) {
            next.effort = effort
        } else {
            next.effort = draft.effort.flatMap { source.capabilityEffortLevels.contains($0) ? $0 : nil }
        }
        return next
    }

    private static func advertised(instanceId: String, modelId: String, in instances: [Instance]) -> Bool {
        instances.contains { instance in
            instance.instanceId == instanceId && instance.models.options.contains { $0.id == modelId }
        }
    }

    private static func capabilityEffort(for instanceId: String, in instances: [Instance]) -> Bool {
        guard let levels = instances.first(where: { $0.instanceId == instanceId })?.capabilities?.effortLevels else {
            return false
        }
        return !levels.isEmpty
    }
}
