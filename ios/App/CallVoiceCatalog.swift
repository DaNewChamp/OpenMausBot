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

    private static func displayLanguage(_ code: String) -> String {
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

    @Environment(\.dismiss) private var dismiss
    @State private var preference: CallVoicePreference
    private let engine = VoiceOutputSettings.load().engine
    private let voices = CallVoiceCatalog.onDeviceVoices()

    init(botId: String, botName: String, serverVoice: String?) {
        self.botId = botId
        self.botName = botName
        self.serverVoice = serverVoice
        _preference = State(initialValue: CallVoicePreferenceStore.load(botId: botId))
    }

    var body: some View {
        NavigationStack {
            List {
                switch engine {
                case .onDevice:
                    Section {
                        voiceRow(id: "", label: "System default")
                        ForEach(voices) { voice in
                            voiceRow(id: voice.id, label: voice.label)
                        }
                    } header: {
                        Text("On-device voice")
                    } footer: {
                        Text("Stays on this iPhone. Does not change \(botName)’s hub voice.")
                    }
                case .customEndpoint:
                    Section {
                        TextField("Voice name (optional override)", text: $preference.customVoiceOverride)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } header: {
                        Text("Custom endpoint voice")
                    } footer: {
                        Text("Leave blank to use the voice in Settings. The endpoint key is not stored here.")
                    }
                case .hub:
                    Section {
                        Text(hubVoiceLabel)
                    } header: {
                        Text("Hub voice")
                    } footer: {
                        Text("Hub calls use \(botName)’s voice on the computer. Change it in the agent profile.")
                    }
                }
            }
            .navigationTitle("Call voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        CallVoicePreferenceStore.save(preference, botId: botId)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var hubVoiceLabel: String {
        let voice = serverVoice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return voice.isEmpty ? "Workspace default" : voice
    }

    private func voiceRow(id: String, label: String) -> some View {
        Button {
            preference.onDeviceVoiceIdentifier = id
        } label: {
            HStack {
                Text(label)
                    .foregroundStyle(.primary)
                Spacer()
                if preference.onDeviceVoiceIdentifier == id {
                    Image(systemName: "checkmark")
                }
            }
        }
    }
}
