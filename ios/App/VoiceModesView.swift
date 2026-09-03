// Live voice mode: the full-screen black surface and the orb.
//
// ChatGPT's shape — a glowing orb that carries the state, a line or two of
// transcript under it, and a bottom bar with a composer, a mute, and a way
// out. The surface is black regardless of scheme: it is a different room,
// not a themed screen, and the ink on it is white for the same reason.
// Everything that moves obeys Reduce Motion by falling back to a still orb.
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
        VoiceOrb(phase: controller.phase, level: controller.micLevel, reduceMotion: reduceMotion)
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

/// Indigo/violet radial core with a soft outer bloom. The animations are
/// the state: idle breathes dim, listening pulses with the mic, thinking
/// spins a highlight around the rim, speaking swells gently.
struct VoiceOrb: View {
    let phase: VoiceSessionPhase
    let level: Float
    let reduceMotion: Bool

    @State private var breathing = false
    @State private var orbiting = false
    @State private var speakingPulse = false

    private var coreScale: CGFloat {
        switch phase {
        case .idle:
            return breathing ? 1.0 : 1.02
        case .listening:
            return 1.0 + CGFloat(min(level, 0.5)) * 0.12
        case .thinking:
            return 1.0
        case .speaking:
            return speakingPulse ? 1.05 : 1.0
        }
    }

    private var coreOpacity: Double {
        switch phase {
        case .idle: return 0.5
        default: return 1.0
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(hex: "#C7D2FE").opacity(0.9),
                            Color(hex: "#818CF8"),
                            Color(hex: "#6D5DF6"),
                            Color(hex: "#7C3AED"),
                            Color(hex: "#2E1065"),
                        ],
                        center: .init(x: 0.4, y: 0.35),
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
                .shadow(color: Color(hex: "#7C3AED").opacity(0.55), radius: 44)

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

            if phase == .speaking {
                SpeakingBars()
                    .padding(58)
            }
        }
        .scaleEffect(coreScale)
        .opacity(coreOpacity)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: level)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.9), value: phase)
        .onAppear { runAnimations() }
        .onChange(of: phase) { _, _ in runAnimations() }
    }

    private func runAnimations() {
        breathing = false
        orbiting = false
        speakingPulse = false
        guard !reduceMotion else { return }
        switch phase {
        case .idle:
            withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) {
                breathing = true
            }
        case .listening:
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                breathing = true
            }
        case .thinking:
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) {
                orbiting = true
            }
        case .speaking:
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                speakingPulse = true
            }
        }
    }
}

/// Amplitude bars inside the orb while the voice plays. The clip's real
/// loudness is not worth a metering tap on the shared player — five bars
/// breathing out of phase read as "speaking" at a glance.
private struct SpeakingBars: View {
    @State private var up = false

    private let specs: [(height: CGFloat, delay: Double)] = [
        (0.35, 0.0), (0.75, 0.12), (1.0, 0.24), (0.6, 0.36), (0.3, 0.48),
    ]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(specs.enumerated()), id: \.offset) { index, spec in
                Capsule()
                    .fill(Color.white.opacity(0.9))
                    .frame(width: 5, height: 46)
                    .scaleEffect(y: up ? spec.height : 0.2, anchor: .center)
                    .animation(
                        up
                            ? .easeInOut(duration: 0.42 + Double(index) * 0.05).repeatForever(autoreverses: true).delay(spec.delay)
                            : .easeInOut(duration: 0.2),
                        value: up
                    )
            }
        }
        .onAppear { up = true }
    }
}
