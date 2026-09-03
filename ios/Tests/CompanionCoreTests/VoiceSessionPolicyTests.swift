// Live voice mode's loop, decided in one place.
//
// The walkie-talkie cycle — listen, send, think, speak, listen — plus the
// ways a real session leaves it: barge-in, a send that failed, a reply with
// nothing speakable, the mute that skips the speaking state, and the close
// that works from anywhere.
import XCTest
@testable import CompanionCore

final class VoiceSessionPolicyTests: XCTestCase {
    private func decide(_ phase: VoiceSessionPhase, _ event: VoiceSessionEvent) -> VoiceSessionDecision {
        VoiceSessionPolicy.decide(phase: phase, event: event)
    }

    // MARK: - The happy loop

    func testIdleWakesOnMicReady() {
        XCTAssertEqual(decide(.idle, .micReady), .listen)
    }

    func testHeardSpeechSendsTheTranscript() {
        XCTAssertEqual(decide(.listening, .micStopped(hasTranscript: true)), .sendTranscript)
    }

    func testSilenceWithNothingHeardSitsBackDownAtIdle() {
        XCTAssertEqual(decide(.listening, .micStopped(hasTranscript: false)), .idle)
    }

    func testSettledReplyIsSpokenThenTheLoopResumes() {
        XCTAssertEqual(decide(.thinking, .replySettled(hasReply: true, shouldSpeak: true)), .speakReply)
        XCTAssertEqual(decide(.speaking, .replySpoken), .listen)
    }

    func testMuteSkipsTheSpeakingState() {
        XCTAssertEqual(decide(.thinking, .replySettled(hasReply: true, shouldSpeak: false)), .listen)
    }

    func testReplyWithNothingSpeakableGoesStraightBackToListening() {
        XCTAssertEqual(decide(.thinking, .replySettled(hasReply: false, shouldSpeak: true)), .listen)
        XCTAssertEqual(decide(.thinking, .replySettled(hasReply: false, shouldSpeak: false)), .listen)
    }

    // MARK: - Interrupting a turn

    func testBargeInReturnsToListeningFromThinkingAndSpeaking() {
        XCTAssertEqual(decide(.thinking, .bargeIn), .listen)
        XCTAssertEqual(decide(.speaking, .bargeIn), .listen)
    }

    func testBargeInMeansNothingWhenAlreadyWaitingOnTheUser() {
        XCTAssertEqual(decide(.idle, .bargeIn), .stay)
        XCTAssertEqual(decide(.listening, .bargeIn), .stay)
    }

    func testSendFailedSitsBackDownAtIdle() {
        XCTAssertEqual(decide(.thinking, .sendFailed), .idle)
    }

    // MARK: - Close works from every phase

    func testClosedTearsDownFromEveryPhase() {
        for phase in [VoiceSessionPhase.idle, .listening, .thinking, .speaking] {
            XCTAssertEqual(decide(phase, .closed), .stopAll, "close from \(phase) must stop everything")
        }
    }

    // MARK: - Events out of place are inert

    func testStrayEventsStayPut() {
        XCTAssertEqual(decide(.idle, .replySpoken), .stay)
        XCTAssertEqual(decide(.speaking, .replySettled(hasReply: true, shouldSpeak: true)), .stay)
        XCTAssertEqual(decide(.listening, .micReady), .stay)
        XCTAssertEqual(decide(.listening, .sendFailed), .stay)
        XCTAssertEqual(decide(.idle, .micStopped(hasTranscript: true)), .stay)
    }

    // MARK: - Silence gate

    private func gate(_ limit: TimeInterval = 2.5) -> VoiceSilenceGate {
        VoiceSilenceGate(limit: limit, now: Date(timeIntervalSince1970: 1000))
    }

    func testQuietFromTheStartFinalizesAfterTheLimit() {
        var gate = gate()
        XCTAssertFalse(gate.observe(level: 0.0, at: Date(timeIntervalSince1970: 1001)))
        XCTAssertFalse(gate.observe(level: 0.001, at: Date(timeIntervalSince1970: 1002.4)))
        XCTAssertTrue(gate.observe(level: 0.0, at: Date(timeIntervalSince1970: 1002.5)))
        XCTAssertFalse(gate.heardVoice)
    }

    func testVoiceReArmsTheWindow() {
        var gate = gate()
        XCTAssertTrue(gate.observe(level: 0, at: Date(timeIntervalSince1970: 1002.5)))
        // One voiced frame resets the anchor, buying a fresh window.
        XCTAssertFalse(gate.observe(level: 0.1, at: Date(timeIntervalSince1970: 1002.6)))
        XCTAssertFalse(gate.observe(level: 0.0, at: Date(timeIntervalSince1970: 1004.9)))
        XCTAssertTrue(gate.observe(level: 0.0, at: Date(timeIntervalSince1970: 1005.1)))
        XCTAssertTrue(gate.heardVoice)
    }

    func testLevelsBelowTheThresholdNeverCountAsVoice() {
        var gate = gate()
        XCTAssertFalse(gate.observe(level: VoiceSessionPolicy.voiceThreshold - 0.001, at: Date(timeIntervalSince1970: 1001)))
        XCTAssertFalse(gate.observe(level: 0, at: Date(timeIntervalSince1970: 1002.4)))
        XCTAssertTrue(gate.observe(level: 0, at: Date(timeIntervalSince1970: 1002.5)))
        XCTAssertFalse(gate.heardVoice)
    }

    func testAThresholdLevelCountsAsVoiceImmediately() {
        var gate = gate()
        XCTAssertFalse(gate.observe(level: VoiceSessionPolicy.voiceThreshold, at: Date(timeIntervalSince1970: 1001)))
        XCTAssertTrue(gate.heardVoice)
    }

    // MARK: - Island copy

    func testIslandCopyCoversEveryPhase() {
        XCTAssertEqual(VoiceSessionPolicy.islandLine(for: .idle), "Tap the orb to talk")
        XCTAssertEqual(VoiceSessionPolicy.islandLine(for: .listening), "Listening…")
        XCTAssertEqual(VoiceSessionPolicy.islandLine(for: .thinking), "Thinking…")
        XCTAssertEqual(VoiceSessionPolicy.islandLine(for: .speaking), "Speaking…")
        XCTAssertEqual(VoiceSessionPolicy.islandHeadline(name: "Scout", phase: .listening), "Scout is listening")
    }
}
