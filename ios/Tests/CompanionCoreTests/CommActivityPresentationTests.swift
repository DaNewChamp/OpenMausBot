import Foundation
import Testing
@testable import CompanionCore

struct CommActivityPresentationTests {
    @Test
    func testOutgoingCommUsesOneNeutralPeerLabel() throws {
        let data = Data(#"{"id":"m1","role":"bot","kind":"activity","at":1,"tool":{"name":"Messaged @CIO"},"comm":{"groupId":"room-1","withBotId":"cio","withName":"CIO","withColor":"blue"}}"#.utf8)
        let message = try JSONDecoder().decode(Message.self, from: data)
        let row = try #require(CommActivityPresentation(message: message))
        #expect(row.peerBotId == "cio")
        #expect(row.title == "Messaged @CIO")
        #expect(row.groupId == "room-1")
        #expect(row.showsRunning == false)
    }

    @Test
    func testOrdinaryToolActivityIsNotACommRow() {
        let data = Data(#"{"id":"m2","role":"bot","kind":"activity","at":1,"tool":{"name":"Read file","ok":true}}"#.utf8)
        let message = try! JSONDecoder().decode(Message.self, from: data)
        #expect(CommActivityPresentation(message: message) == nil)
    }
}
