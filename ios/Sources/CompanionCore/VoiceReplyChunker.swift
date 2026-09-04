// The stream-and-speak sentence chunker.
//
// Roleplay replies can run long, and speaking them only after the whole
// text has arrived means a long silent wait. This splits the growing reply
// into speakable pieces as it streams: a piece is a complete sentence —
// terminated by ., !, ?, an ellipsis, or a line break, with closing quotes
// and brackets riding along — and the caller queues each piece for speech
// as soon as it completes.
//
// Two guards keep the splits honest. Dots that are not sentence ends do
// not split: decimal numbers (3.14), known abbreviations (Mr., Dr., e.g.),
// and initials (J. K.) are held back and merged into the next sentence.
// And except for the very first piece — the point is to hear the bot start
// fast — a piece stays in the buffer until it clears the minimum length,
// so a clipped "Yes." does not play alone.
//
// Foundation-only, like the rest of CompanionCore.
import Foundation

public struct VoiceReplyChunker: Sendable {
    /// A piece shorter than this waits for the next sentence and goes out
    /// merged with it — except the first piece, which speaks at any length.
    public static let minimumChunkLength = 40

    /// Words whose trailing dot is part of the word, not a sentence end.
    private static let abbreviations: Set<String> = [
        "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "eg", "ie",
    ]
    /// Punctuation that rides along with the sentence before it.
    private static let closers: Set<Character> = ["\"", "'", "”", "’", ")", "]", "}"]
    private static let terminators: Set<Character> = [".", "!", "?", "…", "\n", "\r"]

    private var buffer = ""
    private var hasEmitted = false

    public init() {}

    /// Feeds the next piece of streaming text; returns every chunk that
    /// became speakable, in order.
    public mutating func feed(_ text: String) -> [String] {
        buffer += text
        return takeCompleted()
    }

    /// The stream is over: whatever is left goes out as the final chunk,
    /// complete sentence or not — nothing spoken stays dangling here.
    public mutating func flush() -> String? {
        let remainder = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        return remainder.isEmpty ? nil : remainder
    }

    private mutating func takeCompleted() -> [String] {
        var chunks: [String] = []
        while let boundary = nextBoundary() {
            chunks.append(String(buffer[..<boundary]).trimmingCharacters(in: .whitespacesAndNewlines))
            buffer = String(buffer[boundary...]).trimmingCharacters(in: .whitespacesAndNewlines)
            hasEmitted = true
        }
        return chunks
    }

    /// The end of the next speakable chunk within `buffer`: the first
    /// sentence boundary that may leave — any boundary for the first
    /// chunk, later ones only once the piece clears the minimum, so a
    /// short sentence merges into the next instead of playing alone.
    private func nextBoundary() -> String.Index? {
        var search = buffer.startIndex
        while let end = sentenceEnd(after: search) {
            let piece = String(buffer[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            if piece.isEmpty {
                search = end
                continue
            }
            if !hasEmitted || piece.count >= Self.minimumChunkLength {
                return end
            }
            search = end
        }
        return nil
    }

    /// The first real sentence boundary at or after `from`: a terminator
    /// that is not part of an abbreviation or a decimal number, plus any
    /// closing quotes and brackets that belong to the sentence.
    private func sentenceEnd(after from: String.Index) -> String.Index? {
        var i = from
        while let terminator = buffer[i...].firstIndex(where: { Self.terminators.contains($0) }) {
            let after = buffer.index(after: terminator)
            // A terminator run — "..." or "!?" — ends at its last character.
            if after < buffer.endIndex, Self.terminators.contains(buffer[after]) {
                i = after
                continue
            }
            if isAbbreviationDot(at: terminator) || isDecimalDot(at: terminator) {
                i = after
                continue
            }
            var end = after
            while end < buffer.endIndex, Self.closers.contains(buffer[end]) {
                end = buffer.index(after: end)
            }
            return end
        }
        return nil
    }

    private func isAbbreviationDot(at index: String.Index) -> Bool {
        guard buffer[index] == "." else { return false }
        let word = wordBefore(index).lowercased()
        if Self.abbreviations.contains(word) { return true }
        // A lone letter before the dot is an initial — "J. K. Rowling" is
        // one name, not two sentences.
        return word.count == 1 && word.allSatisfy(\.isLetter)
    }

    private func isDecimalDot(at index: String.Index) -> Bool {
        guard buffer[index] == ".", index > buffer.startIndex else { return false }
        let after = buffer.index(after: index)
        guard after < buffer.endIndex else { return false }
        return buffer[buffer.index(before: index)].isNumber && buffer[after].isNumber
    }

    private func wordBefore(_ index: String.Index) -> Substring {
        var start = index
        while start > buffer.startIndex {
            let previous = buffer.index(before: start)
            guard buffer[previous].isLetter else { break }
            start = previous
        }
        return buffer[start..<index]
    }
}
