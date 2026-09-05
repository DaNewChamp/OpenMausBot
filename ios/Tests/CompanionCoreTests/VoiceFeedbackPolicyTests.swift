// Tests for VoiceFeedbackPolicy:
// Covers phase x muted x disconnected x background x ReduceMotion matrix,
// and guarantees no listening haptics/cues and safe non-interfering audio.
import XCTest
@testable import CompanionCore

final class VoiceFeedbackPolicyTests: XCTestCase {

    func testMicrophoneMuteDoesNotHideAgentPlaybackAmplitude() {
        XCTAssertEqual(VoiceFeedbackPolicy.effectiveAmplitude(phase: .speaking, micLevel: 0.8,
            voiceLevel: 0.6, isMuted: true, isDisconnected: false), 0.6, accuracy: 0.001)
    }
    func testLocaleWithUnderscorePrioritizesCurrentLanguage() {
        let choices = [
            VoiceFeedbackPolicy.VoiceChoice(id: "french", name: "Thomas", language: "fr-FR"),
            VoiceFeedbackPolicy.VoiceChoice(id: "english", name: "Samantha", language: "en-US"),
        ]
        let result = VoiceFeedbackPolicy.prioritizeVoices(available: choices, currentVoiceId: "", currentLanguageCode: "en_US")
        XCTAssertEqual(result.prefix(2).map(\.id), ["", "english"])
    }

    // MARK: - 1. Haptics & Sound Cues: Restrained, Foreground-Only, Never While Listening

    func testNoHapticOrSoundWhileMicrophoneListeningUnderAnyCondition() {
        let phases: [VoiceSessionPhase] = [.listening]
        let booleans = [false, true]

        for phase in phases {
            for muted in booleans {
                for disconnected in booleans {
                    for background in booleans {
                        for reduceMotion in booleans {
                            let shouldHaptic = VoiceFeedbackPolicy.shouldPlayHaptic(
                                phase: phase,
                                isForeground: !background,
                                isMuted: muted,
                                isDisconnected: disconnected
                            )
                            XCTAssertFalse(
                                shouldHaptic,
                                "Listening phase must NEVER trigger haptics (muted=\(muted), disconnected=\(disconnected), bg=\(background), rm=\(reduceMotion))"
                            )

                            let shouldTone = VoiceFeedbackPolicy.shouldPlayTone(
                                phase: phase,
                                soundsEnabled: true
                            )
                            XCTAssertFalse(
                                shouldTone,
                                "Listening phase must NEVER trigger sound cues that could bleed into the mic"
                            )
                        }
                    }
                }
            }
        }
    }

    func testSoundsAreOffByDefaultAndPhaseChirpsRemoved() {
        XCTAssertFalse(VoiceFeedbackPolicy.defaultSoundsEnabled, "Sound cues must be off by default")

        for phase in [VoiceSessionPhase.idle, .listening, .thinking, .speaking] {
            XCTAssertFalse(
                VoiceFeedbackPolicy.shouldPlayTone(phase: phase, soundsEnabled: false),
                "No tone should play for \(phase) when sounds are off"
            )
            // Even when sounds are hypothetically enabled, undocumented chirps are gone:
            // listening is always blocked
            if phase == .listening {
                XCTAssertFalse(VoiceFeedbackPolicy.shouldPlayTone(phase: phase, soundsEnabled: true))
            }
        }
    }

    func testHapticsOnlyInForegroundAndRestrained() {
        let allPhases: [VoiceSessionPhase] = [.idle, .listening, .thinking, .speaking]

        // Background: NEVER play haptics
        for phase in allPhases {
            XCTAssertFalse(
                VoiceFeedbackPolicy.shouldPlayHaptic(
                    phase: phase,
                    isForeground: false,
                    isMuted: false,
                    isDisconnected: false
                ),
                "Background must never play haptics for \(phase)"
            )
        }

        // Foreground: Idle must never play haptic
        XCTAssertFalse(
            VoiceFeedbackPolicy.shouldPlayHaptic(
                phase: .idle,
                isForeground: true,
                isMuted: false,
                isDisconnected: false
            )
        )

        // Disconnected: NEVER play phase haptics
        for phase in allPhases {
            XCTAssertFalse(
                VoiceFeedbackPolicy.shouldPlayHaptic(
                    phase: phase,
                    isForeground: true,
                    isMuted: false,
                    isDisconnected: true
                ),
                "Disconnected session must not play phase haptic for \(phase)"
            )
        }

        // Foreground, connected: Thinking and Speaking receive restrained haptics
        XCTAssertTrue(
            VoiceFeedbackPolicy.shouldPlayHaptic(
                phase: .thinking,
                isForeground: true,
                isMuted: false,
                isDisconnected: false
            )
        )
        XCTAssertTrue(
            VoiceFeedbackPolicy.shouldPlayHaptic(
                phase: .speaking,
                isForeground: true,
                isMuted: false,
                isDisconnected: false
            )
        )

        // Restrained intensities
        let thinkingIntensity = VoiceFeedbackPolicy.hapticIntensity(for: .thinking)
        let speakingIntensity = VoiceFeedbackPolicy.hapticIntensity(for: .speaking)
        XCTAssertLessThanOrEqual(thinkingIntensity, 0.5, "Thinking haptic must be restrained/subtle")
        XCTAssertLessThanOrEqual(speakingIntensity, 0.7, "Speaking haptic must be restrained")
    }

    // MARK: - 2. Phase x Muted x Disconnected x Background x ReduceMotion Matrix

    func testOrbVisualStateAndAmplitudeMatrix() {
        let phases: [VoiceSessionPhase] = [.idle, .listening, .thinking, .speaking]
        let booleans = [false, true]

        for phase in phases {
            for muted in booleans {
                for disconnected in booleans {
                    for background in booleans {
                        for reduceMotion in booleans {
                            let state = VoiceFeedbackPolicy.orbVisualState(
                                phase: phase,
                                isMuted: muted,
                                isDisconnected: disconnected
                            )

                            let amp = VoiceFeedbackPolicy.effectiveAmplitude(
                                phase: phase,
                                micLevel: 0.65,
                                voiceLevel: 0.75,
                                isMuted: muted,
                                isDisconnected: disconnected
                            )

                            let allowsContinuousMotion = VoiceFeedbackPolicy.allowsContinuousMotion(
                                reduceMotion: reduceMotion,
                                isBackground: background
                            )

                            // 1. Disconnected check
                            if disconnected {
                                XCTAssertEqual(state, .reconnecting, "Disconnected state must show reconnecting look")
                                XCTAssertEqual(amp, 0.0, "Disconnected orb must have zero amplitude")
                            } else if muted {
                                // 2. Muted check
                                if phase == .listening || phase == .idle {
                                    XCTAssertEqual(state, .muted, "Muted state must show distinct muted look")
                                }
                                if phase == .listening {
                                    XCTAssertEqual(amp, 0.0, "Muted mic must have zero amplitude")
                                }
                            }

                            // 3. Idle / Thinking must never have fake audio amplitude
                            if phase == .idle || phase == .thinking {
                                XCTAssertEqual(amp, 0.0, "No fake amplitude in idle or thinking")
                            }

                            // 4. Background and ReduceMotion must stop continuous animation
                            if background || reduceMotion {
                                XCTAssertFalse(
                                    allowsContinuousMotion,
                                    "Continuous motion must be stopped when background=\(background) or reduceMotion=\(reduceMotion)"
                                )
                            } else {
                                XCTAssertTrue(allowsContinuousMotion)
                            }
                        }
                    }
                }
            }
        }
    }

    func testActiveListeningUsesActualMicAmplitudeWithoutFakeFloor() {
        let amp0 = VoiceFeedbackPolicy.effectiveAmplitude(
            phase: .listening,
            micLevel: 0.0,
            voiceLevel: 0.5,
            isMuted: false,
            isDisconnected: false
        )
        XCTAssertEqual(amp0, 0.0, "Zero mic input must yield zero amplitude (no fake floor)")

        let ampReal = VoiceFeedbackPolicy.effectiveAmplitude(
            phase: .listening,
            micLevel: 0.42,
            voiceLevel: 0.0,
            isMuted: false,
            isDisconnected: false
        )
        XCTAssertEqual(ampReal, 0.42, accuracy: 0.001, "Listening must track actual mic amplitude")
    }

    func testActiveSpeakingUsesActualPlaybackAmplitudeWithoutFakeFloor() {
        let amp0 = VoiceFeedbackPolicy.effectiveAmplitude(
            phase: .speaking,
            micLevel: 0.5,
            voiceLevel: 0.0,
            isMuted: false,
            isDisconnected: false
        )
        XCTAssertEqual(amp0, 0.0, "Zero voice playback must yield zero amplitude")

        let ampReal = VoiceFeedbackPolicy.effectiveAmplitude(
            phase: .speaking,
            micLevel: 0.0,
            voiceLevel: 0.58,
            isMuted: false,
            isDisconnected: false
        )
        XCTAssertEqual(ampReal, 0.58, accuracy: 0.001, "Speaking must track actual voice amplitude")
    }

    func testScaleStopsContinuousMovementWhenReduceMotionOrBackground() {
        let scaleRM = VoiceFeedbackPolicy.coreScale(
            phase: .listening,
            amplitude: 0.8,
            reduceMotion: true,
            isBackground: false,
            breatheOffset: 0.05
        )
        XCTAssertEqual(scaleRM, 1.0, "Reduce motion must stop continuous scaling")

        let scaleBG = VoiceFeedbackPolicy.coreScale(
            phase: .listening,
            amplitude: 0.8,
            reduceMotion: false,
            isBackground: true,
            breatheOffset: 0.05
        )
        XCTAssertEqual(scaleBG, 1.0, "Background must stop continuous scaling")

        let scaleActive = VoiceFeedbackPolicy.coreScale(
            phase: .listening,
            amplitude: 0.5,
            reduceMotion: false,
            isBackground: false,
            breatheOffset: 0.0
        )
        XCTAssertGreaterThan(scaleActive, 1.0, "Active listening should scale with amplitude")
    }

    // MARK: - 3. CallVoicePickerSheet Voice Prioritization & Selection Preservation

    func testVoicePrioritizationKeepsCurrentAndSystemDefaultFirstThenLanguage() {
        let voices = [
            VoiceFeedbackPolicy.VoiceChoice(id: "fr-1", name: "Thomas", language: "fr-FR"),
            VoiceFeedbackPolicy.VoiceChoice(id: "en-1", name: "Samantha", language: "en-US"),
            VoiceFeedbackPolicy.VoiceChoice(id: "en-2", name: "Alex", language: "en-US"),
            VoiceFeedbackPolicy.VoiceChoice(id: "es-1", name: "Monica", language: "es-ES"),
        ]

        let prioritized = VoiceFeedbackPolicy.prioritizeVoices(
            available: voices,
            currentVoiceId: "en-2",
            currentLanguageCode: "en"
        )

        // System default (id: "") is at top
        XCTAssertEqual(prioritized.first?.id, "")
        XCTAssertEqual(prioritized.first?.label, "System default")

        // Current voice is next or grouped in primary section
        let nonDefaultIds = prioritized.filter { !$0.id.isEmpty }.map(\.id)
        XCTAssertTrue(nonDefaultIds.prefix(2).contains("en-2"), "Current voice should be prioritized near the top")

        // English voices prioritized over French/Spanish
        let enIndex = prioritized.firstIndex(where: { $0.id == "en-1" })!
        let frIndex = prioritized.firstIndex(where: { $0.id == "fr-1" })!
        XCTAssertLessThan(enIndex, frIndex, "Current language voices must be prioritized before other languages")
    }

    func testVanishedVoicePreservedInSelection() {
        let voices = [
            VoiceFeedbackPolicy.VoiceChoice(id: "en-1", name: "Samantha", language: "en-US")
        ]

        let prioritized = VoiceFeedbackPolicy.prioritizeVoices(
            available: voices,
            currentVoiceId: "custom-vanished-id",
            currentLanguageCode: "en"
        )

        let preserved = prioritized.first(where: { $0.id == "custom-vanished-id" })
        XCTAssertNotNil(preserved, "Vanished voice ID must not be dropped from selection list")
        XCTAssertTrue(preserved?.isPreserved == true)
    }

    func testPreviewSafetyRule() {
        XCTAssertFalse(
            VoiceFeedbackPolicy.isVoicePreviewAllowed(hasActiveCall: true),
            "Preview must NEVER be allowed during active call to avoid audio conflict"
        )
        XCTAssertTrue(
            VoiceFeedbackPolicy.isVoicePreviewAllowed(hasActiveCall: false),
            "Preview is allowed when no active call"
        )
        XCTAssertFalse(
            VoiceFeedbackPolicy.previewDisabledReason(hasActiveCall: true).isEmpty,
            "Must provide clear reason when preview is disabled in call"
        )
    }
}
