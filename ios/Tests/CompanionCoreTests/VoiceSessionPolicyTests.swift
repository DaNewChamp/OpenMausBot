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

    // MARK: - Stream-and-speak

    func testFirstStreamedSentenceStartsSpeakingBeforeTheRunSettles() {
        XCTAssertEqual(decide(.thinking, .streamStarted), .speakStreamReply)
    }

    func testStreamStartMeansNothingOnceTheTurnIsAlreadyMoving() {
        XCTAssertEqual(decide(.speaking, .streamStarted), .stay)
        XCTAssertEqual(decide(.listening, .streamStarted), .stay)
        XCTAssertEqual(decide(.idle, .streamStarted), .stay)
    }

    func testDrainedStreamEndsTheSpeakingTurnLikeAPlayedClip() {
        XCTAssertEqual(decide(.speaking, .replySpoken), .listen)
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

    // MARK: - Stream-and-speak utterance queue

    func testDrainNeedsBothTheStreamEndAndAnEmptyQueue() {
        var queue = VoiceUtteranceQueue()
        XCTAssertFalse(queue.isDrained, "the stream is still open")
        queue.enqueue()
        queue.finishStream()
        XCTAssertFalse(queue.isDrained, "one utterance is still queued or speaking")
        queue.utteranceFinished()
        XCTAssertTrue(queue.isDrained)
    }

    func testDrainWithNothingQueuedHappensTheMomentTheStreamCloses() {
        var queue = VoiceUtteranceQueue()
        queue.finishStream()
        XCTAssertTrue(queue.isDrained)
    }

    func testUtteranceFinishedFloorsAtZero() {
        var queue = VoiceUtteranceQueue()
        queue.utteranceFinished()
        queue.utteranceFinished()
        queue.finishStream()
        XCTAssertTrue(queue.isDrained)
    }

    func testStopDropsTheQueueAndRetiresTheGeneration() {
        var queue = VoiceUtteranceQueue()
        let generation = queue.generation
        queue.enqueue()
        queue.enqueue()
        queue.finishStream()
        queue.stop()
        XCTAssertFalse(queue.isDrained, "a stopped stream never reports a clean drain")
        XCTAssertEqual(queue.pending, 0, "everything queued was dropped")
        XCTAssertFalse(queue.isActive(generation), "the old generation may not speak again")
        XCTAssertTrue(queue.isActive(queue.generation))
    }

    func testSentencesEnqueuedAroundABargeInCarryAStaleToken() {
        var queue = VoiceUtteranceQueue()
        let generation = queue.generation
        queue.enqueue()

        queue.stop()
        let next = queue.generation
        queue.enqueue()

        XCTAssertFalse(queue.isActive(generation))
        XCTAssertTrue(queue.isActive(next))
        XCTAssertEqual(queue.pending, 1, "only the new stream's utterance counts")
    }

    // MARK: - Mic level math for the orb

    func testRmsOfFloatSamplesMatchesTheRootMeanSquare() {
        XCTAssertEqual(VoiceSessionPolicy.rms(of: []), 0)
        XCTAssertEqual(VoiceSessionPolicy.rms(of: [0, 0, 0]), 0)
        XCTAssertEqual(VoiceSessionPolicy.rms(of: [1, -1, 1, -1]), 1, accuracy: 0.0001)
        let mixed = VoiceSessionPolicy.rms(of: [0.1, -0.2, 0.1, -0.2])
        XCTAssertEqual(mixed, sqrt(0.025), accuracy: 0.0001)
    }

    func testRmsOfInt16DoesNotTreatIntegerPcmAsSilence() {
        XCTAssertEqual(VoiceSessionPolicy.rms(ofInt16: []), 0)
        // Full-scale Int16 must not collapse to 0 the way a nil float
        // channel would — that was the frozen-orb failure on integer taps.
        let full = VoiceSessionPolicy.rms(ofInt16: [Int16.max, Int16.min, Int16.max, Int16.min])
        XCTAssertGreaterThan(full, 0.9)
        let quiet = VoiceSessionPolicy.rms(ofInt16: [300, -300, 300, -300])
        XCTAssertGreaterThan(quiet, 0.005)
        XCTAssertLessThan(quiet, 0.02)
    }

    func testNormalizedMicLevelTurnsSpeechRmsIntoAVisibleOrb() {
        XCTAssertEqual(VoiceSessionPolicy.normalizedMicLevel(rms: 0), 0, accuracy: 0.001)
        XCTAssertEqual(VoiceSessionPolicy.normalizedMicLevel(rms: 0.001), 0, accuracy: 0.001)
        let speech = VoiceSessionPolicy.normalizedMicLevel(rms: 0.05)
        XCTAssertGreaterThan(speech, 0.5, "hand-held speech must swell the orb, not sit at a 2% scale tick")
        XCTAssertLessThan(speech, 1)
        let loud = VoiceSessionPolicy.normalizedMicLevel(rms: 0.4)
        XCTAssertGreaterThanOrEqual(loud, 0.95)
        let atThreshold = VoiceSessionPolicy.normalizedMicLevel(rms: VoiceSessionPolicy.voiceThreshold)
        XCTAssertGreaterThan(atThreshold, 0.2)
    }
}
