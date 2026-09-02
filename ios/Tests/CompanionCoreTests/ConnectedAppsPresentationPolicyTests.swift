import XCTest
@testable import CompanionCore

final class ConnectedAppsPresentationPolicyTests: XCTestCase {
    private func card(_ slug: String, label: String) -> ConnectorCard {
        ConnectorCard(slug: slug, label: label, blurb: "Blurb")
    }

    func testPinsGmailAndGoogleAppsWhenConfiguredButUnconnected() {
        let catalog = ConnectorCatalog(
            configured: true,
            cards: [
                card("slack", label: "Slack"),
                card("gmail", label: "Gmail"),
                card("github", label: "GitHub"),
                card("googlecalendar", label: "Google Calendar"),
            ]
        )
        let statuses: [String: ConnectorStatus] = [
            "slack": ConnectorStatus(connected: true, accounts: []),
            "gmail": ConnectorStatus(connected: false),
            "googlecalendar": ConnectorStatus(connected: false),
        ]

        let ordered = ConnectedAppsPresentationPolicy.orderedCards(
            catalog: catalog,
            statuses: statuses,
            query: ""
        )

        XCTAssertEqual(ordered.map(\.slug), ["gmail", "googlecalendar", "slack", "github"])
    }

    func testDoesNotPinAlreadyConnectedGoogleApps() {
        let catalog = ConnectorCatalog(
            configured: true,
            cards: [
                card("gmail", label: "Gmail"),
                card("slack", label: "Slack"),
                card("googlecalendar", label: "Google Calendar"),
            ]
        )
        let statuses: [String: ConnectorStatus] = [
            "gmail": ConnectorStatus(connected: true, accounts: []),
            "googlecalendar": ConnectorStatus(connected: false),
        ]

        let ordered = ConnectedAppsPresentationPolicy.orderedCards(
            catalog: catalog,
            statuses: statuses,
            query: ""
        )

        XCTAssertEqual(ordered.map(\.slug), ["googlecalendar", "gmail", "slack"])
    }

    func testLeavesCatalogOrderAloneWhenComposioIsNotConfigured() {
        let catalog = ConnectorCatalog(
            configured: false,
            cards: [
                card("gmail", label: "Gmail"),
                card("slack", label: "Slack"),
            ]
        )

        let ordered = ConnectedAppsPresentationPolicy.orderedCards(
            catalog: catalog,
            statuses: [:],
            query: ""
        )

        XCTAssertEqual(ordered.map(\.slug), ["gmail", "slack"])
    }

    func testSearchStillFiltersWithoutReorderingPinnedApps() {
        let catalog = ConnectorCatalog(
            configured: true,
            cards: [
                card("gmail", label: "Gmail"),
                card("slack", label: "Slack"),
            ]
        )

        let ordered = ConnectedAppsPresentationPolicy.orderedCards(
            catalog: catalog,
            statuses: ["gmail": ConnectorStatus(connected: false)],
            query: "slack"
        )

        XCTAssertEqual(ordered.map(\.slug), ["slack"])
    }
}
