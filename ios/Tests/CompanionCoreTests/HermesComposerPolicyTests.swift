import Testing
@testable import CompanionCore

@Suite("Hermes composer policy")
struct HermesComposerPolicyTests {
    @Test("Hermes-bound composer keeps stop and refuses steer")
    func hermesBoundComposer() {
        let caps = EngineComposerCapabilities(queueing: false, steer: false, stop: true)
        #expect(ComposerActionPolicy.action(busy: true, draft: "", defaultMode: .steer, capabilities: caps) == .stop)
        #expect(ComposerActionPolicy.action(busy: true, draft: "next", defaultMode: .steer, capabilities: caps) == .send(.auto))
        #expect(ComposerActionPolicy.deliveryMode(defaultMode: .steer, capabilities: caps) == .auto)
    }
}
