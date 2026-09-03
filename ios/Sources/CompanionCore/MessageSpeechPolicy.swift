// Per-message read-aloud planning.
//
// The desktop's speaker (src/lib/tts) treats `/api/tts/prepare` as the one
// authoritative answer to "can this message be spoken, and in what pieces".
// The phone keeps that contract: readiness is never guessed from local
// config, because the workspace default voice and the shared key both live
// on the paired computer.
public enum MessageSpeechPolicy {
    public enum Plan: Equatable, Sendable {
        case speak(utterances: [String])
        case notReady
    }

    /// Shown when the harness says the message cannot be spoken. Points at
    /// the computer, because that is where the fix lives — the key and the
    /// voice choice never exist on the phone.
    public static let notReadyMessage =
        "Add the shared voice key and pick a voice for this agent on your computer to read messages aloud."

    /// A prepared answer decides the whole run. Empty utterances for a
    /// non-empty message fall back to the whole text so a harness that never
    /// splits cannot strand it; an empty message simply has nothing to say.
    public static func plan(preparation: TtsPreparation, text: String) -> Plan {
        guard preparation.ready == true else { return .notReady }
        let utterances = preparation.utterances ?? []
        if !utterances.isEmpty {
            return .speak(utterances: utterances)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return .speak(utterances: trimmed.isEmpty ? [] : [trimmed])
    }
}
