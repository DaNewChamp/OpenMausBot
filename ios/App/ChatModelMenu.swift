import SwiftUI
import CompanionCore

/// Compact engine/model/reasoning picker for the chat header.
struct ChatModelMenu: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @State private var instances: [Instance] = []
    @State private var saving = false
    @State private var saveRevision = 0

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var advertised: [Instance] {
        AdvertisedModelCatalog.displayCatalog(
            advertised: instances,
            selection: current.modelSelection
        )
    }
    private var instance: Instance? {
        AdvertisedModelCatalog.instance(id: current.modelSelection.instanceId, in: advertised)
    }
    private var modelLabel: String {
        AdvertisedModelCatalog.humanModelLabel(selection: current.modelSelection, instances: advertised)
    }
    private var subtitle: String {
        if let effort = current.modelSelection.effort, !effort.isEmpty {
            return "\(modelLabel) · \(ModelEffortPicker.effortLabel(effort))"
        }
        return modelLabel
    }
    private var blocked: Bool {
        !ModelSelectionPolicy.allowsSwitch(working: current.busy == true, saving: saving)
    }
    private var hostWide: Bool { EngineSyncPolicy.hostWideSelection(session.engineSync) }

    var body: some View {
        Menu {
            if advertised.isEmpty {
                Text("Loading engines…")
            } else {
                ForEach(advertised) { provider in
                    Menu(provider.pickerTitle) {
                        ForEach(provider.models.options) { option in
                            Button {
                                Task { await apply(instanceId: provider.instanceId, model: option.id, effort: current.modelSelection.effort) }
                            } label: {
                                if provider.instanceId == current.modelSelection.instanceId,
                                   option.id == current.modelSelection.model {
                                    Label(option.label, systemImage: "checkmark")
                                } else {
                                    Text(option.label)
                                }
                            }
                            .disabled(blocked || !provider.allowsInstanceChange)
                        }
                    }
                }
                if let levels = instance?.capabilities?.effortLevels,
                   ModelSelectionPolicy.showsEffortPicker(levels: levels, hostWideEngine: hostWide) {
                    Divider()
                    Button("Default reasoning") {
                        Task { await apply(instanceId: current.modelSelection.instanceId, model: current.modelSelection.model, effort: nil) }
                    }
                    .disabled(blocked || current.modelSelection.effort == nil)
                    ForEach(levels, id: \.self) { level in
                        Button {
                            Task { await apply(instanceId: current.modelSelection.instanceId, model: current.modelSelection.model, effort: level) }
                        } label: {
                            if current.modelSelection.effort == level {
                                Label(ModelEffortPicker.effortLabel(level), systemImage: "checkmark")
                            } else {
                                Text(ModelEffortPicker.effortLabel(level))
                            }
                        }
                        .disabled(blocked)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                ProviderMarks.mark(
                    for: AdvertisedModelCatalog.providerMarkKey(
                        instanceId: current.modelSelection.instanceId,
                        instances: advertised
                    ),
                    size: 14
                )
                Text(subtitle)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .fixedSize()
        .opacity(blocked ? 0.7 : 1)
        .accessibilityLabel("Model and reasoning")
        .accessibilityValue(subtitle)
        .accessibilityHint(
            current.busy == true
                ? ModelSelectionPolicy.busyExplanation
                : "Choose this agent's engine, model, and reasoning level"
        )
        .task(id: current.id) {
            if instances.isEmpty { instances = session.modelCatalog }
            if case let .loaded(loaded) = await session.loadModelCatalog() {
                instances = loaded
            }
        }
    }

    @MainActor
    private func apply(instanceId: String, model: String, effort: String?) async {
        guard !blocked else { return }
        saveRevision &+= 1
        let revision = saveRevision
        saving = true
        defer {
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: saveRevision) {
                saving = false
            }
        }
        let effortPatch: BotModelPatch.EffortUpdate = {
            if let effort { return .set(effort) }
            if current.modelSelection.effort != nil { return .clear }
            return .omitted
        }()
        let patch = BotModelPatch(instanceId: instanceId, model: model, effort: effortPatch)
        guard let _ = await session.updateModel(patch, for: current) else { return }
        guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: saveRevision) else { return }
        Haptics.selection()
    }
}
