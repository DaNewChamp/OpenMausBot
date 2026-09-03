// Live voice mode: the full-screen black surface and the orb.
//
// ChatGPT's shape — an orb that carries the state and moves with the
// actual voice, a line or two of transcript under it, and a bottom bar
// with a composer, a mute, and a way out. The surface is black regardless
// of scheme: it is a different room, not a themed screen, and the ink on
// it is white for the same reason. The orb is monochrome to match: white
// and gray on black, with no accent color anywhere. While listening it
// swells with the real microphone level; while speaking it pulses with
// the real voice output. Everything that moves obeys Reduce Motion by
// falling back to a still orb whose states are opacity only.
import SwiftUI
import CompanionCore

struct VoiceModesView: View {
    let chat: Chat
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @AppStorage(PrefKey.voiceIsland) private var voiceIslandEnabled = true
    @StateObject private var controller: VoiceModeController
    @State private var typed = ""
    @FocusState private var composerFocused: Bool

    init(chat: Chat) {
        self.chat = chat
        _controller = StateObject(wrappedValue: VoiceModeController(chat: chat))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer()
                orb
                statusLine
                    .padding(.top, 36)
                Spacer()
                bottomBar
            }
            .padding(.horizontal, 24)
        }
        .onAppear {
            controller.activate(session: session, islandEnabled: voiceIslandEnabled) {
                dismiss()
            }
        }
        .onDisappear {
            controller.shutdown()
        }
        .onChange(of: scenePhase) { _, phase in
            // A backgrounded app must not keep a mic capture armed.
            if phase != .active { controller.close() }
        }
    }

    // MARK: - The orb

    private var orb: some View {
        VoiceOrb(
            phase: controller.phase,
            level: controller.micLevel,
            voiceLevel: controller.voiceLevel,
            reduceMotion: reduceMotion
        )
            .frame(width: 190, height: 190)
            .contentShape(Circle())
            .onTapGesture {
                Haptics.selection()
                composerFocused = false
                controller.orbTapped()
            }
            .accessibilityElement()
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(controller.phase == .idle ? "Starts the microphone" : "Stops or interrupts")
    }

    /// The one line under the orb: what was heard, what is happening, or
    /// what the bot is saying — the state, in words.
    private var statusLine: some View {
        Text(statusText)
            .font(.system(.title3, design: .serif))
            .foregroundStyle(statusIsBright ? Color.white : Color.white.opacity(0.55))
            .multilineTextAlignment(.center)
            .lineLimit(6)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .top)
            .animation(.easeOut(duration: 0.2), value: controller.phase)
    }

    private var statusText: String {
        switch controller.phase {
        case .idle:
            return "Tap the orb to talk"
        case .listening:
            return controller.heard.isEmpty ? "Listening…" : controller.heard
        case .thinking:
            return controller.heard.isEmpty ? "Thinking…" : "\(controller.heard)\nThinking…"
        case .speaking:
            return controller.replyText
        }
    }

    private var statusIsBright: Bool {
        switch controller.phase {
        case .idle, .thinking: return false
        case .listening, .speaking: return true
        }
    }

    private var accessibilityText: String {
        switch controller.phase {
        case .idle: return "Voice mode, idle"
        case .listening: return "Listening. Tap to send"
        case .thinking: return "Waiting for the reply. Tap to interrupt"
        case .speaking: return "Speaking. Tap to interrupt"
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        HStack(spacing: 14) {
            composer
            Button {
                Haptics.selection()
                controller.toggleMute()
            } label: {
                Image(systemName: controller.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .font(.body.weight(.medium))
                    .foregroundStyle(controller.isMuted ? Color.white.opacity(0.45) : Color.white)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white.opacity(0.10)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(controller.isMuted ? "Unmute replies" : "Mute replies")

            Button {
                Haptics.selection()
                controller.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white.opacity(0.10)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close voice mode")
        }
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    private var composer: some View {
        TextField("Message \(chat.name)…", text: $typed, axis: .vertical)
            .lineLimit(1...4)
            .font(.body)
            .foregroundStyle(Color.white)
            .tint(Color.white)
            .focused($composerFocused)
            .textInputAutocapitalization(.sentences)
            .submitLabel(.send)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(Capsule().fill(Color.white.opacity(0.10)))
            .onSubmit { sendTyped() }
    }

    private func sendTyped() {
        controller.sendTyped(typed)
        typed = ""
    }
}

// MARK: - The orb itself

/// White and gray on black. The motion is the voice: while listening the
/// core swells with the smoothed microphone level, while speaking it
/// pulses with the real playback amplitude, thinking orbits a highlight
/// around the rim, idle breathes dim. Reduce Motion keeps the level out
/// of the geometry entirely — phases become fixed opacity steps.
struct VoiceOrb: View {
    let phase: VoiceSessionPhase
    let level: Float
    let voiceLevel: Float
    let reduceMotion: Bool

    @State private var breathing = false
    @State private var orbiting = false

    /// The amplitude driving this phase, normalized to 0...1. Mic RMS in a
    /// lively room tops out around 0.45; voice output arrives clamped.
    private var activeLevel: CGFloat {
        let raw: Float
        switch phase {
        case .listening: raw = level / 0.45
        case .speaking: raw = voiceLevel
        case .idle, .thinking: raw = 0
        }
        return CGFloat(min(max(raw, 0), 1))
    }

    private var coreScale: CGFloat {
        if reduceMotion { return 1 }
        switch phase {
        case .idle:
            return breathing ? 1.0 : 1.02
        case .listening:
            return 1.0 + (breathing ? 0.01 : 0.0) + activeLevel * 0.16
        case .thinking:
            return 1.0
        case .speaking:
            return 1.0 + activeLevel * 0.13
        }
    }

    private var coreOpacity: Double {
        if reduceMotion {
            switch phase {
            case .idle: return 0.4
            case .listening: return 0.9
            case .thinking: return 0.65
            case .speaking: return 0.95
            }
        }
        switch phase {
        case .idle: return 0.45
        case .listening, .speaking, .thinking: return 1.0
        }
    }

    /// The bloom behind the core: loud is bright. Idle keeps a faint ash.
    private var glowOpacity: Double {
        guard !reduceMotion else { return phase == .idle ? 0.1 : 0.2 }
        switch phase {
        case .idle: return 0.12
        case .thinking: return 0.28
        case .listening, .speaking:
            return 0.22 + Double(activeLevel) * 0.4
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.white.opacity(0.98),
                            Color(hex: "#E8E8E8"),
                            Color(hex: "#9A9A9A"),
                            Color(hex: "#3D3D3D"),
                            Color(hex: "#141414"),
                        ],
                        center: .init(x: 0.42, y: 0.34),
                        startRadius: 4,
                        endRadius: 98
                    )
                )
                .overlay {
                    Circle()
                        .stroke(
                            LinearGradient(
                                colors: [Color.white.opacity(0.55), Color.white.opacity(0.05)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1.5
                        )
                }
                .shadow(color: Color.white.opacity(glowOpacity), radius: 44)

            if phase == .thinking {
                Circle()
                    .stroke(
                        AngularGradient(
                            colors: [Color.white.opacity(0), Color.white.opacity(0.9), Color.white.opacity(0)],
                            center: .center,
                            startAngle: .degrees(orbiting ? 360 : 0),
                            endAngle: .degrees(orbiting ? 720 : 360)
                        ),
                        lineWidth: 3
                    )
                    .padding(9)
            }
        }
        .scaleEffect(coreScale)
        .opacity(coreOpacity)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: voiceLevel)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.9), value: phase)
        .onAppear { runAnimations() }
        .onChange(of: phase) { _, _ in runAnimations() }
    }

    private func runAnimations() {
        breathing = false
        orbiting = false
        guard !reduceMotion else { return }
        switch phase {
        case .idle:
            withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) {
                breathing = true
            }
        case .listening:
            // The level does the moving here; a still core reads as dead
            // mic, so silence keeps the idle breath.
            withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) {
                breathing = true
            }
        case .thinking:
            withAnimation(.linear(duration: 2.6).repeatForever(autoreverses: false)) {
                orbiting = true
            }
        case .speaking:
            // Voice amplitude drives the swell; no synthetic pulse.
            break
        }
    }
}
