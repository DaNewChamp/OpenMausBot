import Testing
@testable import CompanionCore

struct HydrationRevisionTests {
    @Test("resumed hello does not advance the authoritative revision")
    func resumedHelloPreservesRevision() {
        var revision = HydrationRevision()
        #expect(revision.record(resumed: true) == 0)
        #expect(revision.value == 0)
    }

    @Test("authoritative hydrates advance the revision")
    func authoritativeHydrateAdvancesRevision() {
        var revision = HydrationRevision()
        #expect(revision.record(resumed: false) == 1)
        #expect(revision.record(resumed: false) == 2)
        #expect(revision.value == 2)
    }
}
