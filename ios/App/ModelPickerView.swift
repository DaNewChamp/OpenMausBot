import CompanionCore
import SwiftUI

/// Placeholder layout while engine/model catalogs load from the harness.
struct ModelPickerLoadingView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(0..<5, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 999, style: .continuous)
                            .fill(Color.primary.opacity(0.07))
                            .frame(width: 92, height: 34)
                    }
                }
                .padding(.horizontal, 2)
            }

            VStack(spacing: 0) {
                ForEach(0..<4, id: \.self) { index in
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: CGFloat(120 + index * 14), height: 14)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44, alignment: .leading)

                    if index < 3 {
                        Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                    }
                }
            }
            .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading models")
    }
}

struct ModelPickerErrorView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct ModelPickerEmptyView: View {
    var body: some View {
        Label(ModelSelectionPolicy.emptyCatalogExplanation, systemImage: "cpu")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityLabel(ModelSelectionPolicy.emptyCatalogExplanation)
    }
}

/// Horizontal reasoning chips for model sheets and profiles.
struct ModelEffortPicker: View {
    let levels: [String]
    @Binding var selection: String?
    var disabled: Bool = false
    var onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reasoning")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    EffortChip(
                        title: "Default",
                        selected: selection == nil,
                        disabled: disabled
                    ) {
                        selection = nil
                        onChange()
                    }

                    ForEach(levels, id: \.self) { level in
                        EffortChip(
                            title: ModelEffortPicker.effortLabel(level),
                            selected: selection == level,
                            disabled: disabled
                        ) {
                            selection = level
                            onChange()
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    static func effortLabel(_ level: String) -> String {
        ModelSelectionPolicy.effortDisplayName(level)
    }
}

private struct EffortChip: View {
    let title: String
    let selected: Bool
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .padding(.horizontal, 12)
                .frame(minHeight: VBotSurface.Hit.minimum)
                .background(
                    selected ? ModelPickerStyle.chipSelected : ModelPickerStyle.chip,
                    in: Capsule()
                )
                .overlay {
                    Capsule()
                        .strokeBorder(selected ? Color.primary.opacity(0.12) : .clear, lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Compact family picker. Provider tabs browse only; family/toggles stay
/// on the draft until the host Applies.
struct ModelPickerView: View {
    let instances: [Instance]
    @Binding var draft: ModelPickerDraft
    var disabled: Bool = false
    var hostWide: Bool = false
    var footerHint: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var catalog: ModelFamilyCatalog {
        ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
        )
    }

    private var providerTabs: [MobileCatalogProvider] {
        ProviderCatalogPolicy.catalog(from: instances).providers
    }

    private var activeProviderId: String {
        if providerTabs.contains(where: { $0.id == draft.browsingProviderId }) {
            return draft.browsingProviderId
        }
        return providerTabs.first?.id ?? draft.browsingProviderId
    }

    private var providerFamilies: [ModelFamily] {
        catalog.families.filter { $0.providerId == activeProviderId }
    }

    private var featured: [ModelFamily] {
        ModelFamilyPolicy.featuredFamilies(providerFamilies, selection: draftSelection, limit: 4)
    }

    private var moreFamilies: [ModelFamily] {
        let featuredIds = Set(featured.map(\.id))
        let rest = draft.searchText.isEmpty ? providerFamilies.filter { !featuredIds.contains($0.id) } : providerFamilies
        return ModelFamilyPolicy.visibleFamilies(rest, search: draft.searchText)
    }

    private var draftSelection: ModelSelection {
        ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
    }

    private var selectedFamily: ModelFamily? {
        catalog.families.first { $0.key == draft.familyKey && $0.sources.contains { $0.instanceId == draft.instanceId } }
            ?? catalog.families.first { $0.key == draft.familyKey }
            ?? catalog.families.first { $0.id == ModelFamilyPolicy.compositeId(instanceId: activeProviderId, modelId: draft.familyKey) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if ProviderCatalogPolicy.isEmpty(advertised: instances, selection: draftSelection) {
                ModelPickerEmptyView()
            } else {
                if !catalog.currentIsAdvertised {
                    Label(
                        catalog.currentUnavailableLabel ?? ModelSelectionPolicy.currentModelUnavailable,
                        systemImage: "exclamationmark.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: VBotSurface.Hit.minimum, alignment: .leading)
                }
                familyLists
                if let selectedFamily { familyConfiguration(selectedFamily) }
            }

            if let footerHint {
                Text(footerHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var familyLists: some View {
        VStack(alignment: .leading, spacing: 12) {
            if draft.searchText.isEmpty { familyGroup(featured) }
            if !moreFamilies.isEmpty || draft.showingMore || !draft.searchText.isEmpty {
                Button {
                    if reduceMotion {
                        draft = ModelPickerDraftPolicy.setShowingMore(!draft.showingMore, draft: draft)
                    } else {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            draft = ModelPickerDraftPolicy.setShowingMore(!draft.showingMore, draft: draft)
                        }
                    }
                } label: {
                    Label(draft.showingMore ? "Fewer models" : ModelSelectionPolicy.moreModels,
                          systemImage: draft.showingMore ? "chevron.up" : "chevron.down")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: VBotSurface.Hit.minimum, alignment: .leading)
                }
                .buttonStyle(.plain)
                if draft.showingMore {
                    TextField("Search models", text: Binding(
                        get: { draft.searchText },
                        set: { draft = ModelPickerDraftPolicy.setSearch($0, draft: draft) }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                    familyGroup(moreFamilies)
                }
            }
        }
    }

    private func familyGroup(_ families: [ModelFamily]) -> some View {
        VStack(spacing: 0) {
            if families.isEmpty {
                Text(ModelSelectionPolicy.engineEmptyExplanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            } else {
                ForEach(Array(families.enumerated()), id: \.element.id) { index, family in
                    ModelRow(
                        label: familyRowLabel(family),
                        selected: family.key == draft.familyKey,
                        isDefault: false,
                        disabled: disabled
                    ) {
                        if let next = ModelPickerDraftPolicy.selectFamily(
                            family.key,
                            draft: draft,
                            instances: instances
                        ) {
                            draft = next
                            if draft.browsingProviderId != family.providerId {
                                draft = ModelPickerDraftPolicy.browseProvider(family.providerId, draft: draft)
                            }
                        } else {
                            draft.familyKey = family.key
                        }
                    }
                    if index < families.count - 1 {
                        Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                    }
                }
            }
        }
        .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func familyRowLabel(_ family: ModelFamily) -> String {
        family.label
    }

    @ViewBuilder
    private func familyConfiguration(_ family: ModelFamily) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(family.label)
                .font(.subheadline.weight(.semibold))
                .padding(.bottom, 6)
            sourcePicker(family)
            if let source = family.sources.first(where: { $0.instanceId == draft.instanceId }),
               source.variants.contains(where: { $0.modelId == draft.modelId }) {
                Divider().overlay(ModelPickerStyle.divider)
                reasoningPicker(family, source: source)
                if ModelFamilyPolicy.thinkingIsIndependent(in: source.variants) {
                    Toggle(ModelSelectionPolicy.thinkingTitle, isOn: Binding(
                        get: { draft.thinking },
                        set: { enabled in
                            if let next = ModelPickerDraftPolicy.setThinking(enabled, draft: draft, instances: instances) { draft = next }
                        }
                    ))
                    .disabled(disabled || hostWide || !source.available
                        || ModelPickerDraftPolicy.setThinking(!draft.thinking, draft: draft, instances: instances) == nil)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                }
                if source.variants.contains(where: { $0.axes.fast }) {
                    Toggle(ModelSelectionPolicy.fastGenerationTitle, isOn: Binding(
                        get: { draft.fast },
                        set: { enabled in
                            if let next = ModelPickerDraftPolicy.setFast(enabled, draft: draft, instances: instances) { draft = next }
                        }
                    ))
                    .disabled(disabled || hostWide || !source.available
                        || ModelPickerDraftPolicy.setFast(!draft.fast, draft: draft, instances: instances) == nil)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                }
                switch ModelFamilyPolicy.contextClaim(for: source.variants) {
                case .toggle:
                    Toggle(ModelSelectionPolicy.oneMContext, isOn: Binding(
                        get: { draft.oneM },
                        set: { enabled in
                            if let next = ModelPickerDraftPolicy.setOneM(enabled, draft: draft, instances: instances) { draft = next }
                        }
                    ))
                    .disabled(disabled || hostWide || !source.available
                        || ModelPickerDraftPolicy.setOneM(!draft.oneM, draft: draft, instances: instances) == nil)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                case .included:
                    Label(ModelSelectionPolicy.oneMIncluded, systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                case .none:
                    EmptyView()
                }
                if !source.available {
                    Text(source.unavailableReason ?? "This source is unavailable.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let notice = source.variants.first(where: { $0.modelId == draft.modelId })?.privacyNotice {
                    Label(notice, systemImage: "info.circle")
                        .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                }
                DisclosureGroup(ModelSelectionPolicy.advancedDetails) {
                    Text(draft.modelId)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                    if source.variants.count > 1 {
                        Picker("Exact variant", selection: Binding(
                            get: { draft.modelId },
                            set: { id in
                                if let next = ModelPickerDraftPolicy.selectRawVariant(id, draft: draft, instances: instances) { draft = next }
                            }
                        )) {
                            ForEach(source.variants) { variant in
                                Text(variant.modelId).tag(variant.modelId)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(disabled || hostWide || !source.available)
                    }
                    Text("Fast generation keeps this model and source. Context options appear only when advertised.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .font(.footnote)
                .frame(minHeight: VBotSurface.Hit.minimum)
            } else {
                Text("Choose a source above to use this model. Your current model is unchanged until Apply.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            }
        }
        .padding(14)
        .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func sourcePicker(_ family: ModelFamily) -> some View {
        HStack {
            Text(ModelSelectionPolicy.runVia)
            Spacer(minLength: 8)
            Picker(ModelSelectionPolicy.runVia, selection: Binding(
            get: { family.sources.contains(where: { $0.instanceId == draft.instanceId
                && $0.variants.contains(where: { $0.modelId == draft.modelId }) }) ? draft.instanceId : "" },
            set: { id in
                if let next = ModelPickerDraftPolicy.selectSource(id, familyKey: family.key, draft: draft, instances: instances) {
                    draft = next
                }
            }
        )) {
            if !family.sources.contains(where: { $0.instanceId == draft.instanceId && $0.variants.contains(where: { $0.modelId == draft.modelId }) }) {
                Text("Choose source").tag("")
            }
            ForEach(family.sources) { source in
                let instance = instances.first { $0.instanceId == source.instanceId }
                Text(source.displayName + (source.available ? "" : " · Unavailable"))
                    .tag(source.instanceId)
                    .disabled(!source.available || instance?.allowsModelChange == false
                        || (source.instanceId != draft.openedWith.instanceId && instance?.allowsInstanceChange == false))
            }
        }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(.primary)
            .disabled(disabled || hostWide)
        }
        .frame(minHeight: VBotSurface.Hit.minimum)
    }

    @ViewBuilder
    private func reasoningPicker(_ family: ModelFamily, source: ModelFamilySource) -> some View {
        let levels = source.effortEncodedInModelId
            ? orderedEfforts(source.variants.compactMap(\.axes.effort)) : source.capabilityEffortLevels
        if !levels.isEmpty, !hostWide {
            HStack {
                Text("Reasoning")
                Spacer(minLength: 8)
                Picker("Reasoning", selection: Binding(
                get: { draft.effort ?? "__default" },
                set: { value in
                    if let next = ModelPickerDraftPolicy.setEffort(value == "__default" ? nil : value, draft: draft, instances: instances) {
                        draft = next
                    }
                }
            )) {
                Text("Default").tag("__default")
                    .disabled(ModelPickerDraftPolicy.setEffort(nil, draft: draft, instances: instances) == nil)
                ForEach(levels, id: \.self) { level in
                    Text(ModelSelectionPolicy.effortDisplayName(level)).tag(level)
                        .disabled(ModelPickerDraftPolicy.setEffort(level, draft: draft, instances: instances) == nil)
                }
            }
                .labelsHidden()
                .pickerStyle(.menu)
                .tint(.primary)
                .disabled(disabled || !source.available)
            }
            .frame(minHeight: VBotSurface.Hit.minimum)
        }
    }

    private func orderedEfforts(_ values: [String]) -> [String] {
        let rank = ["none": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4, "extra-high": 5, "max": 6]
        return Array(Set(values)).sorted { (rank[$0] ?? 99) < (rank[$1] ?? 99) }
    }
}

private struct ModelPickerProviderRail: View {
    let instances: [Instance]
    @Binding var draft: ModelPickerDraft
    var disabled: Bool = false

    private var providers: [MobileCatalogProvider] {
        ProviderCatalogPolicy.catalog(from: instances).providers
    }
    private var activeId: String {
        providers.contains(where: { $0.id == draft.browsingProviderId })
            ? draft.browsingProviderId : providers.first?.id ?? draft.browsingProviderId
    }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(providers, id: \.id) { provider in
                    providerButton(provider)
                }
            }
            .padding(.horizontal, 2)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
    private func providerButton(_ provider: MobileCatalogProvider) -> some View {
        let selected = provider.id == activeId
        return Button {
            draft = ModelPickerDraftPolicy.browseProvider(provider.id, draft: draft)
        } label: {
            HStack(spacing: 6) {
                ProviderMarks.mark(for: provider.markKey, size: 16)
                Text(provider.label).font(.subheadline.weight(selected ? .semibold : .medium))
            }
            .foregroundStyle(selected ? Color.primary : Color.secondary)
            .padding(.horizontal, 12)
            .frame(minHeight: VBotSurface.Hit.minimum)
            .background(selected ? ModelPickerStyle.chipSelected : ModelPickerStyle.chip, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Color.primary.opacity(0.16) : .clear, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(provider.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct EngineChip: View {
    let instance: Instance
    let selected: Bool
    var selectedInstanceId: String = ""
    var selectedModelId: String = ""
    var disabled: Bool = false
    var unavailable: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ProviderMarks.mark(for: instance.markKey, size: 20)
                Text(instance.pickerTitle)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 72)
            .padding(.vertical, 10)
            .background(
                selected ? ModelPickerStyle.chipSelected : ModelPickerStyle.chip,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? Color.primary.opacity(0.14) : .clear, lineWidth: 1)
            }
            .opacity(disabled ? 0.55 : unavailable ? 0.72 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(instance.pickerTitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ModelRow: View {
    let label: String
    let selected: Bool
    let isDefault: Bool
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(label)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if isDefault {
                    Text("Default")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(ModelPickerStyle.chip, in: Capsule())
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .background(selected ? ModelPickerStyle.rowSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private enum ModelPickerStyle {
    static let divider = Color.primary.opacity(0.08)
    static let chip = VBotSurface.controlSurface
    static let chipSelected = VBotSurface.composerSurface
    static let listSurface = VBotSurface.controlSurface.opacity(0.72)
    static let rowSelected = Color.primary.opacity(0.05)
}

/// Compact summary row for profile surfaces — tap to expand the full picker.
struct ModelSelectionSummaryRow: View {
    let instanceTitle: String
    let modelTitle: String
    let providerKey: String
    var subtitle: String?
    var disabled: Bool = false

    var body: some View {
        HStack(spacing: 14) {
            ProviderMarks.mark(for: providerKey, size: 22)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(instanceTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(modelTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 62)
        .contentShape(Rectangle())
        .opacity(disabled ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(instanceTitle), \(modelTitle)")
    }
}

/// Shared catalog surface for chat, profile, and settings pickers.
struct ModelPickerCatalogHost: View {
    let instances: [Instance]
    let loading: Bool
    let error: String?
    let canEdit: Bool
    let working: Bool
    let saving: Bool
    @Binding var draft: ModelPickerDraft
    var hostWide: Bool = false
    var onRetry: () -> Void
    var hermesEndpoints: [HermesEndpointOption] = []
    var selectedHermesId: String? = nil
    var onSelectHermes: ((HermesEndpointOption) -> Void)? = nil

    private var currentSelection: ModelSelection {
        ModelSelection(instanceId: draft.instanceId, model: draft.modelId, effort: draft.effort)
    }

    private var presentation: ModelCatalogPresentation {
        ModelCatalogPresentation.surface(
            loading: loading,
            error: error,
            instances: instances,
            canEdit: canEdit,
            selection: currentSelection
        )
    }

    private var switchBlocked: Bool {
        presentation.selectionDisabled
            || !ModelSelectionPolicy.allowsSwitch(working: working, saving: saving, catalogLoading: loading)
            || hostWide
    }

    private var footer: String {
        ModelSelectionPolicy.footerHint(working: working, canEdit: canEdit, hostWide: hostWide)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch presentation {
            case .loading:
                ModelPickerLoadingView()
                    .frame(maxWidth: .infinity, alignment: .leading)
            case let .error(message):
                ModelPickerErrorView(message: message, retry: onRetry)
            case .empty:
                ModelPickerEmptyView()
            case let .catalog(_, refreshError, refreshing):
                if let refreshError {
                    ModelPickerErrorView(message: refreshError, retry: onRetry)
                } else if refreshing {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text(ModelSelectionPolicy.refreshingExplanation)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(ModelSelectionPolicy.refreshingExplanation)
                }
                VStack(alignment: .leading, spacing: 12) {
                    ModelPickerProviderRail(
                        instances: instances,
                        draft: $draft,
                        disabled: switchBlocked
                    )
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            ModelPickerView(
                                instances: instances,
                                draft: $draft,
                                disabled: switchBlocked,
                                hostWide: hostWide,
                                footerHint: footer
                            )

                            if !hermesEndpoints.isEmpty {
                                HermesRuntimePickerRows(
                                    endpoints: hermesEndpoints,
                                    selectedId: selectedHermesId,
                                    onSelect: { endpoint in onSelectHermes?(endpoint) }
                                )
                            }

                            if canEdit, !loading {
                                Button(ModelSelectionPolicy.refreshModels) {
                                    onRetry()
                                }
                                .font(.footnote.weight(.medium))
                                .frame(minHeight: VBotSurface.Hit.minimum)
                                .disabled(presentation.selectionDisabled && !presentation.isRefreshing)
                            }

                            if saving {
                                Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Host-wide reconstructed provider picker. Uses advertised `selectable` /
/// `modelSelectable` flags instead of a vendor name.
struct ReconstructedProviderPicker: View {
    let providers: [VBotProvider]
    let selectedProvider: String
    let selectedModelId: String
    var models: [VBotProviderModel]
    var disabled: Bool = false
    var onProviderChange: (String) -> Void
    var onModelChange: (String) -> Void

    private var selected: VBotProvider? {
        providers.first { $0.id == selectedProvider }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(providers) { provider in
                        Button {
                            guard !disabled, provider.selectable else { return }
                            onProviderChange(provider.id)
                        } label: {
                            VStack(spacing: 6) {
                                ProviderMarks.mark(for: provider.id, size: 20)
                                Text(provider.label)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(selectedProvider == provider.id ? Color.primary : .secondary)
                                    .lineLimit(1)
                            }
                            .frame(width: 72)
                            .padding(.vertical, 10)
                            .background(
                                selectedProvider == provider.id
                                    ? ModelPickerStyle.chipSelected
                                    : ModelPickerStyle.chip,
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                            )
                            .opacity(provider.selectable ? 1 : 0.55)
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled || !provider.selectable)
                    }
                }
            }

            if let selected, selected.modelSelectable, !models.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                        ModelRow(
                            label: AdvertisedModelCatalog.displayModelLabel(model.id),
                            selected: model.id == selectedModelId,
                            isDefault: model.current,
                            disabled: disabled
                        ) {
                            onModelChange(model.id)
                        }
                        if index < models.count - 1 {
                            Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                        }
                    }
                }
                .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if selected?.modelSelectable == false {
                Label(ModelSelectionPolicy.providerKeepsLocalModel, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Compact Hermes endpoint rows for the model/runtime picker. Labels stay
/// `Computer / profile`; subscription model ids stay the model id only.
struct HermesRuntimePickerRows: View {
    let endpoints: [HermesEndpointOption]
    let selectedId: String?
    var onSelect: (HermesEndpointOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(endpoints) { endpoint in
                Button {
                    onSelect(endpoint)
                } label: {
                    HStack {
                        Text(ModelSelectionPolicy.hermesRuntimeLabel(endpoint))
                            .font(.body)
                        Spacer()
                        if selectedId == endpoint.id {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
        }
        .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

#if DEBUG
/// Debug-only screenshot host. Launch with `-open-provider-settings`.
struct ProviderSettingsPreviewHost: View {
    private let instances: [Instance]
    @State private var saved: ModelSelection
    @State private var draft: ModelPickerDraft
    @State private var applyCount = 0

    init() {
        var catalog = Session.storePreviewProviderCatalog()
        if let path = ProcessInfo.processInfo.environment["VBOT_MODEL_CATALOG_FIXTURE"],
           let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
           let fixture = try? JSONDecoder().decode(InstanceList.self, from: data) {
            catalog = fixture.instances
        }
        instances = catalog
        let selection = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "medium")
        _saved = State(initialValue: selection)
        _draft = State(initialValue: ModelPickerDraftPolicy.makeDraft(selection: selection, instances: catalog,
            catalog: ModelFamilyPolicy.catalog(from: catalog, selection: selection)))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                ModelPickerCatalogHost(instances: instances, loading: false, error: nil,
                    canEdit: true, working: false, saving: false, draft: $draft, onRetry: {})
                Text("Saved: \(saved.instanceId) / \(saved.model) / \(saved.effort ?? "default") · applies \(applyCount)")
                    .font(.caption2).foregroundStyle(.secondary)
                    .accessibilityIdentifier("model-preview-saved")
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, 12)
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        draft = ModelPickerDraftPolicy.makeDraft(selection: saved, instances: instances,
                            catalog: ModelFamilyPolicy.catalog(from: instances, selection: saved))
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        guard let next = ModelPickerDraftPolicy.resolvedSelection(draft: draft, instances: instances) else { return }
                        saved = next
                        applyCount += 1
                        draft.openedWith = next
                    }
                    .disabled(ModelPickerDraftPolicy.applyBlock(draft: draft, remote: saved, working: false,
                        canEdit: true, saving: false, catalogLoading: false, hostWide: false, instances: instances) != nil)
                }
            }
            .vbotCanvas()
        }
    }
}

private enum ModelPickerPreviewData {
    static let instances: [Instance] = {
        let json = """
        [
          {
            "instanceId":"claude","driverKind":"claudeAgent","displayName":"Claude",
            "snapshot":{"state":"available"},
            "models":{"default":"claude-sonnet-5","options":[
              {"id":"claude-sonnet-5","label":"Claude Sonnet 5"},
              {"id":"claude-haiku-4-5","label":"Claude Haiku 4.5"}
            ]}
          },
          {
            "instanceId":"codex","driverKind":"codex","displayName":"Codex",
            "snapshot":{"state":"available"},
            "models":{"default":"gpt-5.6-sol","options":[
              {"id":"gpt-5.6-sol","label":"GPT 5.6 Sol"}
            ]}
          },
          {
            "instanceId":"cursor","driverKind":"cursorAgent","displayName":"Cursor",
            "snapshot":{"state":"available"},
            "models":{"default":"auto","options":[
              {"id":"auto","label":"Auto"},
              {"id":"composer-2.5","label":"Composer 2.5"}
            ]}
          }
        ]
        """
        return (try? JSONDecoder().decode([Instance].self, from: Data(json.utf8))) ?? []
    }()

    static func draft(instanceId: String, modelId: String, instances: [Instance]) -> ModelPickerDraft {
        let selection = ModelSelection(instanceId: instanceId, model: modelId)
        return ModelPickerDraftPolicy.makeDraft(
            selection: selection,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: selection)
        )
    }
}

#Preview("Catalog loading") {
    ModelPickerLoadingView()
        .padding()
        .vbotCanvas()
}

#Preview("Catalog error") {
    ModelPickerErrorView(message: "Could not load models from this computer.") {}
        .padding()
        .vbotCanvas()
}

#Preview("Catalog empty") {
    ModelPickerEmptyView()
        .padding()
        .vbotCanvas()
}

#Preview("Catalog ready") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        draft: .constant(ModelPickerPreviewData.draft(
            instanceId: "claude",
            modelId: "claude-sonnet-5",
            instances: ModelPickerPreviewData.instances
        )),
        footerHint: ModelSelectionPolicy.idleHint
    )
    .padding()
    .vbotCanvas()
}

#Preview("Catalog busy") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        draft: .constant(ModelPickerPreviewData.draft(
            instanceId: "claude",
            modelId: "claude-sonnet-5",
            instances: ModelPickerPreviewData.instances
        )),
        disabled: true,
        footerHint: ModelSelectionPolicy.busyExplanation
    )
    .padding()
    .vbotCanvas()
}

#Preview("Catalog offline cached") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        draft: .constant(ModelPickerPreviewData.draft(
            instanceId: "claude",
            modelId: "claude-sonnet-5",
            instances: ModelPickerPreviewData.instances
        )),
        disabled: true,
        footerHint: CalmSurfacePolicy.reconnectToEdit
    )
    .padding()
    .vbotCanvas()
}
#endif
