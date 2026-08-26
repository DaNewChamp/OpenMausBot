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

    @Test
    func testMissingRoomRemainsInformativeWithoutNavigationDestination() throws {
        let data = Data(#"{"id":"m3","role":"bot","kind":"activity","at":1,"comm":{"groupId":"deleted-room","withBotId":"risk","withName":"Risk","withColor":"red"}}"#.utf8)
        let message = try JSONDecoder().decode(Message.self, from: data)
        let row = try #require(CommActivityPresentation(message: message, destinationAvailable: false))
        #expect(row.title == "Messaged @Risk")
        #expect(row.destinationAvailable == false)
    }

    @Test
    func testSuppressesExactProviderNarrationBesideCommActivity() throws {
        let data = Data(#"""
        [
          {"id":"activity","role":"bot","kind":"activity","at":1,"tool":{"name":"Messaged @CIO"},"comm":{"groupId":"room-1","withBotId":"cio","withName":"CIO","withColor":"blue"}},
          {"id":"narration","role":"bot","kind":"text","at":2,"parentId":"activity","text":"Messaged CIO"}
        ]
        """#.utf8)
        let transcript = try JSONDecoder().decode([Message].self, from: data)
        #expect(CommActivityPresentation.shouldSuppressNarration(transcript[1], in: transcript, at: 1))
    }

    @Test
    func testKeepsSubstantiveNarrationAndRoomMessages() throws {
        let data = Data(#"""
        [
          {"id":"activity","role":"bot","kind":"activity","at":1,"tool":{"name":"Messaged @CIO"},"comm":{"groupId":"room-1","withBotId":"cio","withName":"CIO","withColor":"blue"}},
          {"id":"substantive","role":"bot","kind":"text","at":2,"parentId":"activity","text":"Messaged CIO that the report is ready"},
          {"id":"room","role":"bot","kind":"text","at":3,"from":{"botId":"chief","name":"Chief","color":"orange"},"text":"Messaged CIO"},
          {"id":"failed-activity","role":"bot","kind":"activity","at":4,"tool":{"name":"Messaged @CIO","ok":false},"comm":{"groupId":"room-2","withBotId":"cio","withName":"CIO","withColor":"blue"}},
          {"id":"failure-detail","role":"bot","kind":"text","at":5,"parentId":"failed-activity","text":"Messaged CIO"}
        ]
        """#.utf8)
        let transcript = try JSONDecoder().decode([Message].self, from: data)
        #expect(!CommActivityPresentation.shouldSuppressNarration(transcript[1], in: transcript, at: 1))
        #expect(!CommActivityPresentation.shouldSuppressNarration(transcript[2], in: transcript, at: 2))
        #expect(!CommActivityPresentation.shouldSuppressNarration(transcript[4], in: transcript, at: 4))
    }
}
