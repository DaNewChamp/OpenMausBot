// The stream-and-speak sentence chunker, decided in one place.
//
// The rules that matter for roleplay replies: the first sentence speaks at
// any length, later ones wait to clear the minimum so nothing plays as a
// clipped fragment, dots that are not sentence ends (decimals,
// abbreviations, initials) do not split, and a stream that ends mid-
// sentence still hands over everything it has.
import XCTest
@testable import CompanionCore

final class VoiceReplyChunkerTests: XCTestCase {
    // MARK: - Sentence boundaries

    func testFirstSentenceSpeaksAtAnyLength() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("Hi! Everything is going fine over here and the reply keeps going and going.")
        XCTAssertEqual(chunks.first, "Hi!")
        XCTAssertEqual(chunks.count, 2, "the long second sentence completes in the same feed")
        XCTAssertNil(chunker.flush(), "nothing left dangling")
    }

    func testLaterShortSentencesWaitAndMergeUpToTheMinimum() {
        var chunker = VoiceReplyChunker()
        XCTAssertEqual(chunker.feed("Yes."), ["Yes."], "the first chunk is exempt from the minimum")
        XCTAssertEqual(chunker.feed(" No. Maybe. Perhaps not."), [], "nothing clears the minimum yet")
        let merged = chunker.feed(" But the next sentence pushes the buffer well past forty characters in total.")
        XCTAssertEqual(merged.count, 1)
        XCTAssertTrue(merged[0].hasPrefix("No."))
        XCTAssertGreaterThanOrEqual(merged[0].count, VoiceReplyChunker.minimumChunkLength)
    }

    func testNewlinesAreBoundaries() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("Line one.\nLine two runs on long enough to clear the minimum chunk length.")
        XCTAssertEqual(chunks.first, "Line one.")
        XCTAssertEqual(chunks.count, 2)
    }

    func testClosingQuotesRideAlongWithTheSentence() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("He leaned in. \"Run!\" she whispered, and the narration continues on for well over forty characters in total.")
        XCTAssertEqual(chunks.first, "He leaned in.")
        XCTAssertEqual(chunks.count, 2)
        XCTAssertTrue(chunks[1].hasPrefix("\"Run!\""), "the closing quote belongs to the sentence before it")
    }

    // MARK: - Dots that are not sentence ends

    func testDecimalNumbersDoNotSplit() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("The pace picks up at 3.14 miles in, and the rest of the reply keeps running well past the minimum length.")
        XCTAssertEqual(chunks.count, 1)
        XCTAssertTrue(chunks[0].contains("3.14"))
    }

    func testAbbreviationsDoNotSplit() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("Mr. Smith arrived early, and the narration keeps going long enough to clear the minimum chunk length.")
        XCTAssertEqual(chunks.count, 1)
        XCTAssertTrue(chunks[0].contains("Mr."))
    }

    func testInitialsDoNotSplit() {
        var chunker = VoiceReplyChunker()
        let chunks = chunker.feed("She met J. K. Rowling yesterday, which the reply then describes at generous length for the orb.")
        XCTAssertEqual(chunks.count, 1)
    }

    // MARK: - The end of the stream

    func testFlushHandsOverTheDanglingPartial() {
        var chunker = VoiceReplyChunker()
        XCTAssertEqual(chunker.feed("and then the reply just stops mid-sent"), [])
        XCTAssertEqual(chunker.flush(), "and then the reply just stops mid-sent")
        XCTAssertNil(chunker.flush(), "the buffer is empty after the flush")
    }

    func testEmptyAndBlankFeedsProduceNothing() {
        var chunker = VoiceReplyChunker()
        XCTAssertEqual(chunker.feed(""), [])
        XCTAssertEqual(chunker.feed("   \n  "), [], "blank stretches are not chunks")
    }

    func testStreamedFeedingMatchesOneShot() {
        let whole = "Hi! The dragon circles once, twice, and lands. Its rider dismounts at 4.5 paces, then Dr. line of the story continues here."
        var streamed = VoiceReplyChunker()
        var chunks: [String] = []
        for piece in stride(from: 0, to: whole.count, by: 12).map({ start in
            String(whole[whole.index(whole.startIndex, offsetBy: start)..<whole.index(whole.startIndex, offsetBy: min(start + 12, whole.count))])
        }) {
            chunks.append(contentsOf: streamed.feed(piece))
        }
        if let tail = streamed.flush() { chunks.append(tail) }

        var oneShot = VoiceReplyChunker()
        var wholeChunks = oneShot.feed(whole)
        if let tail = oneShot.flush() { wholeChunks.append(tail) }
        XCTAssertEqual(chunks, wholeChunks)
    }
}
