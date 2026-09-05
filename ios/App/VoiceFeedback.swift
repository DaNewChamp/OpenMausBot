import AVFoundation
import SwiftUI
import CompanionCore

@MainActor
enum VoiceCallFeedback {
    /// Triggers restrained haptic feedback for call phases.
    /// Restrained, foreground-only, and NEVER when microphone is listening.
    static func haptic(
        for phase: VoiceSessionPhase,
        isForeground: Bool = true,
        isMuted: Bool = false,
        isDisconnected: Bool = false
    ) {
        guard VoiceFeedbackPolicy.shouldPlayHaptic(
            phase: phase,
            isForeground: isForeground,
            isMuted: isMuted,
            isDisconnected: isDisconnected
        ) else { return }

        let style: UIImpactFeedbackGenerator.FeedbackStyle = phase == .speaking ? .medium : .light
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        let intensity = CGFloat(VoiceFeedbackPolicy.hapticIntensity(for: phase))
        generator.impactOccurred(intensity: intensity)
    }
}

/// The premium call orb container: handles outer rings, halos, and materials.
/// Reflects distinct muted/reconnecting non-listening states and stops all continuous
/// animation when Reduce Motion is on or the app is backgrounded.
struct PremiumVoiceOrb: View {
    let phase: VoiceSessionPhase
    let micLevel: Float
    let voiceLevel: Float
    let isMuted: Bool
    let isDisconnected: Bool
    let reduceMotion: Bool
    var isBackground: Bool = false

    private var visualState: VoiceFeedbackPolicy.OrbVisualState {
        VoiceFeedbackPolicy.orbVisualState(
            phase: phase,
            isMuted: isMuted,
            isDisconnected: isDisconnected
        )
    }

    private var activity: CGFloat {
        CGFloat(VoiceFeedbackPolicy.effectiveAmplitude(
            phase: phase,
            micLevel: micLevel,
            voiceLevel: voiceLevel,
            isMuted: isMuted,
            isDisconnected: isDisconnected
        ))
    }

    var body: some View {
        let isPaused = !VoiceFeedbackPolicy.allowsContinuousMotion(reduceMotion: reduceMotion, isBackground: isBackground)

        TimelineView(.animation(minimumInterval: isPaused ? 1.0 : (1.0 / 30.0), paused: isPaused)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let breathe: CGFloat = isPaused ? 0 : CGFloat((sin(t * 2.2) + 1) * 0.5)

            let coreScale: CGFloat = {
                if isPaused { return 1.0 }
                switch visualState {
                case .reconnecting:
                    return 0.96
                case .muted:
                    return 0.98
                case .thinking:
                    return 1.0
                case .idle:
                    return 1.0 + breathe * 0.015
                case .listening, .speaking:
                    return 1.0 + activity * 0.08 + breathe * 0.02
                }
            }()

            let haloScale: CGFloat = {
                if isPaused { return 1.04 }
                switch visualState {
                case .reconnecting:
                    return 1.02
                case .muted:
                    return 1.03
                case .thinking:
                    return 1.06 + breathe * 0.02
                case .idle:
                    return 1.05 + breathe * 0.02
                case .listening, .speaking:
                    return 1.08 + activity * 0.12 + breathe * 0.04
                }
            }()

            let outerScale: CGFloat = {
                if isPaused { return 1.15 }
                switch visualState {
                case .reconnecting:
                    return 1.10
                case .muted:
                    return 1.12
                case .thinking:
                    return 1.20 + breathe * 0.03
                case .idle:
                    return 1.18 + breathe * 0.03
                case .listening, .speaking:
                    return 1.28 + breathe * 0.06
                }
            }()

            let coreOpacity: Double = {
                switch visualState {
                case .reconnecting:
                    return 0.02
                case .muted:
                    return 0.03
                case .idle:
                    return 0.05
                case .thinking:
                    return 0.06
                case .listening, .speaking:
                    return Double(0.05 + activity * 0.08)
                }
            }()

            let haloOpacity: Double = {
                switch visualState {
                case .reconnecting:
                    return 0.08
                case .muted:
                    return 0.10
                case .idle:
                    return 0.16
                case .thinking:
                    return 0.22
                case .listening, .speaking:
                    return Double(0.18 + activity * 0.42)
                }
            }()

            let outerOpacity: Double = {
                switch visualState {
                case .reconnecting:
                    return 0.04
                case .muted:
                    return 0.05
                case .idle:
                    return 0.07
                case .thinking:
                    return 0.12
                case .listening, .speaking:
                    return Double(0.08 + activity * 0.25)
                }
            }()

            let haloWidth: CGFloat = (visualState == .muted || visualState == .reconnecting)
                ? 1.0
                : (1.5 + activity * 2.5)

            let haloBlur: CGFloat = (visualState == .muted || visualState == .reconnecting)
                ? 1.5
                : (2.0 + activity * 5.0)

            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .overlay(Circle().fill(Color.white.opacity(coreOpacity)))
                    .scaleEffect(coreScale)

                Circle()
                    .stroke(
                        visualState == .muted
                            ? Color.white.opacity(haloOpacity * 0.7)
                            : (visualState == .reconnecting
                                ? Color.white.opacity(haloOpacity * 0.5)
                                : Color.white.opacity(haloOpacity)),
                        lineWidth: haloWidth
                    )
                    .scaleEffect(haloScale)
                    .blur(radius: haloBlur)

                Circle()
                    .stroke(Color.white.opacity(outerOpacity), lineWidth: 1)
                    .scaleEffect(outerScale)

                VoiceOrb(
                    phase: phase,
                    level: micLevel,
                    voiceLevel: voiceLevel,
                    isMuted: isMuted,
                    isDisconnected: isDisconnected,
                    reduceMotion: reduceMotion,
                    isBackground: isBackground
                )
                .scaleEffect(0.82)
            }
            .animation(isPaused ? nil : .smooth(duration: 0.28), value: phase)
            .animation(isPaused ? nil : .linear(duration: 0.08), value: activity)
        }
    }
}
