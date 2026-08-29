import CompanionCore
import SwiftUI

/// Inline model picker for the chat header — compact chip + sheet.
struct ChatModelPickerSheet: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var instances: [Instance] = []
    @State private var instancesLoading = true
    @State private var instancesError: String?
    @State private var pickedInstanceId: String
    @State private var pickedModel: String
    @State private var pickedEffort: String?
    @State private var savingModel = false

    init(bot: Bot) {
        self.bot = bot
        _pickedInstanceId = State(initialValue: bot.modelSelection.instanceId)
        _pickedModel = State(initialValue: bot.modelSelection.model)
        _pickedEffort = State(initialValue: bot.modelSelection.effort)
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var advertisedInstances: [Instance] { AdvertisedModelCatalog.selectableInstances(from: instances) }
    private var pickedInstance: Instance? { AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances) }
    private var effortLevels: [String] { pickedInstance?.capabilities?.effortLevels ?? [] }
    private var showsEffortPicker: Bool {
        !effortLevels.isEmpty && session.engineSync?.usesReconstructedMutations != true
    }
    private var modelSwitchBlocked: Bool { savingModel || current.busy == true || instancesLoading }
    private var reconstructedModelDisabled: Bool {
        session.engineSync?.usesReconstructedMutations == true && pickedInstanceId != "cursor"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if instancesLoading {
                        ProgressView("Loading models")
                    } else if let instancesError {
                        Label(instancesError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                        Button("Try again") { Task { await loadInstances() } }
                    } else {
                        ModelPickerView(
                            instances: instances,
                            selectedInstanceId: $pickedInstanceId,
                            selectedModelId: $pickedModel,
                            disabled: modelSwitchBlocked || advertisedInstances.isEmpty,
                            modelsDisabled: reconstructedModelDisabled,
                            footerHint: current.busy == true
                                ? "Interrupt this agent before switching models."
                                : "Changes apply to the next message."
                        ) {
                            alignEffort()
                            Task { await saveModel() }
                        }

                        if showsEffortPicker {
                            Picker("Reasoning", selection: effortBinding) {
                                Text("Default").tag(Optional<String>.none)
                                ForEach(effortLevels, id: \.self) { level in
                                    Text(ChatModelPickerSheet.effortLabel(level)).tag(Optional.some(level))
                                }
                            }
                            .disabled(modelSwitchBlocked)
                            .onChange(of: pickedEffort) { _, _ in
                                Task { await saveModel() }
                            }
                        }

                        if savingModel {
                            Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
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
        .onChange(of: current.modelSelection) { _, selection in
            pickedInstanceId = selection.instanceId
            pickedModel = selection.model
            pickedEffort = selection.effort
        }
    }

    private var effortBinding: Binding<String?> {
        Binding(
            get: { pickedEffort },
            set: { pickedEffort = $0 }
        )
    }

    private func alignEffort() {
        let levels = pickedInstance?.capabilities?.effortLevels ?? []
        if let effort = pickedEffort, !levels.contains(effort) {
            pickedEffort = nil
        }
    }

    private func loadInstances() async {
        instancesLoading = true
        defer { instancesLoading = false }
        switch await session.loadInstances() {
        case let .loaded(loaded):
            instances = loaded
            instancesError = nil
            pickedModel = AdvertisedModelCatalog.alignedModel(
                instanceId: pickedInstanceId,
                currentModel: pickedModel,
                in: instances
            )
        case let .failed(message):
            instances = []
            instancesError = message
        case .cancelled:
            break
        }
    }

    private func saveModel() async {
        guard !modelSwitchBlocked else { return }
        savingModel = true
        defer { savingModel = false }
        let patch = BotModelPatch(
            instanceId: pickedInstanceId,
            model: pickedModel,
            effort: pickedEffort
        )
        if let updated = await session.updateModel(patch, for: current) {
            pickedInstanceId = updated.modelSelection.instanceId
            pickedModel = updated.modelSelection.model
            pickedEffort = updated.modelSelection.effort
        }
    }

    static func effortLabel(_ level: String?) -> String {
        guard let level, !level.isEmpty else { return "Default" }
        return level.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}

/// Compact header chip showing the bot's current engine + model.
struct ChatModelPickerButton: View {
    let bot: Bot
    @Binding var showingPicker: Bool
    @EnvironmentObject private var session: Session

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var instanceTitle: String {
        current.modelSelection.instanceId
            .split(separator: "-")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
    private var modelTitle: String {
        let id = current.modelSelection.model
        if id == "auto" { return "Auto" }
        return id.split(separator: "-").prefix(2).map { $0.capitalized }.joined(separator: " ")
    }

    var body: some View {
        Button {
            Haptics.selection()
            showingPicker = true
        } label: {
            HStack(spacing: 4) {
                ProviderMarks.mark(for: current.modelSelection.instanceId, size: 14)
                Text(modelTitle)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .fixedSize()
        .accessibilityLabel("Model, \(instanceTitle), \(modelTitle)")
        .accessibilityHint("Opens model picker")
        .disabled(current.busy == true)
        .opacity(current.busy == true ? 0.5 : 1)
    }
}
