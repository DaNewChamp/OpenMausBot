import Foundation
import Testing
@testable import CompanionCore

struct ComposerActionPolicyTests {
    @Test("busy and empty shows stop")
    func busyEmptyShowsStop() {
        #expect(ComposerActionPolicy.action(busy: true, draft: "", defaultMode: .steer) == .stop)
        #expect(ComposerActionPolicy.action(busy: true, draft: "  \n", defaultMode: .queue) == .stop)
    }

    @Test("busy send honors the configured default")
    func busySendHonorsDefault() {
        #expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .steer) == .send(.steer))
        #expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .queue) == .send(.queue))
    }

    @Test("idle send keeps automatic delivery")
    func idleSendUsesAuto() {
        #expect(ComposerActionPolicy.action(busy: false, draft: "next", defaultMode: .queue) == .send(.auto))
        #expect(ComposerActionPolicy.action(busy: false, draft: "", defaultMode: .steer) == .none)
    }

    @Test("unknown preference values fall back to steer")
    func unknownDefaultIsSafe() {
        #expect(BusySendDefault(rawValue: "future-mode") == .steer)
        let decoded = try? JSONDecoder().decode(
            BusySendDefault.self,
            from: Data(#""future-mode""#.utf8)
        )
        #expect(decoded == .steer)
    }

    @Test("reconstructed capabilities hide queue and unbound stop")
    func reconstructedCapabilities() {
        let reconstructed = EngineComposerCapabilities(queueing: false, steer: true, stop: false)
        #expect(
            ComposerActionPolicy.action(busy: true, draft: "", defaultMode: .steer, capabilities: reconstructed)
                == .none
        )
        #expect(
            ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .queue, capabilities: reconstructed)
                == .send(.steer)
        )
        #expect(
            ComposerActionPolicy.deliveryMode(defaultMode: .queue, capabilities: reconstructed) == .steer
        )
    }

    @Test("request gate blocks duplicate work until released")
    func requestGate() {
        var gate = ComposerRequestGate()
        let first = gate.begin()
        let second = gate.begin()
        #expect(first)
        #expect(!second)
        #expect(gate.isInFlight)
        gate.end()
        #expect(!gate.isInFlight)
        let third = gate.begin()
        #expect(third)
    }
}
