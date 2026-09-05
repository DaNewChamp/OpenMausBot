import AVFoundation
import AudioToolbox
import SwiftUI
import CompanionCore

@MainActor
enum VoiceCallFeedback {
    static func tone(for phase: VoiceSessionPhase) {
        switch phase {
        case .listening:
            AudioServicesPlaySystemSound(1113)
        case .thinking:
            AudioServicesPlaySystemSound(1114)
        case .speaking:
            AudioServicesPlaySystemSound(1104)
        case .idle:
            break
        }
    }

    static func haptic(for phase: VoiceSessionPhase) {
        let generator = UIImpactFeedbackGenerator(style: phase == .speaking ? .medium : .light)
        generator.prepare()
        generator.impactOccurred(intensity: phase == .thinking ? 0.45 : 0.75)
    }
}

struct PremiumVoiceOrb: View {
    let phase: VoiceSessionPhase
    let micLevel: Float
    let voiceLevel: Float
    let reduceMotion: Bool

    private var activity: CGFloat {
        switch phase {
        case .listening: return CGFloat(max(micLevel, 0.08))
        case .speaking: return CGFloat(max(voiceLevel, 0.08))
        case .thinking: return 0.42
        case .idle: return 0.08
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 1 : 1.0 / 30.0, paused: reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let breathe = reduceMotion ? 0 : (sin(t * 2.2) + 1) * 0.5
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .overlay(Circle().fill(Color.white.opacity(0.05 + activity * 0.08)))
                    .scaleEffect(1 + activity * 0.08 + breathe * 0.02)
                Circle()
                    .stroke(Color.white.opacity(0.18 + activity * 0.42), lineWidth: 1.5 + activity * 2.5)
                    .scaleEffect(1.08 + activity * 0.12 + breathe * 0.04)
                    .blur(radius: 2 + activity * 5)
                Circle()
                    .stroke(Color.white.opacity(0.08 + activity * 0.25), lineWidth: 1)
                    .scaleEffect(1.28 + breathe * 0.06)
                VoiceOrb(phase: phase, level: micLevel, voiceLevel: voiceLevel, reduceMotion: reduceMotion)
                    .scaleEffect(0.82)
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.28), value: phase)
            .animation(reduceMotion ? nil : .linear(duration: 0.08), value: activity)
        }
    }
}
