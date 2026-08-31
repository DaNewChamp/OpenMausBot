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
    @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 108
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
    @State private var pickedEffort: String?
    @State private var fastMode: Bool
    @State private var permissionMode: PermissionMode?
    @State private var busy = false
    @State private var savingModel = false
    @State private var modelSaveTask: Task<Void, Never>?
    @State private var modelSaveRevision = 0
    /// Character taps are persisted as a coalesced, appearance-only write so
    /// a quick colour/shape change cannot race a full profile save.
    @State private var appearanceSaveTask: Task<Void, Never>?
    @State private var appearanceSaveRevision = 0
    @State private var leavingProfile = false
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
    @State private var showingModelAndVoice = true

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
        _pickedEffort = State(initialValue: bot.modelSelection.effort)
        _fastMode = State(initialValue: bot.fastMode == true)
        _permissionMode = State(initialValue: bot.permissionMode)
        _baseline = State(initialValue: ProfileFormSnapshot(bot: bot))
        _selectedColor = State(initialValue: bot.color)
        _selectedShape = State(initialValue: MascotMark(rawValue: bot.mascotShape?.rawValue ?? MascotMark.droplet.rawValue) ?? .droplet)
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var heroBot: Bot {
        var value = current
        value.color = selectedColor
        value.mascotShape = MascotShape(rawValue: selectedShape.rawValue)
        value.avatarCrop = crop
        return value
    }
    private var imageGenerationReady: Bool { config?.imageGen?.configured == true }
    private var voiceConfigured: Bool { config?.isTTSConfigured == true }
    private var hasWorkspaceDefaultVoice: Bool { config?.hasWorkspaceDefaultVoice == true }
    private var selectedVoiceCanSpeak: Bool { config?.canSpeak(agentVoice: voice) == true }
    private var pickedInstance: Instance? { AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances) }
    private var effortLevels: [String] { pickedInstance?.capabilities?.effortLevels ?? [] }
    private var hostWide: Bool { EngineSyncPolicy.hostWideSelection(session.engineSync) }
    private var showsEffortPicker: Bool {
        ModelSelectionPolicy.showsEffortPicker(levels: effortLevels, hostWideEngine: hostWide)
    }
    private var modelSwitchBlocked: Bool {
        busy || !ModelSelectionPolicy.allowsSwitch(
            working: current.busy == true,
            saving: savingModel,
            catalogLoading: ModelCatalogLoadPolicy.hostLoading(
                localLoading: instancesLoading,
                sessionRefreshing: session.modelCatalogRefreshing
            )
        )
    }
    private var botRoutines: [Routine] { routines.filter { $0.botId == current.id } }
    private var canEdit: Bool {
        CalmSurfacePolicy.canEditRemoteContent(
            isLive: session.status == .live,
            hasConnection: session.connection != nil
        )
    }
    private var usesCustomAvatarPhoto: Bool {
        current.avatarUrl != nil && current.displayedAvatarCrop != .mascot
    }
    private var hasUnsavedChanges: Bool {
        !profilePatchIsEmpty || pickedInstanceId != current.modelSelection.instanceId || pickedModel != current.modelSelection.model || pickedEffort != current.modelSelection.effort
    }
    private var profilePatchIsEmpty: Bool {
        name == baseline.name && title == baseline.title && description == baseline.description
            && notifications == baseline.notifications && crop == baseline.crop
            && voice == baseline.voice && speakReplies == baseline.speakReplies
            && selectedColor == baseline.color && selectedShape.rawValue == baseline.shape.rawValue
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                profileTopBar
                ScrollView {
                    VStack(spacing: 0) {
                        profileHero
                        if !canEdit {
                            ReconnectToEditBanner()
                                .padding(.bottom, VBotSurface.Space.section)
                        }
                        identityCard
                        characterSection
                        permissionSection
                        instructionsRow
                        routinesSection
                        notificationsRow
                        secondaryControls
                    }
                    .padding(.horizontal, VBotSurface.Space.page)
                    .padding(.bottom, 36)
                }
                .scrollIndicators(.hidden)
            }
            .vbotCanvas()
            .toolbar(.hidden, for: .navigationBar)
            .overlay {
                if busy || savingModel {
                    ProgressView()
                        .controlSize(.large)
                        .tint(Color.primary)
                        .padding(22)
                        .background(VBotSurface.card, in: Circle())
                        .accessibilityLabel("Saving")
                }
            }
            .task {
                await loadInstances()
                config = await session.configStatus()
                voices = await session.voiceOptions()
                let loaded = await session.loadRoutines()
                let incoming = loaded.routines.filter { $0.botId == current.id }
                let failed = session.status != .live && incoming.isEmpty && !routines.isEmpty
                routines = CalmSurfacePolicy.selectCatalog(
                    cached: routines,
                    incoming: incoming,
                    failed: failed
                )
                routinesLoading = false
                if let config, !config.canSpeak(agentVoice: voice) {
                    speakReplies = false
                }
                await session.retryPendingAppearanceOverrides()
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
            .onChange(of: current.permissionMode) { _, mode in
                permissionMode = mode
            }
            .onChange(of: current.busy) { was, isBusy in
                if ModelSelectionPolicy.shouldRevertDraft(wasWorking: was == true, isWorking: isBusy == true) {
                    let selection = current.modelSelection
                    pickedInstanceId = selection.instanceId
                    pickedModel = selection.model
                    pickedEffort = selection.effort
                    modelSaveTask?.cancel()
                    session.invalidateModelUpdates(for: current.id)
                    savingModel = false
                }
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
                appearanceSaveTask?.cancel()
                guard !leavingProfile, hasUnsavedChanges else { return }
                // The interactive-pop gesture has no button action to await.
                // Keep its final character choice rather than dropping it
                // when SwiftUI removes this view from the stack.
                Task { @MainActor in await saveAll() }
            }
            .sheet(isPresented: $showingInstructions) {
                instructionsEditor
            }
            .sheet(isPresented: $showingRoutines) {
                TasksRoutinesSheet()
            }
        }
    }

    // MARK: - Profile surface

    private var profileTopBar: some View {
        HStack {
            GlassButton(systemImage: "chevron.left") {
                Haptics.selection()
                leaveProfile()
            }
            .accessibilityLabel("Back")

            Spacer()

            Menu {
                Button("Save changes", systemImage: "checkmark") {
                    Task { await saveAll() }
                }
                .disabled(!canEdit || !hasUnsavedChanges || busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Edit instructions", systemImage: "doc.text") {
                    instructionsBaseline = description
                    showingInstructions = true
                }
                .disabled(!canEdit)
                Button("Tasks & routines", systemImage: "clock") {
                    showingRoutines = true
                }
                Divider()
                Button("Media & avatar", systemImage: "photo") {
                    showingMedia = true
                }
                .disabled(!canEdit)
                Button("Model & voice", systemImage: "slider.horizontal.3") {
                    showingModelAndVoice = true
                }
                Divider()
                Button(
                    current.pinned == true ? "Unpin" : "Pin",
                    systemImage: current.pinned == true ? "pin.slash" : "pin"
                ) {
                    session.togglePinned(.bot(current))
                }
                .disabled(session.pendingPinnedChats.contains("bot:\(current.id)"))
            } label: {
                GlassChromeGlyph(systemImage: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Profile actions")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, VBotSurface.Space.page)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var profileHero: some View {
        BotAvatarView(
            bot: heroBot,
            size: heroSize,
            state: .idle,
            animated: false
        )
        .shadow(
            color: reduceMotion ? .clear : MausPalette.color(selectedColor).opacity(0.45),
            radius: 28,
            y: 2
        )
        .frame(maxWidth: .infinity)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(current.name) avatar")
        .accessibilityAddTraits(.isImage)
    }

    private var identityCard: some View {
        VStack(spacing: 0) {
            TextField("Name", text: $name)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.words)
                .padding(.horizontal, 18)
                .frame(minHeight: VBotSurface.Hit.row)
                .disabled(!canEdit)

            VBotHairline()

            TextField("Title (optional)", text: $title)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
                .frame(minHeight: 48)
                .disabled(!canEdit)
        }
        .vbotCard()
        .accessibilityElement(children: .contain)
    }

    private var characterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Character")

            if usesCustomAvatarPhoto {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Your photo is shown in chat. Color and mark apply if you switch back to the mascot.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 18)
                        .padding(.top, 16)

                    Picker("Shape", selection: photoCropBinding) {
                        ForEach([AvatarCrop.circle, .rounded, .square], id: \.self) { shape in
                            Text(shape.label).tag(shape)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 16)
                }
                .profileCard()
            } else {
                VStack(spacing: 0) {
                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 6),
                        spacing: 16
                    ) {
                        ForEach(profileColors) { choice in
                            Button {
                                Haptics.selection()
                                selectedColor = choice.id
                                scheduleAppearanceSave()
                            } label: {
                                Circle()
                                    .fill(choice.color)
                                    .frame(width: 28, height: 28)
                                    .overlay {
                                        if choice.id == "white" {
                                            Circle().stroke(Color.primary.opacity(0.22), lineWidth: 1)
                                        }
                                    }
                                    .overlay {
                                        Circle()
                                            .stroke(
                                                isSelectedColor(choice.id) ? Color.white.opacity(0.72) : .clear,
                                                lineWidth: 1.5
                                            )
                                            .padding(-5)
                                    }
                            }
                            .buttonStyle(.plain)
                            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.78), value: selectedColor)
                            .accessibilityLabel("\(choice.name) character color")
                            .accessibilityAddTraits(isSelectedColor(choice.id) ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 16)
                    .padding(.bottom, 16)

                    VBotHairline()

                    HStack(spacing: 6) {
                        ForEach(MascotMark.allCases) { mark in
                            Button {
                                Haptics.selection()
                                selectedShape = mark
                                scheduleAppearanceSave()
                            } label: {
                                MascotMarkIcon(
                                    kind: mark.rawValue,
                                    color: MausPalette.color(selectedColor),
                                    size: 26
                                )
                                .frame(width: 32, height: 32)
                                .overlay {
                                    Circle()
                                        .stroke(
                                            selectedShape == mark ? Color.white.opacity(0.72) : .clear,
                                            lineWidth: 1.5
                                        )
                                        .padding(-4)
                                }
                            }
                            .buttonStyle(.plain)
                            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.78), value: selectedShape)
                            .accessibilityLabel("\(mark.label) character mark")
                            .accessibilityAddTraits(selectedShape == mark ? .isSelected : [])
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)

                    VBotHairline()

                    Button("Reset to default") {
                        Haptics.selection()
                        selectedColor = "green"
                        selectedShape = .droplet
                        scheduleAppearanceSave()
                    }
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .accessibilityHint("Sets the green droplet mark")
                }
                .profileCard()

                Text("How this Bot's mark looks everywhere")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
            }

            if let notice = session.appearanceSaveNotice(for: current) {
                Label(notice, systemImage: "iphone.and.arrow.forward")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
                    .accessibilityLabel("Character appearance pending synchronization")
            }
        }
        .padding(.top, 18)
        .disabled(!canEdit)
    }

    private var permissionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Permissions")
            VStack(alignment: .leading, spacing: 8) {
                Picker("Permission behavior", selection: $permissionMode) {
                    Text("Use app default").tag(Optional<PermissionMode>.none)
                    ForEach(PermissionMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(Optional(mode))
                    }
                }
                .pickerStyle(.menu)
                .disabled(!canEdit)
                Text("Controls whether this bot asks before using tools. Safety checks and computer warnings always remain active.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .profileCard()
            .onChange(of: permissionMode) { _, mode in
                guard canEdit, mode != current.permissionMode else { return }
                Task {
                    _ = await session.updatePermissionMode(mode, for: current)
                }
            }
        }
    }

    private var photoCropBinding: Binding<AvatarCrop> {
        Binding(
            get: {
                switch crop {
                case .circle, .rounded, .square: crop
                default: .circle
                }
            },
            set: { newCrop in
                crop = newCrop
                Task { await savePhotoCrop(newCrop) }
            }
        )
    }

    /// Eleven Grok picker swatches. `cyan` is the same hue as teal, so an
    /// older saved cyan still lights the teal chip instead of wrapping a
    /// twelfth lonely row.
    private var profileColors: [ProfileColorChoice] {
        [
            .init(id: "white", name: "White", color: MausPalette.color("white")),
            .init(id: "brown", name: "Brown", color: MausPalette.color("brown")),
            .init(id: "red", name: "Red", color: MausPalette.color("red")),
            .init(id: "orange", name: "Orange", color: MausPalette.color("orange")),
            .init(id: "yellow", name: "Yellow", color: MausPalette.color("yellow")),
            .init(id: "green", name: "Green", color: MausPalette.color("green")),
            .init(id: "teal", name: "Teal", color: MausPalette.color("cyan")),
            .init(id: "blue", name: "Blue", color: MausPalette.color("blue")),
            .init(id: "purple", name: "Purple", color: MausPalette.color("purple")),
            .init(id: "pink", name: "Pink", color: MausPalette.color("pink")),
            .init(id: "gray", name: "Gray", color: MausPalette.color("gray")),
        ]
    }

    private func isSelectedColor(_ id: String) -> Bool {
        if selectedColor == id { return true }
        if id == "teal" && (selectedColor == "cyan" || selectedColor == "teal") { return true }
        return false
    }

    private var instructionsRow: some View {
        Button {
            instructionsBaseline = description
            showingInstructions = true
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "doc.text")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 26)
                Text("Instructions")
                    .font(.body)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 18)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .profileCard()
        .accessibilityHint(description.isEmpty ? "Tell this Bot how to work" : "Edit this agent's instructions")
        .padding(.top, 18)
    }

    private var routinesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            profileSectionLabel("Routines")
            VStack(spacing: 0) {
                if CalmSurfacePolicy.showsSkeleton(isLoading: routinesLoading, hasCachedRows: !botRoutines.isEmpty) {
                    CalmSkeletonList(rows: 3, label: "Loading routines")
                } else if botRoutines.isEmpty {
                    Text("No routines yet")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                        .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
                } else {
                    ForEach(Array(botRoutines.prefix(4).enumerated()), id: \.element.id) { index, routine in
                        routineRow(routine)
                        if index < min(botRoutines.count, 4) - 1 {
                            VBotHairline().padding(.leading, 58)
                        }
                    }
                }

                VBotHairline()

                Button {
                    showingRoutines = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28)
                        Text("Add routine")
                            .font(.body)
                            .foregroundStyle(Color.accentColor)
                        Spacer()
                    }
                    .padding(.horizontal, 18)
                    .frame(minHeight: VBotSurface.Hit.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canEdit)
            }
            .profileCard()
        }
        .padding(.top, 18)
    }

    private func routineRow(_ routine: Routine) -> some View {
        Button {
            showingRoutines = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(VBotSurface.routineIcon)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(routine.name)
                        .font(.body)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(ProfileScheduleText.summary(routine))
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
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Routine \(routine.name)")
        .accessibilityValue(ProfileScheduleText.summary(routine))
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
                    .disabled(!canEdit)
                    .accessibilityLabel("Agent notifications")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .profileCard()

            Text("Get notified when this Bot finishes or needs input")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
        }
        .padding(.top, 18)
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
                    BotAvatarView(bot: heroBot, size: 58, state: .idle, animated: false)
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
                .disabled(!canEdit)

                HStack(spacing: 10) {
                    PhotosPicker(selection: $photo, matching: .images) {
                        Label("Upload image", systemImage: "photo.badge.plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canEdit || busy)

                    if current.avatarUrl != nil {
                        Button("Use mascot", systemImage: "trash", role: .destructive) {
                            Task { await clearImage() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!canEdit || busy)
                    }
                }

                TextField("Art direction", text: $prompt, axis: .vertical)
                    .lineLimit(2...5)
                    .padding(12)
                    .vbotControlSurface()
                    .disabled(!canEdit)

                Button("Generate on computer", systemImage: "sparkles") {
                    Task { await generateImage() }
                }
                .disabled(!canEdit || busy || !imageGenerationReady || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                VBotHairline()
                voiceControls
            }
            .padding(18)
            .profileCard()
        }
    }

    @ViewBuilder
    private var modelControls: some View {
        VStack(alignment: .leading, spacing: 14) {
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
                onSelectionChange: {
                    let levels = AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances)?.capabilities?.effortLevels ?? []
                    if let effort = pickedEffort, !levels.contains(effort) {
                        pickedEffort = nil
                    }
                    scheduleModelSave()
                }
            )

            Toggle(isOn: $fastMode) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fast mode")
                    Text(ModelSelectionPolicy.fastModeHint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(!canEdit || modelSwitchBlocked)
            .onChange(of: fastMode) { _, enabled in
                Task { _ = await session.updateFastMode(enabled, for: current) }
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
            .disabled(!canEdit || busy || !selectedVoiceCanSpeak)

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
        Text(label)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 18)
    }

    private var instructionsEditor: some View {
        NavigationStack {
            ZStack(alignment: .topLeading) {
                VBotSurface.background.ignoresSafeArea()
                TextEditor(text: $description)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .disabled(!canEdit)
                    .padding(18)
                    .vbotCard()
                    .padding(24)
                if description.isEmpty {
                    Text("Tell this Bot how to work, what to prioritize, and when to ask for help.")
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
                            await saveAll()
                            showingInstructions = false
                        }
                    }
                    .disabled(!canEdit || busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDragIndicator(.visible)
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
                let levels = AdvertisedModelCatalog.instance(id: pickedInstanceId, in: instances)?.capabilities?.effortLevels ?? []
                pickedEffort = current.modelSelection.effort.flatMap { levels.contains($0) ? $0 : nil }
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
            let levels = AdvertisedModelCatalog.instance(id: pickedInstanceId, in: loaded)?.capabilities?.effortLevels ?? []
            pickedEffort = current.modelSelection.effort.flatMap { levels.contains($0) ? $0 : nil }
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

    private func scheduleModelSave() {
        modelSaveRevision &+= 1
        let revision = modelSaveRevision
        modelSaveTask?.cancel()

        let selection = current.modelSelection
        guard pickedInstanceId != selection.instanceId
            || pickedModel != selection.model
            || pickedEffort != selection.effort
        else {
            savingModel = false
            modelSaveTask = nil
            return
        }
        guard current.busy != true else {
            pickedInstanceId = selection.instanceId
            pickedModel = selection.model
            pickedEffort = selection.effort
            savingModel = false
            modelSaveTask = nil
            session.actionError = ModelSelectionPolicy.busyExplanation
            return
        }

        savingModel = true
        modelSaveTask = Task { @MainActor in
            await saveModelIfNeeded(revision: revision, previous: selection)
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) {
                modelSaveTask = nil
            }
        }
    }

    private func saveModelIfNeeded(revision: Int, previous: ModelSelection) async {
        defer {
            if ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) {
                savingModel = false
            }
        }
        guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) else { return }
        let requested = BotModelPatch(
            instanceId: pickedInstanceId,
            model: pickedModel,
            effort: showsEffortPicker ? (pickedEffort.map(BotModelPatch.EffortUpdate.set) ?? .clear) : .omitted
        )
        guard requested.instanceId != previous.instanceId
            || requested.model != previous.model
            || pickedEffort != previous.effort
        else { return }

        guard let updated = await session.updateModel(requested, for: current) else {
            // A newer picker value owns the form now. If another client
            // changed the bot while this request was in flight, follow that
            // server state rather than rolling back over it.
            guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) else { return }
            let latest = current.modelSelection
            if latest.instanceId == requested.instanceId && latest.model == requested.model && latest.effort == pickedEffort {
                pickedInstanceId = previous.instanceId
                pickedModel = previous.model
                pickedEffort = previous.effort
            } else {
                pickedInstanceId = latest.instanceId
                pickedModel = latest.model
                pickedEffort = latest.effort
            }
            return
        }

        guard ModelSelectionPolicy.shouldApplyResponse(requestRevision: revision, currentRevision: modelSaveRevision) else { return }
        pickedInstanceId = updated.modelSelection.instanceId
        pickedModel = updated.modelSelection.model
        pickedEffort = updated.modelSelection.effort
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
            color: selectedColor == baseline.color ? nil : selectedColor,
            mascotShape: selectedShape.rawValue == baseline.shape.rawValue
                ? nil : MascotShape(rawValue: selectedShape.rawValue),
            avatarCrop: crop == baseline.crop ? nil : crop,
            // Empty is the server's explicit "use workspace default" value;
            // nil would mean the voice field is not part of this patch.
            voice: voice == baseline.voice ? nil : voice,
            speakReplies: savedSpeakReplies == baseline.speakReplies ? nil : savedSpeakReplies
        )
    }

    /// Persist character taps without waiting for the user to discover the
    /// overflow menu. A short debounce coalesces a colour + shape tap into
    /// one request and keeps a fast picker interaction deterministic.
    private func scheduleAppearanceSave() {
        appearanceSaveRevision &+= 1
        let revision = appearanceSaveRevision
        appearanceSaveTask?.cancel()
        appearanceSaveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled, appearanceSaveRevision == revision else { return }
            await saveAppearance()
            if appearanceSaveRevision == revision {
                appearanceSaveTask = nil
            }
        }
    }

    /// Appearance-only writes never include the rest of the profile form. If
    /// the user edits the name while a colour request is in flight, neither
    /// change can overwrite the other, and the latest picker state is queued
    /// by the revision check above.
    private func saveAppearance() async {
        let requestedColor = selectedColor
        let requestedShape = selectedShape
        let patch = BotProfilePatch(
            color: requestedColor == baseline.color ? nil : requestedColor,
            mascotShape: requestedShape.rawValue == baseline.shape.rawValue
                ? nil : MascotShape(rawValue: requestedShape.rawValue)
        )
        guard patch.color != nil || patch.mascotShape != nil, !busy else { return }

        busy = true
        defer { busy = false }
        guard let updated = await session.updateProfile(patch, for: current) else { return }

        // Do not roll a newer tap back when an older request completes after
        // it. The returned bot already includes any device-local compatibility
        // override retained by Session for a legacy desktop.
        if selectedColor == requestedColor {
            selectedColor = updated.color
            baseline.color = updated.color
        }
        if selectedShape.rawValue == requestedShape.rawValue {
            selectedShape = MascotMark(rawValue: updated.mascotShape?.rawValue ?? requestedShape.rawValue) ?? requestedShape
            baseline.shape = MascotShape(rawValue: selectedShape.rawValue) ?? .droplet
        }
    }

    private func savePhotoCrop(_ requested: AvatarCrop) async {
        guard requested != baseline.crop, !busy else { return }
        busy = true
        defer { busy = false }
        guard let updated = await session.updateProfile(BotProfilePatch(avatarCrop: requested), for: current) else { return }
        crop = updated.avatarCrop ?? requested
        baseline.crop = crop
    }

    /// Full profile save used by the explicit menu and every dismissal path.
    /// Cancelling the debounce first prevents an older appearance-only write
    /// from racing this authoritative form snapshot.
    private func saveAll() async {
        appearanceSaveTask?.cancel()
        appearanceSaveRevision &+= 1
        await save()
    }

    private func leaveProfile() {
        guard !leavingProfile else { return }
        leavingProfile = true
        Task { @MainActor in
            await saveAll()
            dismiss()
        }
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
        let data: Data
        do {
            guard let loaded = try await item.loadTransferable(type: Data.self) else { return }
            data = loaded
        } catch {
            if error.isCancellation { return }
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        guard let mime = Self.imageMIME(data) else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        if let updated = await session.uploadAvatar(data, mime: mime, for: current, crop: intendedCrop) {
            crop = updated.displayedAvatarCrop == .mascot ? intendedCrop : updated.displayedAvatarCrop
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
        selectedColor = bot.color
        selectedShape = MascotMark(rawValue: bot.mascotShape?.rawValue ?? MascotMark.droplet.rawValue) ?? .droplet
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
    var color: String
    var shape: MascotShape
    var crop: AvatarCrop
    var voice: String
    var speakReplies: Bool

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        color = bot.color
        shape = bot.mascotShape ?? .droplet
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
    func profileCard(cornerRadius: CGFloat = VBotSurface.Radius.card) -> some View {
        vbotCard(radius: cornerRadius)
    }
}
