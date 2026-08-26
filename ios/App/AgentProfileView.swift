import AVFAudio
import CompanionCore
import PhotosUI
import SwiftUI
import UIKit

/// The paired-safe subset of an agent profile. Shared provider keys remain on
/// the computer; the phone sees only configured/not-configured status and the
/// renderer-neutral voice/avatar operations.
struct AgentProfileView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var name: String
    @State private var title: String
    @State private var description: String
    @State private var notifications: Bool
    @State private var crop: AvatarCrop
    @State private var voice: String
    @State private var speakReplies: Bool
    @State private var photo: PhotosPickerItem?
    @State private var prompt = ""
    @State private var voices: [Voice] = []
    @State private var config: ConfigStatus?
    @State private var instances: [Instance] = []
    @State private var instancesLoading = true
    @State private var instancesError: String?
    @State private var pickedInstanceId: String
    @State private var pickedModel: String
    @State private var busy = false
    @State private var savingModel = false
    @State private var modelSaveTask: Task<Void, Never>?
    @State private var modelSaveRevision = 0
    @State private var player: AVAudioPlayer?
    @State private var baseline: ProfileFormSnapshot
    @State private var selectedColor: String
    @State private var selectedShape = MascotMark.droplet
    @State private var showingInstructions = false
    @State private var instructionsBaseline = ""
    @State private var showingRoutines = false
    @State private var routines: [Routine] = []
    @State private var routinesLoading = true
    @State private var showingMedia = false
    @State private var showingModelAndVoice = false

    init(bot: Bot) {
        self.bot = bot
        _name = State(initialValue: bot.name)
        _title = State(initialValue: bot.title)
        _description = State(initialValue: bot.description)
        _notifications = State(initialValue: bot.notifications)
        _crop = State(initialValue: bot.avatarCrop ?? .mascot)
        _voice = State(initialValue: bot.voice ?? "")
        _speakReplies = State(initialValue: bot.speakReplies == true)
        _pickedInstanceId = State(initialValue: bot.modelSelection.instanceId)
        _pickedModel = State(initialValue: bot.modelSelection.model)
        _baseline = State(initialValue: ProfileFormSnapshot(bot: bot))
        _selectedColor = State(initialValue: bot.color)
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var heroBot: Bot {
        var value = current
        value.color = selectedColor
        return value
    }
    private var imageGenerationReady: Bool { config?.imageGen?.configured == true }
    private var voiceConfigured: Bool { config?.isTTSConfigured == true }
    private var hasWorkspaceDefaultVoice: Bool { config?.hasWorkspaceDefaultVoice == true }
    private var selectedVoiceCanSpeak: Bool { config?.canSpeak(agentVoice: voice) == true }
    private var advertisedInstances: [Instance] { AdvertisedModelCatalog.selectableInstances(from: instances) }
    private var pickedInstance: Instance? { AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances) }
    private var modelsForPickedInstance: [ModelOption] { pickedInstance?.models.options ?? [] }
    private var modelSwitchBlocked: Bool { busy || savingModel || current.busy == true || instancesLoading }
    private var currentProviderTitle: String { pickedInstance?.pickerTitle ?? pickedInstanceId }
    private var currentModelTitle: String { pickedInstance?.modelLabel(for: pickedModel) ?? pickedModel }
    private var botRoutines: [Routine] { routines.filter { $0.botId == current.id } }
    private var hasUnsavedChanges: Bool {
        !profilePatchIsEmpty || pickedInstanceId != current.modelSelection.instanceId || pickedModel != current.modelSelection.model
    }
    private var profilePatchIsEmpty: Bool {
        name == baseline.name && title == baseline.title && description == baseline.description
            && notifications == baseline.notifications && crop == baseline.crop
            && voice == baseline.voice && speakReplies == baseline.speakReplies
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                profileTopBar
                ScrollView {
                    VStack(spacing: 0) {
                        profileHero
                        identityCard
                        characterSection
                        instructionsRow
                        routinesSection
                        notificationsRow
                        secondaryControls
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 36)
                }
                .scrollIndicators(.hidden)
            }
            .background(AgentProfileStyle.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .overlay {
                if busy || savingModel {
                    ProgressView()
                        .controlSize(.large)
                        .tint(Color.primary)
                        .padding(22)
                        .background(AgentProfileStyle.card, in: Circle())
                        .accessibilityLabel("Saving")
                }
            }
            .task {
                await loadInstances()
                config = await session.configStatus()
                voices = await session.voiceOptions()
                let loaded = await session.loadRoutines()
                routines = loaded.routines.filter { $0.botId == current.id }
                routinesLoading = false
                if let config, !config.canSpeak(agentVoice: voice) {
                    speakReplies = false
                }
            }
            .onChange(of: current.modelSelection) { _, selection in
                pickedInstanceId = selection.instanceId
                pickedModel = selection.model
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
            .onChange(of: notifications) { _, _ in
                guard !busy else { return }
                Task { await save() }
            }
            .onDisappear {
                modelSaveTask?.cancel()
            }
            .sheet(isPresented: $showingInstructions) {
                instructionsEditor
            }
            .sheet(isPresented: $showingRoutines) {
                TasksRoutinesView()
            }
        }
    }

    // MARK: - Grok-style profile surface

    private var profileTopBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .background(AgentProfileStyle.control, in: Circle())
            .accessibilityLabel("Back")

            Spacer()

            Menu {
                Button("Save changes", systemImage: "checkmark") {
                    Task { await save() }
                }
                .disabled(!hasUnsavedChanges || busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Edit instructions", systemImage: "doc.text") {
                    instructionsBaseline = description
                    showingInstructions = true
                }
                Button("Tasks & routines", systemImage: "clock") {
                    showingRoutines = true
                }
                Divider()
                Button("Media & avatar", systemImage: "photo") {
                    showingMedia = true
                }
                Button("Model & voice", systemImage: "slider.horizontal.3") {
                    showingModelAndVoice = true
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .background(AgentProfileStyle.control, in: Circle())
            .accessibilityLabel("Profile actions")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var profileHero: some View {
        ZStack {
            Circle()
                .fill(MausPalette.color(current.color).opacity(0.16))
                .frame(width: 158, height: 158)
                .blur(radius: 22)
                .accessibilityHidden(true)

            BotAvatarView(
                bot: heroBot,
                size: 136,
                state: .happy,
                animated: !reduceMotion
            )
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 20)
        .padding(.bottom, 18)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(current.name) avatar")
    }

    private var identityCard: some View {
        VStack(spacing: 0) {
            TextField("Name", text: $name)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.words)
                .padding(.horizontal, 18)
                .frame(minHeight: 58)

            Divider().overlay(AgentProfileStyle.divider)

            TextField("Title (optional)", text: $title)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
                .frame(minHeight: 52)
        }
        .profileCard()
        .accessibilityElement(children: .contain)
    }

    private var characterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Character")

            VStack(spacing: 0) {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 6),
                    spacing: 18
                ) {
                    ForEach(profileColors) { choice in
                        Button {
                            selectedColor = choice.id
                        } label: {
                            Circle()
                                .fill(choice.color)
                                .frame(width: 34, height: 34)
                                .overlay {
                                    Circle()
                                        .stroke(
                                            selectedColor == choice.id ? Color.primary : .clear,
                                            lineWidth: 2
                                        )
                                        .padding(-5)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(choice.name) character color")
                        .accessibilityAddTraits(selectedColor == choice.id ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 20)

                Divider().overlay(AgentProfileStyle.divider)

                HStack(spacing: 8) {
                    ForEach(MascotMark.allCases) { mark in
                        Button {
                            selectedShape = mark
                        } label: {
                            Image(systemName: mark.systemImage)
                                .font(.system(size: 21, weight: .semibold))
                                .foregroundStyle(AgentProfileStyle.mascotOrange)
                                .frame(width: 30, height: 30)
                                .overlay {
                                    Circle()
                                        .stroke(
                                            selectedShape == mark ? Color.primary.opacity(0.72) : .clear,
                                            lineWidth: 2
                                        )
                                        .padding(-5)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(mark.label) character mark")
                        .accessibilityAddTraits(selectedShape == mark ? .isSelected : [])
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.vertical, 18)

                Divider().overlay(AgentProfileStyle.divider)

                Button("Reset to default") {
                    selectedColor = current.color
                    selectedShape = .droplet
                }
                .font(.body)
                .foregroundStyle(Color.accentColor)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
            }
            .profileCard()

            Text("How this bot's mark looks everywhere")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
        }
        .padding(.top, 26)
    }

    private var profileColors: [ProfileColorChoice] {
        [
            .init(id: "white", name: "White", color: Color.white),
            .init(id: "brown", name: "Brown", color: Color(red: 0.55, green: 0.34, blue: 0.20)),
            .init(id: "red", name: "Red", color: MausPalette.color("red")),
            .init(id: "orange", name: "Orange", color: MausPalette.color("orange")),
            .init(id: "yellow", name: "Yellow", color: MausPalette.color("yellow")),
            .init(id: "green", name: "Green", color: MausPalette.color("green")),
            .init(id: "teal", name: "Teal", color: MausPalette.color("teal")),
            .init(id: "blue", name: "Blue", color: MausPalette.color("blue")),
            .init(id: "purple", name: "Purple", color: MausPalette.color("purple")),
            .init(id: "pink", name: "Pink", color: MausPalette.color("pink")),
            .init(id: "gray", name: "Gray", color: Color.gray),
            .init(id: "cyan", name: "Cyan", color: MausPalette.color("cyan")),
        ]
    }

    private var instructionsRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Instructions")
            Button {
                instructionsBaseline = description
                showingInstructions = true
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Instructions")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Color.primary)
                        Text(description.isEmpty ? "Tell this bot how to work" : description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 17)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .profileCard()
            .accessibilityHint("Edit this agent's instructions")
        }
        .padding(.top, 28)
    }

    private var routinesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Routines")
            VStack(spacing: 0) {
                if routinesLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 22)
                } else if botRoutines.isEmpty {
                    Text("No routines yet")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 19)
                } else {
                    ForEach(Array(botRoutines.prefix(4).enumerated()), id: \.element.id) { index, routine in
                        routineRow(routine)
                        if index < min(botRoutines.count, 4) - 1 {
                            Divider().overlay(AgentProfileStyle.divider).padding(.leading, 58)
                        }
                    }
                }

                Divider().overlay(AgentProfileStyle.divider)

                Button {
                    showingRoutines = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28)
                        Text("Add routine")
                            .font(.body)
                            .foregroundStyle(Color.accentColor)
                        Spacer()
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .profileCard()
        }
        .padding(.top, 28)
    }

    private func routineRow(_ routine: Routine) -> some View {
        Button {
            showingRoutines = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color(red: 0.58, green: 0.45, blue: 1))
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(routine.name)
                        .font(.body)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(routineSummary(routine))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Routine \(routine.name)")
        .accessibilityValue(routineSummary(routine))
    }

    private func routineSummary(_ routine: Routine) -> String {
        let schedule: String
        switch routine.schedule.type {
        case .daily:
            let days = routine.schedule.weekdays ?? []
            let dayLabel: String
            if days.count == 7 {
                dayLabel = "Every day"
            } else if days.isEmpty {
                dayLabel = "Daily"
            } else {
                let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                dayLabel = days.compactMap { index in
                    guard names.indices.contains(index) else { return nil }
                    return names[index]
                }.joined(separator: ", ")
            }
            schedule = "\(dayLabel) at \(routine.schedule.time ?? "scheduled time")"
        case .once:
            if let at = routine.schedule.at {
                schedule = Date(timeIntervalSince1970: at / 1_000)
                    .formatted(.dateTime.month(.abbreviated).day().hour().minute())
            } else {
                schedule = "One time"
            }
        case .unknown:
            schedule = "Schedule from computer"
        }
        return routine.enabled ? schedule : "\(schedule) · Paused"
    }

    private var notificationsRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Notifications")
                    .font(.body)
                    .foregroundStyle(Color.primary)
                Spacer()
                Toggle("", isOn: $notifications)
                    .labelsHidden()
                    .tint(Color.green)
                    .accessibilityLabel("Agent notifications")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .profileCard()

            Text("Get notified when this bot finishes or needs your help")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
        }
        .padding(.top, 28)
    }

    @ViewBuilder
    private var secondaryControls: some View {
        if showingMedia {
            mediaControls
                .padding(.top, 30)
        }
        if showingModelAndVoice {
            modelAndVoiceControls
                .padding(.top, 30)
        }
    }

    private var mediaControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Avatar image")
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    BotAvatarView(bot: current, size: 58, state: .idle, animated: false)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Custom artwork")
                            .font(.body.weight(.medium))
                        Text("PNG, JPEG, GIF, or WebP up to 10 MB")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                Picker("Crop", selection: $crop) {
                    ForEach(AvatarCrop.allCases, id: \.self) { shape in
                        Text(shape.label).tag(shape)
                    }
                }
                .pickerStyle(.segmented)

                HStack(spacing: 10) {
                    PhotosPicker(selection: $photo, matching: .images) {
                        Label("Upload image", systemImage: "photo.badge.plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy)

                    if current.avatarUrl != nil {
                        Button("Use mascot", systemImage: "trash", role: .destructive) {
                            Task { await clearImage() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                    }
                }

                TextField("Art direction", text: $prompt, axis: .vertical)
                    .lineLimit(2...5)
                    .padding(12)
                    .background(AgentProfileStyle.control, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                Button("Generate on computer", systemImage: "sparkles") {
                    Task { await generateImage() }
                }
                .disabled(busy || !imageGenerationReady || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(18)
            .profileCard()
        }
    }

    private var modelAndVoiceControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Model & voice")
            VStack(alignment: .leading, spacing: 14) {
                modelControls
                Divider().overlay(AgentProfileStyle.divider)
                voiceControls
            }
            .padding(18)
            .profileCard()
        }
    }

    @ViewBuilder
    private var modelControls: some View {
        if instancesLoading {
            ProgressView("Loading models")
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Loading models")
        } else if let instancesError {
            Label(instancesError, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .accessibilityLabel("Could not load models")
                .accessibilityValue(instancesError)
            Button("Try again") { Task { await loadInstances() } }
                .disabled(busy || savingModel)
        } else {
            Picker("Provider", selection: providerSelection) {
                ForEach(advertisedInstances) { instance in
                    Text(instance.pickerTitle).tag(instance.instanceId)
                }
                if advertisedInstances.contains(where: { $0.instanceId == pickedInstanceId }) == false {
                    Text(currentProviderTitle).tag(pickedInstanceId)
                }
            }
            .disabled(modelSwitchBlocked || advertisedInstances.isEmpty)
            .accessibilityLabel("Provider")
            .accessibilityValue(currentProviderTitle)
            .accessibilityHint(current.busy == true ? "Interrupt this agent before switching models" : "Choose which engine this agent uses")

            Picker("Model", selection: modelSelection) {
                ForEach(modelsForPickedInstance) { option in
                    Text(option.label).tag(option.id)
                }
                if modelsForPickedInstance.contains(where: { $0.id == pickedModel }) == false {
                    Text(currentModelTitle).tag(pickedModel)
                }
            }
            .disabled(modelSwitchBlocked || modelsForPickedInstance.isEmpty)
            .accessibilityLabel("Model")
            .accessibilityValue(currentModelTitle)
            .accessibilityHint(current.busy == true ? "Interrupt this agent before switching models" : "Choose the model this agent uses")

            if savingModel {
                Label("Saving model…", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Saving model")
            } else if current.busy == true {
                Label("Interrupt this agent before switching models.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var voiceControls: some View {
        if voiceConfigured {
            Picker("Voice", selection: $voice) {
                if hasWorkspaceDefaultVoice {
                    Text("Workspace default").tag("")
                } else {
                    Text("Choose an agent voice").tag("").disabled(true)
                }
                if !voice.isEmpty, !voices.contains(where: { $0.id == voice }) {
                    Text("Current agent voice").tag(voice)
                }
                ForEach(voices) { option in
                    VStack(alignment: .leading) {
                        Text(option.label)
                        if let detail = option.description { Text(detail) }
                    }
                    .tag(option.id)
                }
            }
            Toggle("Speak replies", isOn: $speakReplies)
                .disabled(!selectedVoiceCanSpeak)
            Button("Preview voice", systemImage: "speaker.wave.2") {
                Task { await previewVoice() }
            }
            .disabled(busy || !selectedVoiceCanSpeak)

            if !hasWorkspaceDefaultVoice, voice.isEmpty {
                Label("Pick a voice for this agent before enabling speech.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            Label("ElevenLabs is not configured", systemImage: "speaker.slash")
                .foregroundStyle(.secondary)
        }
    }

    private func profileSectionLabel(_ label: String) -> some View {
        Text(label.uppercased())
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .tracking(0.4)
            .padding(.horizontal, 18)
    }

    private var instructionsEditor: some View {
        NavigationStack {
            ZStack(alignment: .topLeading) {
                AgentProfileStyle.canvas.ignoresSafeArea()
                TextEditor(text: $description)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(18)
                    .background(AgentProfileStyle.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .padding(24)
                if description.isEmpty {
                    Text("Tell this bot how to work, what to prioritize, and when to ask for help.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 42)
                        .padding(.top, 42)
                        .allowsHitTesting(false)
                }
            }
            .navigationTitle("Instructions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        description = instructionsBaseline
                        showingInstructions = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await save()
                            showingInstructions = false
                        }
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var providerSelection: Binding<String> {
        Binding(
            get: { pickedInstanceId },
            set: { newId in
                pickedInstanceId = newId
                pickedModel = AdvertisedModelCatalog.alignedModel(
                    instanceId: newId,
                    currentModel: pickedModel,
                    in: instances
                )
                scheduleModelSave()
            }
        )
    }

    private var modelSelection: Binding<String> {
        Binding(
            get: { pickedModel },
            set: { newModel in
                pickedModel = newModel
                scheduleModelSave()
            }
        )
    }

    private func loadInstances() async {
        instancesLoading = true
        defer { instancesLoading = false }
        switch await session.loadInstances() {
        case let .loaded(loaded):
            guard !loaded.isEmpty else {
                instances = []
                instancesError = "No models are advertised by the paired computer."
                return
            }
            instances = loaded
            instancesError = nil
            pickedInstanceId = current.modelSelection.instanceId
            pickedModel = AdvertisedModelCatalog.alignedModel(
                instanceId: pickedInstanceId,
                currentModel: current.modelSelection.model,
                in: loaded
            )
        case let .failed(message):
            instances = []
            instancesError = message
        case .cancelled:
            return
        }
    }

    private func scheduleModelSave() {
        modelSaveRevision &+= 1
        let revision = modelSaveRevision
        modelSaveTask?.cancel()

        let selection = current.modelSelection
        guard pickedInstanceId != selection.instanceId || pickedModel != selection.model else {
            savingModel = false
            modelSaveTask = nil
            return
        }
        guard current.busy != true else {
            pickedInstanceId = selection.instanceId
            pickedModel = selection.model
            savingModel = false
            modelSaveTask = nil
            session.actionError = "Interrupt this agent before switching models."
            return
        }

        savingModel = true
        modelSaveTask = Task { @MainActor in
            await saveModelIfNeeded(revision: revision, previous: selection)
            if modelSaveRevision == revision {
                modelSaveTask = nil
            }
        }
    }

    private func saveModelIfNeeded(revision: Int, previous: ModelSelection) async {
        defer {
            if modelSaveRevision == revision {
                savingModel = false
            }
        }
        guard modelSaveRevision == revision else { return }
        let requested = BotModelPatch(instanceId: pickedInstanceId, model: pickedModel)
        guard requested.instanceId != previous.instanceId || requested.model != previous.model else { return }

        guard let updated = await session.updateModel(requested, for: current) else {
            // A newer picker value owns the form now. If another client
            // changed the bot while this request was in flight, follow that
            // server state rather than rolling back over it.
            guard modelSaveRevision == revision else { return }
            let latest = current.modelSelection
            if latest.instanceId == requested.instanceId && latest.model == requested.model {
                pickedInstanceId = previous.instanceId
                pickedModel = previous.model
            } else {
                pickedInstanceId = latest.instanceId
                pickedModel = latest.model
            }
            return
        }

        guard modelSaveRevision == revision else { return }
        pickedInstanceId = updated.modelSelection.instanceId
        pickedModel = updated.modelSelection.model
    }

    private func profilePatch() -> BotProfilePatch {
        let savedSpeakReplies = config.map { $0.canSpeak(agentVoice: voice) && speakReplies } ?? speakReplies
        return BotProfilePatch(
            // The shared server contract owns the 100/200/4000 limits. Do not
            // silently apply narrower iOS-only limits to a user's profile.
            name: name == baseline.name ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title == baseline.title ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description == baseline.description
                ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            notifications: notifications == baseline.notifications ? nil : notifications,
            avatarCrop: crop == baseline.crop ? nil : crop,
            // Empty is the server's explicit "use workspace default" value;
            // nil would mean the voice field is not part of this patch.
            voice: voice == baseline.voice ? nil : voice,
            speakReplies: savedSpeakReplies == baseline.speakReplies ? nil : savedSpeakReplies
        )
    }

    private func save() async {
        busy = true
        if let updated = await session.updateProfile(profilePatch(), for: current) {
            synchronizeForm(with: updated)
        }
        busy = false
    }

    private func clearImage() async {
        busy = true
        defer { busy = false }
        if let updated = await session.updateProfile(
            BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot),
            for: current
        ) {
            crop = updated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false; photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let mime = Self.imageMIME(data)
        else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        if let updated = await session.uploadAvatar(data, mime: mime, for: current, crop: intendedCrop) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        }
    }

    private func generateImage() async {
        busy = true
        defer { busy = false }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        guard let generated = await session.generateAvatar(
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)),
            for: current
        ) else { return }
        // Generation chooses a safe default crop server-side. The selector is
        // the user's explicit choice, so persist it immediately against the
        // returned attachment rather than leaving UI and server out of sync.
        let shapePatch = BotProfilePatch(avatarCrop: intendedCrop)
        if let updated = await session.updateProfile(shapePatch, for: generated) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        } else {
            // Generation itself succeeded. Reflect its authoritative fallback
            // rather than claiming the requested crop was persisted.
            crop = generated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func previewVoice() async {
        guard selectedVoiceCanSpeak else {
            session.actionError = "Pick an agent voice or configure a workspace default on your computer first."
            return
        }
        busy = true
        defer { busy = false }
        guard let data = await session.previewVoice(voice, for: current) else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio)
            try audioSession.setActive(true)

            let nextPlayer = try AVAudioPlayer(data: data)
            guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                player = nil
                session.actionError = "The generated audio could not be played."
                return
            }
            player = nextPlayer
        } catch {
            player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            session.actionError = "The generated audio could not be played."
        }
    }

    private static func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }

    private func synchronizeForm(with bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
        baseline = ProfileFormSnapshot(bot: bot)
    }
}

private struct ProfileFormSnapshot {
    var name: String
    var title: String
    var description: String
    var notifications: Bool
    var crop: AvatarCrop
    var voice: String
    var speakReplies: Bool

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
    }
}

private extension AvatarCrop {
    var label: String {
        switch self {
        case .mascot: "Mascot"
        case .circle: "Circle"
        case .rounded: "Rounded"
        case .square: "Square"
        }
    }
}

private enum AgentProfileStyle {
    static let canvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.071, green: 0.071, blue: 0.078, alpha: 1)
            : UIColor(red: 0.965, green: 0.965, blue: 0.973, alpha: 1)
    })

    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.118, green: 0.118, blue: 0.129, alpha: 1)
            : UIColor(red: 0.898, green: 0.898, blue: 0.914, alpha: 1)
    })

    static let control = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.145, green: 0.145, blue: 0.157, alpha: 1)
            : UIColor(red: 0.882, green: 0.882, blue: 0.898, alpha: 1)
    })

    static let divider = Color.primary.opacity(0.08)
    static let mascotOrange = Color(red: 0.93, green: 0.38, blue: 0.05)
}

private struct ProfileColorChoice: Identifiable {
    let id: String
    let name: String
    let color: Color
}

private enum MascotMark: String, CaseIterable, Identifiable {
    case circle
    case oval
    case square
    case pill
    case triangle
    case hexagon
    case cloud
    case droplet

    var id: String { rawValue }

    var label: String {
        switch self {
        case .circle: "Circle"
        case .oval: "Oval"
        case .square: "Square"
        case .pill: "Pill"
        case .triangle: "Triangle"
        case .hexagon: "Hexagon"
        case .cloud: "Cloud"
        case .droplet: "Droplet"
        }
    }

    var systemImage: String {
        switch self {
        case .circle: "circle.fill"
        case .oval: "oval.fill"
        case .square: "square.fill"
        case .pill: "capsule.fill"
        case .triangle: "triangle.fill"
        case .hexagon: "hexagon.fill"
        case .cloud: "cloud.fill"
        case .droplet: "drop.fill"
        }
    }
}

private extension View {
    func profileCard(cornerRadius: CGFloat = 22) -> some View {
        background(
            AgentProfileStyle.card,
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
    }
}
