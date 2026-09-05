// On-device call-voice choices and the per-bot picker.
//
// CompanionCore stores identifiers only; AVSpeechSynthesisVoice lives here
// so `swift test` stays Foundation-only. The custom TTS API key is never
// shown or copied into this preference.
import AVFoundation
import AVKit
import CompanionCore
import SwiftUI

enum CallVoiceCatalog {
    struct Choice: Identifiable, Hashable {
        var id: String
        var label: String
    }

    static func onDeviceVoices() -> [Choice] {
        AVSpeechSynthesisVoice.speechVoices()
            .sorted {
                if $0.language == $1.language { return $0.name < $1.name }
                return $0.language < $1.language
            }
            .map { voice in
                Choice(
                    id: voice.identifier,
                    label: "\(voice.name) · \(displayLanguage(voice.language))"
                )
            }
    }

    static func label(forIdentifier identifier: String) -> String {
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "System default" }
        if let voice = AVSpeechSynthesisVoice(identifier: trimmed) {
            return "\(voice.name) · \(displayLanguage(voice.language))"
        }
        return trimmed
    }

    static func displayLanguage(_ code: String) -> String {
        Locale.current.localizedString(forIdentifier: code) ?? code
    }
}

struct CallRoutePicker: UIViewRepresentable {
    var tint: UIColor = .white

    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = tint
        view.activeTintColor = tint
        view.prioritizesVideoDevices = false
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        uiView.tintColor = tint
        uiView.activeTintColor = tint
    }
}

struct CallVoicePickerSheet: View {
    let botId: String
    let botName: String
    let serverVoice: String?
    let hasActiveCall: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var draftPreference: CallVoicePreference
    @State private var searchText = ""
    @State private var showingMoreVoices = false
    @State private var previewTask: Task<Void, Never>?
    @State private var previewGeneration = 0
    @Environment(\.scenePhase) private var scenePhase
    @State private var previewEngine: LocalTtsEngine? = nil
    @State private var previewingVoiceId: String? = nil
    @State private var previewError: String? = nil

    private let engine = VoiceOutputSettings.load().engine

    init(botId: String, botName: String, serverVoice: String?, hasActiveCall: Bool = CallAudioSession.isOwned) {
        self.botId = botId
        self.botName = botName
        self.serverVoice = serverVoice
        self.hasActiveCall = hasActiveCall
        let saved = CallVoicePreferenceStore.load(botId: botId)
        _draftPreference = State(initialValue: saved)
    }

    private var allPrioritizedVoices: [VoiceFeedbackPolicy.VoicePickerItem] {
        let available = AVSpeechSynthesisVoice.speechVoices().map {
            VoiceFeedbackPolicy.VoiceChoice(id: $0.identifier, name: $0.name, language: $0.language)
        }
        return VoiceFeedbackPolicy.prioritizeVoices(
            available: available,
            currentVoiceId: draftPreference.onDeviceVoiceIdentifier,
            currentLanguageCode: Locale.current.identifier
        )
    }

    private var isCallBlockingPreview: Bool {
        hasActiveCall || CallAudioSession.isOwned
    }

    var body: some View {
        NavigationStack {
            List {
                if let previewError {
                    Section { Text(previewError).font(.footnote).foregroundStyle(.red) }
                }
                switch engine {
                case .onDevice:
                    onDeviceSections
                case .customEndpoint:
                    customEndpointSection
                case .hub:
                    hubVoiceSection
                }
            }
            .navigationTitle("Call voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        stopPreview()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        stopPreview()
                        CallVoicePreferenceStore.save(draftPreference, botId: botId)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .searchable(text: $searchText, prompt: "Search iPhone voices")
            .onChange(of: hasActiveCall) { _, active in
                if active { stopPreview() }
            }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in
                stopPreview()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { stopPreview() }
            }
            .onDisappear {
                stopPreview()
                previewEngine = nil
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - On-device voice sections

    @ViewBuilder
    private var onDeviceSections: some View {
        let items = filteredVoices

        if isCallBlockingPreview {
            Section {
                Label(
                    VoiceFeedbackPolicy.previewDisabledReason(hasActiveCall: true),
                    systemImage: "speaker.slash"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }

        if !searchText.isEmpty {
            Section {
                ForEach(items) { item in
                    voiceRow(item: item)
                }
            } header: {
                Text("Search results (iPhone voice)")
            }
        } else {
            let primary = Array(items.prefix(6))
            let secondary = Array(items.dropFirst(primary.count))

            Section {
                ForEach(primary) { item in
                    voiceRow(item: item)
                }
            } header: {
                Text("Suggested (iPhone voice)")
            } footer: {
                Text("Stays on this iPhone. Does not change \(botName)’s hub voice.")
            }

            if !secondary.isEmpty {
                Section {
                    DisclosureGroup("More voices", isExpanded: $showingMoreVoices) {
                        ForEach(secondary) { item in voiceRow(item: item) }
                    }
                } header: {
                    Text("More voices (iPhone voice)")
                }
            }
        }
    }

    private var filteredVoices: [VoiceFeedbackPolicy.VoicePickerItem] {
        let all = allPrioritizedVoices
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.label.lowercased().contains(query) ||
            CallVoiceCatalog.displayLanguage($0.language).lowercased().contains(query)
        }
    }

    private func isCurrentLanguage(_ code: String) -> Bool {
        let prefix = Locale.current.identifier.replacingOccurrences(of: "_", with: "-").lowercased().split(separator: "-").first.map(String.init) ?? ""
        return !prefix.isEmpty && code.lowercased().hasPrefix(prefix)
    }

    private func voiceRow(item: VoiceFeedbackPolicy.VoicePickerItem) -> some View {
        HStack(spacing: 12) {
            Button {
                draftPreference.onDeviceVoiceIdentifier = item.id
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rowTitle(for: item))
                            .foregroundStyle(.primary)
                        Text(rowSubtitle(for: item))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if draftPreference.onDeviceVoiceIdentifier == item.id {
                        Image(systemName: "checkmark")
                            .foregroundStyle(Color.accentColor)
                            .fontWeight(.semibold)
                    }
                }
            }
            .buttonStyle(.plain)

            previewButton(for: item.id)
        }
    }

    private func rowTitle(for item: VoiceFeedbackPolicy.VoicePickerItem) -> String {
        if item.id.isEmpty {
            return "System default"
        }
        if item.isPreserved {
            return "\(item.label)"
        }
        return item.label
    }

    private func rowSubtitle(for item: VoiceFeedbackPolicy.VoicePickerItem) -> String {
        if item.id.isEmpty {
            return "Source: iPhone voice"
        }
        let lang = item.language.isEmpty ? "" : " · \(CallVoiceCatalog.displayLanguage(item.language))"
        return "Source: iPhone voice\(lang)"
    }

    private func previewButton(for voiceId: String) -> some View {
        let isAllowed = VoiceFeedbackPolicy.isVoicePreviewAllowed(hasActiveCall: isCallBlockingPreview)
        let isPlaying = previewingVoiceId == voiceId

        return Button {
            if isPlaying {
                stopPreview()
            } else {
                startPreview(voiceId: voiceId)
            }
        } label: {
            Image(systemName: isPlaying ? "stop.circle.fill" : "play.circle.fill")
                .font(.title3)
                .foregroundStyle(isAllowed ? (isPlaying ? Color.red : Color.accentColor) : Color.secondary.opacity(0.4))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.borderless)
        .disabled(!isAllowed)
        .accessibilityLabel(isPlaying ? "Stop preview" : "Preview voice")
    }

    private func startPreview(voiceId: String) {
        guard VoiceFeedbackPolicy.isVoicePreviewAllowed(hasActiveCall: isCallBlockingPreview), scenePhase == .active else { return }
        stopPreview()
        let generation = previewGeneration
        previewError = nil
        let engine = previewEngine ?? LocalTtsEngine()
        previewEngine = engine
        previewingVoiceId = voiceId

        previewTask = Task { @MainActor in
            guard generation == previewGeneration, !Task.isCancelled, !isCallBlockingPreview else { return }
            do {
                try await engine.speak(
                    text: "Hello! This is how I sound.",
                    voiceIdentifier: voiceId.isEmpty ? nil : voiceId
                )
                if generation == previewGeneration, !Task.isCancelled, previewingVoiceId == voiceId {
                    previewingVoiceId = nil
                }
            } catch {
                if generation == previewGeneration, !Task.isCancelled, previewingVoiceId == voiceId {
                    previewingVoiceId = nil
                    previewError = "Preview could not play"
                }
            }
        }
    }

    private func stopPreview() {
        previewGeneration += 1
        previewTask?.cancel()
        previewTask = nil
        previewEngine?.stop()
        previewingVoiceId = nil
    }

    // MARK: - Custom endpoint section

    private var customEndpointSection: some View {
        Section {
            TextField("Voice name (optional override)", text: $draftPreference.customVoiceOverride)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } header: {
            Text("Source: Custom voice")
        } footer: {
            Text("Leave blank to use the voice in Settings. The endpoint key is not stored here.")
        }
    }

    // MARK: - Hub voice section

    private var hubVoiceSection: some View {
        Section {
            Text(hubVoiceLabel)
        } header: {
            Text("Source: Hub voice")
        } footer: {
            Text("Hub calls use \(botName)’s voice on the computer. Change it in the agent profile.")
        }
    }

    private var hubVoiceLabel: String {
        let voice = serverVoice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return voice.isEmpty ? "Workspace default" : voice
    }
}
