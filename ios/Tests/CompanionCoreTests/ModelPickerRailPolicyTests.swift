import XCTest
@testable import CompanionCore

final class ModelPickerRailPolicyTests: XCTestCase {
    func testOrphanRailShowsOwnModelDisabledAndDoesNotRewriteOnModelTap() {
        let advertised = [Self.instance(id: "plain", models: ["plain-1"])]
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")

        XCTAssertFalse(ModelPickerRailPolicy.isEmpty(advertised: advertised, selection: selection))
        XCTAssertEqual(
            ModelPickerRailPolicy.displayInstances(advertised: advertised, selection: selection).map(\.instanceId),
            ["plain", "retired"]
        )

        let rail = ModelPickerRailPolicy.resolvedRail(
            advertised: advertised,
            selection: selection,
            activeRailId: nil
        )
        XCTAssertEqual(rail?.instanceId, "retired")
        XCTAssertEqual(rail?.models.options.map(\.id), ["retired-1"])
        XCTAssertTrue(
            ModelPickerRailPolicy.modelsDisabled(
                advertised: advertised,
                selection: selection,
                activeRailId: nil,
                hostWideEngine: false
            )
        )

        XCTAssertNil(
            ModelPickerRailPolicy.selectionAfterModelTap(
                current: selection,
                rail: rail,
                modelId: "retired-1"
            )
        )
        XCTAssertNil(
            ModelPickerRailPolicy.selectionAfterModelTap(
                current: selection,
                rail: advertised[0],
                modelId: "plain-1"
            )
        )

        let switched = ModelPickerRailPolicy.selectionAfterEngineTap(
            current: selection,
            tapped: advertised[0],
            advertised: advertised
        )
        XCTAssertEqual(switched?.instanceId, "plain")
        XCTAssertEqual(switched?.model, "plain-1")
    }

    func testEmptyAdvertisedCatalogStillShowsPersistedOrphan() {
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")
        XCTAssertTrue(AdvertisedModelCatalog.isEmpty([]))
        XCTAssertFalse(ModelPickerRailPolicy.isEmpty(advertised: [], selection: selection))

        let rail = ModelPickerRailPolicy.resolvedRail(
            advertised: [],
            selection: selection,
            activeRailId: nil
        )
        XCTAssertEqual(rail?.instanceId, "retired")
        XCTAssertEqual(rail?.models.options.map(\.id), ["retired-1"])
        XCTAssertTrue(
            ModelPickerRailPolicy.modelsDisabled(
                advertised: [],
                selection: selection,
                activeRailId: nil,
                hostWideEngine: false
            )
        )
    }

    func testPickedInstanceComesFromDisplayCatalogNotAdvertisedFallback() {
        let advertised = [Self.instance(id: "plain", models: ["plain-1"])]
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")
        let picked = ModelPickerRailPolicy.resolvedRail(
            advertised: advertised,
            selection: selection,
            activeRailId: selection.instanceId
        )
        XCTAssertEqual(picked?.instanceId, "retired")
        XCTAssertTrue(ModelSelectionPolicy.modelsDisabled(for: picked, hostWideEngine: false))
        XCTAssertFalse(ModelSelectionPolicy.modelsDisabled(for: nil, hostWideEngine: false))
    }

    func testEngineTapOnSelectedOrphanDoesNotRewriteInstance() {
        let advertised = [Self.instance(id: "plain", models: ["plain-1"])]
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")
        let orphan = AdvertisedModelCatalog.orphanInstance(selection: selection)
        let next = ModelPickerRailPolicy.selectionAfterEngineTap(
            current: selection,
            tapped: orphan,
            advertised: advertised
        )
        XCTAssertEqual(next, selection)
    }

    func testModelTapOnMatchingSelectableRailUpdatesModelOnly() {
        let advertised = [Self.instance(id: "plain", models: ["plain-1", "plain-2"])]
        let current = ModelSelection(instanceId: "plain", model: "plain-1")
        let next = ModelPickerRailPolicy.selectionAfterModelTap(
            current: current,
            rail: advertised[0],
            modelId: "plain-2"
        )
        XCTAssertEqual(next?.instanceId, "plain")
        XCTAssertEqual(next?.model, "plain-2")
    }

    private static func instance(id: String, models: [String]) -> Instance {
        Instance(
            instanceId: id,
            driverKind: id,
            displayName: id,
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(
                default: models.first ?? "",
                options: models.map { ModelOption(id: $0, label: $0) }
            )
        )
    }
}
