// Voice-output engine selection: the stored preference, the endpoint the
// custom engine calls, and the level math the orb animates from.
//
// The AVAudio engines themselves are app-target (no simulator here); these
// are the parts that decide, so they live where the rest of the decisions
// are tested.
import XCTest
@testable import CompanionCore

final class VoiceOutputSettingsTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "VoiceOutputSettingsTests")
        defaults.removePersistentDomain(forName: "VoiceOutputSettingsTests")
    }

    // MARK: - Engine selection

    func testDefaultEngineIsOnDevice() {
        XCTAssertEqual(VoiceOutputSettings.load(defaults: defaults).engine, .onDevice)
    }

    func testUnknownStoredEngineFallsBackToOnDevice() {
        defaults.set("elevenlabs", forKey: VoiceOutputSettings.engineKey)
        XCTAssertEqual(VoiceOutputSettings.load(defaults: defaults).engine, .onDevice)
    }

    func testSaveAndLoadRoundTripKeepsEveryField() {
        var settings = VoiceOutputSettings()
        settings.engine = .customEndpoint
        settings.customBaseURL = "https://tts.example.com"
        settings.customAPIKey = "sk-test"
        settings.customModel = "tts-2"
        settings.customVoice = "verse"
        settings.save(defaults: defaults)
        XCTAssertEqual(VoiceOutputSettings.load(defaults: defaults), settings)
    }

    func testBlankCustomModelAndVoiceFallBackToDefaults() {
        defaults.set("", forKey: VoiceOutputSettings.customModelKey)
        defaults.set("   ", forKey: VoiceOutputSettings.customVoiceKey)
        let settings = VoiceOutputSettings.load(defaults: defaults)
        XCTAssertEqual(settings.customModel, VoiceOutputSettings.customModelDefault)
        XCTAssertEqual(settings.customVoice, VoiceOutputSettings.customVoiceDefault)
    }

    func testCustomEndpointNeedsABaseURL() {
        XCTAssertFalse(VoiceOutputSettings().customEndpointConfigured)
        var settings = VoiceOutputSettings()
        settings.customBaseURL = "  https://tts.example.com  "
        XCTAssertTrue(settings.customEndpointConfigured)
    }

    // MARK: - The custom endpoint's URL

    func testBareBaseGetsTheFullPathAppended() throws {
        let url = try XCTUnwrap(TtsEndpointPolicy.endpointURL(fromBase: "https://tts.example.com"))
        XCTAssertEqual(url.absoluteString, "https://tts.example.com/v1/audio/speech")
    }

    func testTrailingSlashDoesNotDoubleThePath() throws {
        let url = try XCTUnwrap(TtsEndpointPolicy.endpointURL(fromBase: "https://tts.example.com/"))
        XCTAssertEqual(url.absoluteString, "https://tts.example.com/v1/audio/speech")
    }

    func testBaseAlreadyEndingInV1OnlyNeedsTheAudioPath() throws {
        let url = try XCTUnwrap(TtsEndpointPolicy.endpointURL(fromBase: "https://tts.example.com/v1"))
        XCTAssertEqual(url.absoluteString, "https://tts.example.com/v1/audio/speech")
    }

    func testFullPathIsTakenAsIs() throws {
        let url = try XCTUnwrap(TtsEndpointPolicy.endpointURL(fromBase: "https://tts.example.com/v1/Audio/Speech"))
        XCTAssertEqual(url.absoluteString, "https://tts.example.com/v1/Audio/Speech")
    }

    func testRejectsEmptyAndNonHTTPBases() {
        XCTAssertNil(TtsEndpointPolicy.endpointURL(fromBase: ""))
        XCTAssertNil(TtsEndpointPolicy.endpointURL(fromBase: "   "))
        XCTAssertNil(TtsEndpointPolicy.endpointURL(fromBase: "ftp://tts.example.com"))
        XCTAssertNil(TtsEndpointPolicy.endpointURL(fromBase: "not a url"))
    }

    // MARK: - The custom endpoint's request

    func testRequestBodyCarriesModelInputAndVoice() throws {
        let data = TtsEndpointPolicy.requestBody(text: "Hello", model: "tts-1", voice: "alloy")
        let request = try XCTUnwrap(JSONDecoder().decode(TtsEndpointPolicy.SpeechRequest.self, from: data))
        XCTAssertEqual(request, TtsEndpointPolicy.SpeechRequest(model: "tts-1", input: "Hello", voice: "alloy"))
    }

    func testBlankAPIKeyOmitsTheAuthorizationHeader() {
        XCTAssertNil(TtsEndpointPolicy.authorizationHeader(apiKey: ""))
        XCTAssertNil(TtsEndpointPolicy.authorizationHeader(apiKey: "  "))
        XCTAssertEqual(TtsEndpointPolicy.authorizationHeader(apiKey: "sk-test"), "Bearer sk-test")
    }

    // MARK: - Level math for the orb

    func testFollowerAttacksFastAndReleasesSlow() {
        var follower = LevelFollower()
        var value: Float = 0
        for _ in 0..<5 { value = follower.observe(0.5) }
        XCTAssertGreaterThan(value, 0.45, "speech should swell within a few frames")
        var lowFollower = LevelFollower()
        _ = lowFollower.observe(0.5)
        var dropped: Float = 0
        for _ in 0..<5 { dropped = lowFollower.observe(0) }
        XCTAssertLessThan(dropped, 0.3, "silence should ease down, not snap")
        XCTAssertGreaterThan(dropped, 0.05, "…but not stick open")
    }

    func testFollowerClampsAndResets() {
        var follower = LevelFollower()
        _ = follower.observe(9)
        XCTAssertLessThanOrEqual(follower.value, 1)
        _ = follower.observe(-3)
        XCTAssertGreaterThanOrEqual(follower.value, 0)
        follower.reset()
        XCTAssertEqual(follower.value, 0)
    }

    func testEnvelopeBumpsThenDecaysTowardZero() throws {
        var envelope = AmplitudeEnvelope(halfLife: 0.09)
        XCTAssertEqual(envelope.decayed(), 0, "no bump, no level")
        let start = Date(timeIntervalSince1970: 1_000)
        envelope.bump(to: 0.8, at: start)
        XCTAssertEqual(envelope.decayed(at: start), 0.8, accuracy: 0.001)
        let half = start.addingTimeInterval(0.09)
        XCTAssertEqual(envelope.decayed(at: half), 0.4, accuracy: 0.02, "one half-life halves the level")
        XCTAssertLessThan(envelope.decayed(at: start.addingTimeInterval(0.5)), 0.05)
        envelope.reset()
        XCTAssertEqual(envelope.decayed(at: start.addingTimeInterval(1)), 0)
    }

    func testEnvelopeClampsAndGuardsBackwardsTime() {
        var envelope = AmplitudeEnvelope()
        let start = Date(timeIntervalSince1970: 2_000)
        envelope.bump(to: 5, at: start)
        XCTAssertEqual(envelope.peak, 1)
        envelope.bump(to: 0.6, at: start.addingTimeInterval(0.2))
        XCTAssertEqual(envelope.decayed(at: start), 0.6, "a clock running backwards holds the last bump")
    }
}

final class TtsEngineSelectionTests: XCTestCase {
    func testEveryEngineHasUserFacingCopy() {
        for engine in VoiceOutputEngine.allCases {
            XCTAssertFalse(engine.label.isEmpty)
            XCTAssertFalse(engine.caption.isEmpty)
        }
        XCTAssertEqual(VoiceOutputEngine.allCases.count, 3)
    }
}

final class CallVoicePreferenceTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "CallVoicePreferenceTests")
        defaults.removePersistentDomain(forName: "CallVoicePreferenceTests")
    }

    func testStorageKeyIsNamespacedByBotIdAndRejectsBlankIds() {
        XCTAssertEqual(
            CallVoicePreferenceStore.storageKey(botId: "bot-scout"),
            "companion.prefs.callVoice.bot-scout"
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.storageKey(botId: "  bot-scout  "),
            "companion.prefs.callVoice.bot-scout"
        )
        XCTAssertNil(CallVoicePreferenceStore.storageKey(botId: ""))
        XCTAssertNil(CallVoicePreferenceStore.storageKey(botId: "   "))
    }

    func testTwoBotsDoNotShareACallVoice() {
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "com.apple.voice.compact.en-US.Samantha", customVoiceOverride: "verse"),
            botId: "bot-a",
            defaults: defaults
        )
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "com.apple.voice.compact.en-GB.Daniel", customVoiceOverride: "alloy"),
            botId: "bot-b",
            defaults: defaults
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.load(botId: "bot-a", defaults: defaults).onDeviceVoiceIdentifier,
            "com.apple.voice.compact.en-US.Samantha"
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.load(botId: "bot-b", defaults: defaults).onDeviceVoiceIdentifier,
            "com.apple.voice.compact.en-GB.Daniel"
        )
        XCTAssertEqual(CallVoicePreferenceStore.load(botId: "bot-a", defaults: defaults).customVoiceOverride, "verse")
        XCTAssertEqual(CallVoicePreferenceStore.load(botId: "missing", defaults: defaults), CallVoicePreference())
    }

    func testBlankBotIdDoesNotWriteAndDoesNotReadSecrets() {
        var settings = VoiceOutputSettings()
        settings.customAPIKey = "sk-secret"
        settings.save(defaults: defaults)
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "should-not-land", customVoiceOverride: "nope"),
            botId: "",
            defaults: defaults
        )
        XCTAssertEqual(VoiceOutputSettings.load(defaults: defaults).customAPIKey, "sk-secret")
        XCTAssertEqual(CallVoicePreferenceStore.load(botId: "", defaults: defaults), CallVoicePreference())
        let callVoiceKeys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("companion.prefs.callVoice.") }
        XCTAssertTrue(callVoiceKeys.isEmpty, "a blank bot id must not create a call-voice key")
        XCTAssertFalse(
            callVoiceKeys.contains { $0.contains("sk-secret") },
            "call-voice storage must not leak the custom TTS key into its keys"
        )
    }

    func testHubEngineKeepsTheServerBotVoice() {
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "com.apple.voice.compact.en-US.Samantha", customVoiceOverride: "verse"),
            botId: "bot-a",
            defaults: defaults
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.resolvedVoice(
                botId: "bot-a",
                engine: .hub,
                serverBotVoice: "hub-voice-1",
                globalCustomVoice: "alloy",
                defaults: defaults
            ),
            "hub-voice-1"
        )
    }

    func testOnDeviceEngineUsesThePerBotIdentifier() {
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "com.apple.voice.compact.en-US.Samantha"),
            botId: "bot-a",
            defaults: defaults
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.resolvedVoice(
                botId: "bot-a",
                engine: .onDevice,
                serverBotVoice: "hub-voice-1",
                globalCustomVoice: "alloy",
                defaults: defaults
            ),
            "com.apple.voice.compact.en-US.Samantha"
        )
        XCTAssertNil(
            CallVoicePreferenceStore.resolvedVoice(
                botId: "bot-b",
                engine: .onDevice,
                serverBotVoice: "hub-voice-1",
                globalCustomVoice: "alloy",
                defaults: defaults
            )
        )
    }

    func testCustomEngineOverrideWinsThenFallsBackToGlobalVoice() {
        CallVoicePreferenceStore.save(
            CallVoicePreference(customVoiceOverride: "verse"),
            botId: "bot-a",
            defaults: defaults
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.resolvedVoice(
                botId: "bot-a",
                engine: .customEndpoint,
                serverBotVoice: "hub-voice-1",
                globalCustomVoice: "alloy",
                defaults: defaults
            ),
            "verse"
        )
        XCTAssertEqual(
            CallVoicePreferenceStore.resolvedVoice(
                botId: "bot-b",
                engine: .customEndpoint,
                serverBotVoice: "hub-voice-1",
                globalCustomVoice: "alloy",
                defaults: defaults
            ),
            "alloy"
        )
    }

    func testCallVoiceStoreNeverWritesTheCustomAPIKey() {
        CallVoicePreferenceStore.save(
            CallVoicePreference(onDeviceVoiceIdentifier: "samantha", customVoiceOverride: "verse"),
            botId: "bot-a",
            defaults: defaults
        )
        XCTAssertNil(defaults.string(forKey: VoiceOutputSettings.customAPIKeyKey))
        let stored = defaults.object(forKey: CallVoicePreferenceStore.storageKey(botId: "bot-a") ?? "")
        if let data = stored as? Data, let json = String(data: data, encoding: .utf8) {
            XCTAssertFalse(json.contains("ttsCustomAPIKey"))
            XCTAssertFalse(json.lowercased().contains("apiKey".lowercased()))
        }
    }
}
