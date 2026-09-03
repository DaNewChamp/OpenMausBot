import CompanionCore
import SwiftUI

/// Inline model picker for the chat header — compact chip + sheet.
struct ChatModelPickerSheet: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var instances: [Instance]
    @State private var instancesLoading: Bool
    @State private var instancesError: String?
    @State private var pickedInstanceId: String
    @State private var pickedModel: String
    @State private var pickedEffort: String?
    @State private var savingModel = false
    @State private var modelSaveRevision = 0
    @State private var showingHermesConversion = false
    @State private var selectedHermesEndpoint: HermesEndpointOption?
    @State private var includeContextSummary = false

    init(bot: Bot) {
        self.bot = bot
        _pickedInstanceId = State(initialValue: bot.modelSelection.instanceId)
        _pickedModel = State(initialValue: bot.modelSelection.model)
        _pickedEffort = State(initialValue: bot.modelSelection.effort)
        _instances = State(initialValue: [])
        _instancesLoading = State(initialValue: true)
        _instancesError = State(initialValue: nil)
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var canEdit: Bool {
        CalmSurfacePolicy.canEditRemoteContent(
            isLive: session.status == .live,
            hasConnection: session.connection != nil
        )
    }
    private var pickedInstance: Instance? {
        AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances)
    }
    private var effortLevels: [String] { pickedInstance?.capabilities?.effortLevels ?? [] }
    private var hostWide: Bool { EngineSyncPolicy.hostWideSelection(session.engineSync) }
    private var showsEffortPicker: Bool {
        ModelSelectionPolicy.showsEffortPicker(levels: effortLevels, hostWideEngine: hostWide)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                ModelPickerCatalogHost(
                    instances: instances,
                    loading: ModelCatalogLoadPolicy.hostLoading(
                        localLoading: instancesLoading,
                        sessionRefreshing: session.modelCatalogRefreshing
                    ),
                    error: instancesError,
                    canEdit: canEdit,
                    working: current.busy == true,
                    saving: savingModel,
                    selectedInstanceId: $pickedInstanceId,
                    selectedModelId: $pickedModel,
                    effortLevels: effortLevels,
                    selectedEffort: $pickedEffort,
                    showsEffort: showsEffortPicker,
                    hostWide: hostWide,
                    onRetry: { Task { await loadInstances() } },
                    onSelectionChange: { Task { await saveModel() } },
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
                .padding(20)
            }
            .background(VBotSurface.background.ignoresSafeArea())
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await loadInstances() }
        .sheet(isPresented: $showingHermesConversion) {
            hermesConversionSheet
        }
        .onChange(of: session.modelCatalogRefreshing) { _, _ in
            applySessionCatalogSnapshot()
        }
        .onChange(of: session.modelCatalog) { _, _ in
            applySessionCatalogSnapshot()
        }
        .onChange(of: current.modelSelection) { _, selection in
            pickedInstanceId = selection.instanceId
            pickedModel = selection.model
            pickedEffort = selection.effort
        }
        .onChange(of: current.busy) { was, isBusy in
            if ModelSelectionPolicy.shouldRevertDraft(wasWorking: was == true, isWorking: isBusy == true) {
                modelSaveRevision &+= 1
                session.invalidateModelUpdates(for: current.id)
                let selection = current.modelSelection
                pickedInstanceId = selection.instanceId
                pickedModel = selection.model
                pickedEffort = selection.effort
                savingModel = false
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
            if !instances.isEmpty {
                let resolved = ProviderCatalogPolicy.resolveSelection(current.modelSelection, in: instances)
                pickedInstanceId = resolved.instanceId
                pickedModel = resolved.model
            }
        }
        instancesError = session.modelCatalogError
        instancesLoading = ModelCatalogLoadPolicy.localLoadingAfterSessionPublish(
            sessionRefreshing: refreshing
        )
    }

    private func loadInstances() async {
        if instances.isEmpty {
            instances = session.modelCatalog
        }
        instancesLoading = true
        switch await session.loadModelCatalog() {
        case let .loaded(loaded):
            instances = loaded
            instancesError = nil
            let resolved = ProviderCatalogPolicy.resolveSelection(current.modelSelection, in: loaded)
            pickedInstanceId = resolved.instanceId
            pickedModel = resolved.model
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

    private func saveModel() async {
        guard ModelSelectionPolicy.allowsSwitch(
            working: current.busy == true,
            saving: false,
            catalogLoading: ModelCatalogLoadPolicy.hostLoading(
                localLoading: instancesLoading,
                sessionRefreshing: session.modelCatalogRefreshing
            )
        ), canEdit else { return }
        modelSaveRevision &+= 1
        let revision = modelSaveRevision
        savingModel = true
        defer {
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) {
                savingModel = false
            }
        }
        let effortPatch: BotModelPatch.EffortUpdate = {
            if showsEffortPicker {
                if let pickedEffort { return .set(pickedEffort) }
                return .clear
            }
            return .omitted
        }()
        let patch = BotModelPatch(
            instanceId: pickedInstanceId,
            model: pickedModel,
            effort: effortPatch
        )
        guard let updated = await session.updateModel(patch, for: current) else { return }
        guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) else { return }
        pickedInstanceId = updated.modelSelection.instanceId
        pickedModel = updated.modelSelection.model
        pickedEffort = updated.modelSelection.effort
    }
}

/// Compact header chip showing the bot's current engine + model.
struct ChatModelPickerButton: View {
    let bot: Bot
    @Binding var showingPicker: Bool
    @EnvironmentObject private var session: Session

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var working: Bool { current.busy == true }
    private var modelTitle: String {
        AdvertisedModelCatalog.humanModelLabel(
            selection: current.modelSelection,
            instances: session.modelCatalog
        )
    }
    private var instanceTitle: String {
        AdvertisedModelCatalog.instance(
            id: current.modelSelection.instanceId,
            in: session.modelCatalog
        )?.pickerTitle
            ?? AdvertisedModelCatalog.displayModelLabel(current.modelSelection.instanceId)
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
                Text(modelTitle)
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
        .fixedSize()
        .opacity(working ? 0.7 : 1)
        .accessibilityLabel("Model, \(instanceTitle), \(modelTitle)")
        .accessibilityHint(
            working
                ? ModelSelectionPolicy.busyExplanation
                : "Opens model picker"
        )
        .accessibilityValue(working ? ModelSelectionPolicy.busyExplanation : modelTitle)
    }
}
