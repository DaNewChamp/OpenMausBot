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
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var controller: VoiceModeController
    @State private var typed = ""
    @State private var showingCallVoice = false
    @FocusState private var composerFocused: Bool

    private var chatName: String { controller.chat?.name ?? "bot" }
    private var callBot: Bot? {
        guard let chat = controller.chat, case let .bot(bot) = chat else { return nil }
        return session.state.bot(bot.id) ?? bot
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                callHeader
                    .padding(.top, 12)
                Spacer()
                orb
#if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-voice-level-probe") {
                    Text(String(format: "level %.2f", controller.micLevel))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.55))
                        .padding(.top, 12)
                        .accessibilityIdentifier("voice-level-probe")
                }
#endif
                statusLine
                    .padding(.top, 28)
                if controller.phase == .speaking {
                    VoiceAmplitudeBars(level: controller.voiceLevel, reduceMotion: reduceMotion)
                        .padding(.top, 10)
                }
                if let islandNote = controller.islandNote {
                    Text(islandNote)
                        .font(.footnote)
                        .foregroundStyle(Color.white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .padding(.top, 10)
                }
                Spacer()
                callControls
                bottomBar
            }
            .padding(.horizontal, 24)
        }
        // Session owns the controller. Appearing or disappearing this
        // cover must not start or tear down the mic/TTS/island.
        .onChange(of: controller.phase) { oldPhase, newPhase in
            guard oldPhase != newPhase else { return }
            VoiceCallFeedback.haptic(for: newPhase)
            VoiceCallFeedback.tone(for: newPhase)
        }
        .sheet(isPresented: $showingCallVoice) {
            if let bot = callBot {
                CallVoicePickerSheet(
                    botId: bot.id,
                    botName: bot.name,
                    serverVoice: bot.voice
                )
            }
        }
#if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("-voice-level-probe"),
               controller.phase == .idle {
                controller.orbTapped()
            }
        }
#endif
    }

    private var callHeader: some View {
        VStack(spacing: 10) {
            if let chat = controller.chat {
                ChatAvatarView(chat: chat, size: 88)
                    .accessibilityHidden(true)
            }
            Text(chatName)
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Color.white)
            if let startedAt = controller.callStartedAt {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(VoiceSessionPolicy.callDurationLabel(elapsed: Date().timeIntervalSince(startedAt)))
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.55))
                        .accessibilityLabel("Time in call")
                }
            }
            Text(VoiceSessionPolicy.callStatusLine(for: controller.phase, micMuted: controller.isMuted))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.white.opacity(0.7))
                .accessibilityAddTraits(.updatesFrequently)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - The orb

    private var orb: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 1 : 1.0 / 30.0, paused: reduceMotion)) { timeline in
            let _ = timeline.date
            PremiumVoiceOrb(
                phase: controller.phase,
                micLevel: controller.micLevel,
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
            .accessibilityHint(controller.phase == .idle ? "Starts listening" : "Stops or interrupts")
        }
    }

    /// The one line under the orb: what was heard or what the bot is saying.
    private var statusLine: some View {
        Text(statusText)
            .font(.system(.title3, design: .serif))
            .foregroundStyle(statusIsBright ? Color.white : Color.white.opacity(0.55))
            .multilineTextAlignment(.center)
            .lineLimit(6)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .top)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: controller.phase)
    }

    private var statusText: String {
        switch controller.phase {
        case .idle:
            return VoiceSessionPolicy.callStatusLine(for: .idle, micMuted: controller.isMuted)
        case .listening:
            return controller.heard.isEmpty
                ? VoiceSessionPolicy.callStatusLine(for: .listening, micMuted: controller.isMuted)
                : controller.heard
        case .thinking:
            return controller.heard.isEmpty
                ? VoiceSessionPolicy.callStatusLine(for: .thinking, micMuted: controller.isMuted)
                : "\(controller.heard)\n\(VoiceSessionPolicy.callStatusLine(for: .thinking, micMuted: controller.isMuted))"
        case .speaking:
            return controller.replyText.isEmpty
                ? VoiceSessionPolicy.callStatusLine(for: .speaking, micMuted: controller.isMuted)
                : controller.replyText
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
        case .idle: return controller.isMuted ? "Call muted. Tap to talk" : "Call idle. Tap to talk"
        case .listening: return "Listening. Tap to send"
        case .thinking: return "Waiting for the reply. Tap to interrupt"
        case .speaking: return "Speaking. Tap to interrupt"
        }
    }

    // MARK: - Call controls

    private var callControls: some View {
        VStack(spacing: 22) {
            HStack(spacing: 36) {
                Button {
                    Haptics.selection()
                    controller.toggleMute()
                } label: {
                    Image(systemName: controller.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.white)
                        .frame(width: 64, height: 64)
                        .background(
                            Circle().fill(controller.isMuted ? Color.white.opacity(0.28) : Color.white.opacity(0.12))
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(VoiceControlButtonStyle(reduceMotion: reduceMotion))
                .animation(reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0.1), value: controller.isMuted)
                .accessibilityLabel(controller.isMuted ? "Unmute microphone" : "Mute microphone")

                CallRoutePicker()
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(Color.white.opacity(0.12)))
                    .clipShape(Circle())
                    .accessibilityLabel("Audio output")

                Button {
                    Haptics.selection()
                    showingCallVoice = true
                } label: {
                    Image(systemName: "waveform")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.white)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(Color.white.opacity(0.12)))
                        .contentShape(Circle())
                }
                .buttonStyle(VoiceControlButtonStyle(reduceMotion: reduceMotion))
                .disabled(callBot == nil)
                .accessibilityLabel("Call voice")
            }

            Button {
                Haptics.selection()
                controller.close()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 76, height: 76)
                    .background(Circle().fill(Color.red))
                    .contentShape(Circle())
            }
            .buttonStyle(VoiceControlButtonStyle(reduceMotion: reduceMotion))
            .accessibilityLabel("End call")
        }
        .padding(.bottom, 8)
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        HStack(spacing: 14) {
            composer
        }
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Message \(chatName)…", text: $typed, axis: .vertical)
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
            Button {
                Haptics.selection()
                sendTyped()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.black)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.white))
                    .contentShape(Circle())
            }
            .buttonStyle(VoiceControlButtonStyle(reduceMotion: reduceMotion))
            .opacity(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.35 : 1)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .easeOut(duration: 0.18), value: typed.isEmpty)
            .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
    }

    private func sendTyped() {
        controller.sendTyped(typed)
        typed = ""
    }
}

/// Press feedback for the bottom bar: sink and dim on touch-down, spring
/// back on release. Reduce Motion gets opacity only — no scale, no spring.
private struct VoiceControlButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(
                reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.22, extraBounce: 0.14),
                value: configuration.isPressed
            )
    }
}

// MARK: - The speaking state, in bars

/// Amplitude bars under the orb while a reply is spoken — the complement
/// of the thinking orbit, so the silent wait and the playback read
/// differently at a glance even before the voice starts. The heights ride
/// the real voice-output level with a fixed symmetric envelope across the
/// row; Reduce Motion holds a fixed mid shape.
private struct VoiceAmplitudeBars: View {
    let level: Float
    let reduceMotion: Bool

    /// Per-bar gain across the row: quiet edges, loud middle.
    private static let gains: [Double] = [0.55, 0.8, 1.0, 0.8, 0.55]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<Self.gains.count, id: \.self) { index in
                Capsule()
                    .fill(Color.white.opacity(0.85))
                    .frame(width: 4, height: barHeight(index))
            }
        }
        .frame(height: 26)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level)
        .accessibilityElement()
        .accessibilityLabel("Speaking")
    }

    private func barHeight(_ index: Int) -> CGFloat {
        let shaped = level < 0.04 && !reduceMotion ? 0.12 : level
        return 5 + CGFloat(shaped) * 20 * CGFloat(Self.gains[index])
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
    /// A brief brightness step as the floor hands back to the user — the
    /// auto-listen resuming after a reply should read at a glance.
    @State private var listenFlash = false

    /// The amplitude driving this phase, already 0...1 from LevelFollower.
    private var activeLevel: CGFloat {
        let raw: Float
        switch phase {
        case .listening: raw = level
        case .speaking: raw = voiceLevel
        case .idle, .thinking: raw = 0
        }
        return CGFloat(min(max(raw, 0), 1))
    }

    private var coreScale: CGFloat {
        if reduceMotion { return 1 }
        switch phase {
        case .idle:
            return breathing ? 1.0 : 1.04
        case .listening:
            return 1.0 + (breathing ? 0.02 : 0.0) + activeLevel * 0.38
        case .thinking:
            return 1.0
        case .speaking:
            return 1.0 + activeLevel * 0.32
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
        .brightness(reduceMotion ? 0 : (listenFlash ? 0.3 : 0))
        // The step up is quick; the settle back is slower, so the flash
        // reads as one beat, not a blink.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: listenFlash)
        // TimelineView is the animation engine: it samples mic/voice level
        // every frame. Binding scale to `.animation(value:)` here made the
        // orb look frozen — SwiftUI coalesced the 50 Hz assignments into
        // one interpolation that never visibly moved.
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
            // mic, so silence keeps the idle breath. Entering the phase
            // flashes brighter first — the loop is visibly back to you.
            withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) {
                breathing = true
            }
            listenFlash = true
            withAnimation(.easeInOut(duration: 0.7).delay(0.5)) {
                listenFlash = false
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
