import SwiftUI
import CompanionCore

/// Compact engine/model/reasoning picker for the chat header.
struct ChatModelMenu: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @State private var instances: [Instance] = []
    @State private var saving = false

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var instance: Instance? {
        AdvertisedModelCatalog.instance(id: current.modelSelection.instanceId, in: instances)
    }

    private var modelLabel: String {
        instance?.modelLabel(for: current.modelSelection.model) ?? current.modelSelection.model
    }

    private var subtitle: String {
        if let effort = current.modelSelection.effort, !effort.isEmpty {
            return "\(modelLabel) · \(Self.effortLabel(effort))"
        }
        return modelLabel
    }

    private var blocked: Bool { current.busy == true || saving }

    var body: some View {
        Menu {
            if instances.isEmpty {
                Text("Loading engines…")
            } else {
                ForEach(advertisedInstances) { provider in
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
                            .disabled(blocked)
                        }
                    }
                }
                if let levels = instance?.capabilities?.effortLevels, !levels.isEmpty,
                   session.engineSync?.usesReconstructedMutations != true {
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
                                Label(Self.effortLabel(level), systemImage: "checkmark")
                            } else {
                                Text(Self.effortLabel(level))
                            }
                        }
                        .disabled(blocked)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.caption.weight(.semibold))
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
        .disabled(blocked && instances.isEmpty)
        .accessibilityLabel("Model and reasoning")
        .accessibilityValue(subtitle)
        .accessibilityHint(current.busy == true ? "Interrupt this agent before switching models" : "Choose this agent's engine, model, and reasoning level")
        .task(id: current.id) {
            if case let .loaded(loaded) = await session.loadInstances() {
                instances = loaded
            }
        }
    }

    private var advertisedInstances: [Instance] {
        AdvertisedModelCatalog.selectableInstances(from: instances)
    }

    @MainActor
    private func apply(instanceId: String, model: String, effort: String?) async {
        guard !blocked else { return }
        saving = true
        defer { saving = false }
        let effortPatch: BotModelPatch.EffortUpdate = {
            if let effort { return .set(effort) }
            if current.modelSelection.effort != nil { return .clear }
            return .omitted
        }()
        let patch = BotModelPatch(instanceId: instanceId, model: model, effort: effortPatch)
        _ = await session.updateModel(patch, for: current)
        Haptics.selection()
    }

    private static func effortLabel(_ level: String) -> String {
        switch level {
        case "xhigh": return "X-High"
        default: return level.capitalized
        }
    }
}

private extension Instance {
    var pickerTitle: String { displayName ?? instanceId }

    func modelLabel(for model: String) -> String {
        models.options.first(where: { $0.id == model })?.label ?? model
    }
}
