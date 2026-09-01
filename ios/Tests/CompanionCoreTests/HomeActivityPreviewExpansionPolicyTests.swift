import Foundation
import Testing
@testable import CompanionCore

struct HomeActivityPreviewExpansionPolicyTests {
    @Test
    func regularExpandedPanelHugsRowsInsteadOfMaxingOut() {
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: false,
            itemCount: 1,
            sectionCount: 1
        ) == 88)
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: false,
            itemCount: 2,
            sectionCount: 2
        ) == 152)
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: false,
            itemCount: 1,
            sectionCount: 1
        ) < 320)
    }

    @Test
    func accessibilityExpandedPanelKeepsScrollableBudget() {
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: true,
            itemCount: 1,
            sectionCount: 1,
            hasNeedsYou: true
        ) == 400)
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: true,
            itemCount: 1,
            sectionCount: 1
        ) == 260)
    }

    @Test
    func emptyExpandedPanelReservesNoHeight() {
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: false,
            itemCount: 0,
            sectionCount: 0
        ) == 0)
    }

    @Test
    func previewExpansionWaitsForActivityItemsToArrive() throws {
        let arguments = ["-store-preview", "-preview-expand-activity"]
        let empty = HomeActivityPresentation(state: CompanionState())

        #expect(!HomeActivityPreviewExpansionPolicy.shouldAutoExpand(
            arguments: arguments,
            presentation: empty,
            isExpanded: false
        ))

        var state = try fixtureState()
        _ = try #require(state.bots.first)
        state.bots[0].busy = true
        state.bots[0].activity = "working"
        let populated = HomeActivityPresentation(state: state)

        #expect(!populated.items.isEmpty)
        #expect(HomeActivityPreviewExpansionPolicy.shouldAutoExpand(
            arguments: arguments,
            presentation: populated,
            isExpanded: false
        ))
    }

    @Test
    func normalLaunchAndAlreadyExpandedPreviewDoNotRequestExpansion() throws {
        let presentation = HomeActivityPresentation(state: try fixtureState())

        #expect(!HomeActivityPreviewExpansionPolicy.shouldAutoExpand(
            arguments: ["-store-preview"],
            presentation: presentation,
            isExpanded: false
        ))
        #expect(!HomeActivityPreviewExpansionPolicy.shouldAutoExpand(
            arguments: ["-store-preview", "-preview-expand-activity"],
            presentation: presentation,
            isExpanded: true
        ))
    }

    @Test
    func accessibilityExpansionReservesReadablePanelHeightOnlyWhenExpanded() {
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelMinHeight(
            isAccessibilitySize: true,
            isExpanded: true
        ) == 400)
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelMinHeight(
            isAccessibilitySize: true,
            isExpanded: false
        ) == 0)
        #expect(HomeActivityPreviewExpansionPolicy.expandedPanelMinHeight(
            isAccessibilitySize: false,
            isExpanded: true
        ) == 0)
    }

    private func fixtureState() throws -> CompanionState {
        let url = try #require(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url))
        var state = CompanionState()
        state.hydrate(fleet)
        return state
    }
}
