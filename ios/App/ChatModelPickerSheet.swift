import CompanionCore
import SwiftUI

/// Shared chat/profile model picker. Draft edits never PATCH until Apply.
struct ChatModelPickerSheet: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var instances: [Instance]
    @State private var instancesLoading: Bool
    @State private var instancesError: String?
    @State private var draft: ModelPickerDraft
    @State private var openedConnectionId: String?
    @State private var initializedDraft = false
    @State private var savingModel = false
    @State private var saveError: String?
    @State private var modelSaveRevision = 0
    @State private var showingHermesConversion = false
    @State private var selectedHermesEndpoint: HermesEndpointOption?
    @State private var includeContextSummary = false

    init(bot: Bot) {
        self.bot = bot
        let selection = bot.modelSelection
        _draft = State(initialValue: ModelPickerDraft(
            browsingProviderId: selection.instanceId,
            familyKey: ModelFamilyPolicy.parse(selection.model).familyKey,
            instanceId: selection.instanceId,
            modelId: selection.model,
            effort: ModelFamilyPolicy.parse(selection.model).axes.effort ?? selection.effort,
            thinking: ModelFamilyPolicy.parse(selection.model).axes.thinking,
            fast: ModelFamilyPolicy.parse(selection.model).axes.fast,
            oneM: ModelFamilyPolicy.parse(selection.model).axes.explicitOneM,
            openedWith: selection
        ))
        _instances = State(initialValue: [])
        _instancesLoading = State(initialValue: true)
        _instancesError = State(initialValue: nil)
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var canEdit: Bool {
        CalmSurfacePolicy.canEditRemoteContent(
            isLive: session.status == .live,
            hasConnection: session.connection != nil && session.connection?.id == openedConnectionId
        )
    }
    private var hostWide: Bool { EngineSyncPolicy.hostWideSelection(session.engineSync) }
    private var catalogLoading: Bool {
        ModelCatalogLoadPolicy.hostLoading(
            localLoading: instancesLoading,
            sessionRefreshing: session.modelCatalogRefreshing
        )
    }
    private var applyBlock: ModelPickerApplyBlock? {
        ModelPickerDraftPolicy.applyBlock(
            draft: draft,
            remote: current.modelSelection,
            working: current.busy == true,
            canEdit: canEdit,
            saving: savingModel,
            catalogLoading: catalogLoading,
            hostWide: hostWide,
            instances: instances
        )
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ModelPickerCatalogHost(
                    instances: instances,
                    loading: catalogLoading,
                    error: instancesError,
                    canEdit: canEdit,
                    working: current.busy == true,
                    saving: savingModel,
                    draft: $draft,
                    hostWide: hostWide,
                    onRetry: { Task { await loadInstances() } },
                    hermesEndpoints: session.hermesEndpointOptions,
                    selectedHermesId: selectedHermesEndpoint?.id ?? session.defaultHermesEndpoint()?.id,
                    onSelectHermes: { endpoint in
                        guard ModelSelectionPolicy.allowsHermesRuntimeSwitch(working: current.busy == true) else { return }
                        selectedHermesEndpoint = endpoint
                        if HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: true) {
                            showingHermesConversion = true
                        }
                    }
                )
                .padding(.horizontal, 20)
                .padding(.top, 12)
                if let message = saveError ?? applyMessage(applyBlock) {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                }
            }
            .background(VBotSurface.background.ignoresSafeArea())
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(savingModel)
                        .frame(minHeight: VBotSurface.Hit.minimum)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ModelSelectionPolicy.applyTitle) {
                        Task { await applyDraft() }
                    }
                    .disabled(applyBlock != nil)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                }
            }
        }
        .interactiveDismissDisabled(savingModel)
        .task {
            if openedConnectionId == nil { openedConnectionId = session.connection?.id }
            await loadInstances()
        }
        .sheet(isPresented: $showingHermesConversion) {
            hermesConversionSheet
        }
        .onChange(of: session.modelCatalogRefreshing) { _, _ in
            applySessionCatalogSnapshot()
        }
        .onChange(of: session.modelCatalog) { _, _ in
            applySessionCatalogSnapshot()
        }
        .onChange(of: session.connection?.id) { _, newId in
            if openedConnectionId == nil, newId != nil {
                saveError = "A computer connected after this picker opened. Cancel and reopen to verify this agent."
            }
            if let openedConnectionId, newId != openedConnectionId {
                modelSaveRevision &+= 1
                session.invalidateModelUpdates(for: bot.id)
                savingModel = false
                saveError = "The connected computer changed. Cancel and reopen the model picker."
            }
        }
        .onChange(of: current.busy) { was, isBusy in
            if ModelSelectionPolicy.shouldRevertDraft(wasWorking: was == true, isWorking: isBusy == true) {
                modelSaveRevision &+= 1
                session.invalidateModelUpdates(for: current.id)
                resetDraft(to: current.modelSelection)
                savingModel = false
                saveError = nil
            }
        }
    }

    private var hermesConversionSheet: some View {
        NavigationStack {
            let endpoint = HermesConversionConfirmationPolicy.endpointForConfirmedConversion(
                draft: selectedHermesEndpoint,
                persistedDefault: session.defaultHermesEndpoint()
            )
            let copy = HermesConversionConfirmationPolicy.confirmationCopy(
                botName: current.name,
                computerName: endpoint?.computerName ?? "",
                profile: endpoint?.profile ?? ""
            )
            VStack(alignment: .leading, spacing: 16) {
                Text(copy.summary)
                Text(copy.onlyThisBot)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(copy.preserved)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                DisclosureGroup(HermesConversionConfirmationPolicy.contextHandoffTitle) {
                    Text(HermesConversionConfirmationPolicy.contextHandoffDetail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Toggle("Include sanitized summary", isOn: $includeContextSummary)
                        .font(.subheadline)
                }
                .font(.subheadline.weight(.medium))
                Spacer()
                Button("Convert") {
                    showingHermesConversion = false
                    guard let endpoint else { return }
                    if HermesConversionConfirmationPolicy.shouldPersistDefaultOnConfirmedConversion() {
                        session.setDefaultHermesEndpoint(endpoint)
                    }
                    session.configureHermesRuntime(
                        botId: current.id,
                        request: HermesConversionConfirmationPolicy.applyRequest(
                            endpoint: endpoint,
                            includeContextSummary: includeContextSummary
                        )
                    )
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(selectedHermesEndpoint == nil && session.defaultHermesEndpoint() == nil)
            }
            .padding()
            .navigationTitle("Convert runtime")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        selectedHermesEndpoint = HermesConversionConfirmationPolicy.draftEndpointAfterCancel()
                        showingHermesConversion = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func applySessionCatalogSnapshot() {
        let refreshing = session.modelCatalogRefreshing
        if ModelCatalogLoadPolicy.shouldReplaceDisplayedCatalog(
            incomingIsEmpty: session.modelCatalog.isEmpty,
            sessionRefreshing: refreshing
        ) {
            instances = session.modelCatalog
        }
        instancesError = session.modelCatalogError
        instancesLoading = ModelCatalogLoadPolicy.localLoadingAfterSessionPublish(
            sessionRefreshing: refreshing
        )
    }

    private func loadInstances() async {
        if instances.isEmpty {
            instances = session.modelCatalog
            if !instances.isEmpty {
                hydrateDraftIfUnchanged()
            }
        }
        instancesLoading = true
        switch await session.loadModelCatalog() {
        case let .loaded(loaded):
            instances = loaded
            instancesError = nil
            hydrateDraftIfUnchanged()
            instancesLoading = false
        case let .failed(message):
            instancesError = message
            instancesLoading = false
        case .cancelled:
            applySessionCatalogSnapshot()
            instancesLoading = ModelCatalogLoadPolicy.waiterStillLoading(
                resultCancelled: true,
                sessionRefreshing: session.modelCatalogRefreshing
            )
        }
    }

    private func hydrateDraftIfUnchanged() {
        guard !initializedDraft else { return }
        initializedDraft = true
        guard ModelPickerDraftPolicy.cancelDiscardsWithoutPatch(draft: draft, openedWith: draft.openedWith) else { return }
        // A catalog refresh changes available options, never the user's draft.
        resetDraft(to: draft.openedWith)
    }

    private func resetDraft(to selection: ModelSelection) {
        draft = ModelPickerDraftPolicy.makeDraft(
            selection: selection,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: selection)
        )
    }

    private func applyDraft() async {
        guard session.connection?.id == openedConnectionId, session.state.bot(bot.id) != nil else {
            saveError = "This agent is no longer available on the connected computer."
            return
        }
        let remote = current.modelSelection
        let block = ModelPickerDraftPolicy.applyBlock(
            draft: draft,
            remote: remote,
            working: current.busy == true,
            canEdit: canEdit,
            saving: savingModel,
            catalogLoading: catalogLoading,
            hostWide: hostWide,
            instances: instances
        )
        guard block == nil, let patch = ModelPickerDraftPolicy.patch(from: draft, instances: instances) else {
            saveError = applyMessage(block)
            return
        }
        modelSaveRevision &+= 1
        let revision = modelSaveRevision
        savingModel = true
        saveError = nil
        defer {
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) {
                savingModel = false
            }
        }
        guard let updated = await session.updateModel(patch, for: current) else {
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) {
                saveError = session.actionError ?? "Could not save model."
            }
            return
        }
        guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) else { return }
        guard session.connection?.id == openedConnectionId else { return }
        resetDraft(to: updated.modelSelection)
        Haptics.success()
        dismiss()
    }

    private func applyMessage(_ block: ModelPickerApplyBlock?) -> String? {
        switch block {
        case .busy: return ModelSelectionPolicy.busyExplanation
        case .offline: return CalmSurfacePolicy.reconnectToEdit
        case .remoteUpdated: return "This agent's model changed on the computer. Cancel and reopen to avoid overwriting it."
        case .invalid: return "That combination is not advertised for this source."
        case .hostWide: return ModelSelectionPolicy.hostWideHint
        default: return nil
        }
    }
}

/// Compact header chip showing the bot's current model, effort, and Fast.
struct ChatModelPickerButton: View {
    let bot: Bot
    @Binding var showingPicker: Bool
    @EnvironmentObject private var session: Session

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var working: Bool { current.busy == true }
    private var summary: (title: String, source: String) {
        ModelSelectionPolicy.headerSummary(
            selection: current.modelSelection,
            instances: session.modelCatalog
        )
    }

    var body: some View {
        Button {
            Haptics.selection()
            showingPicker = true
        } label: {
            HStack(spacing: 4) {
                ProviderMarks.mark(
                    for: AdvertisedModelCatalog.providerMarkKey(
                        instanceId: current.modelSelection.instanceId,
                        instances: session.modelCatalog
                    ),
                    size: 14
                )
                Text(summary.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 10)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsuleBackdrop()
        .fixedSize(horizontal: false, vertical: true)
        .opacity(working ? 0.7 : 1)
        .accessibilityLabel("Model, \(summary.source), \(summary.title)")
        .accessibilityHint(
            working
                ? ModelSelectionPolicy.busyExplanation
                : "Opens model picker"
        )
        .accessibilityValue(working ? ModelSelectionPolicy.busyExplanation : "\(summary.title), \(summary.source)")
    }
}
