import XCTest
@testable import CompanionCore

/// Locks the profile / settings / local-VM contracts the SwiftUI surfaces
/// project. The views themselves live in the app target; these tests keep
/// the wire values they rely on from drifting.
final class ProfileSettingsVmParityTests: XCTestCase {
    func testMascotPickerShapesStayInGrokOrder() {
        XCTAssertEqual(
            MascotShape.allCases.map(\.rawValue),
            ["circle", "oval", "square", "pill", "triangle", "hexagon", "cloud", "droplet"]
        )
    }

    func testGrokPickerPaletteIncludesLightMarksAndKeepsCyan() {
        let picker = ["white", "brown", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"]
        for name in picker {
            XCTAssertNotNil(MausColor(rawValue: name), "picker colour \(name) must decode")
        }
        XCTAssertEqual(MausColor(rawValue: "cyan"), .cyan)
        XCTAssertEqual(Bot(testColor: "cyan").mascotColor, .cyan)
        XCTAssertEqual(Bot(testColor: "white").mascotColor, .white)
        XCTAssertEqual(Bot(testColor: "chartreuse").mascotColor, .green)
    }

    func testWorkingIsTheOnlyAnimatedRuntimeActivity() {
        XCTAssertFalse(Bot(testActivity: "idle", busy: true).isWorking)
        XCTAssertFalse(Bot(testActivity: "waiting-on-you", busy: true).isWorking)
        XCTAssertFalse(Bot(testActivity: "no-signal", busy: true).isWorking)
        XCTAssertFalse(Bot(testActivity: nil, busy: false).isWorking)
        XCTAssertTrue(Bot(testActivity: "working", busy: false).isWorking)
        XCTAssertTrue(Bot(testActivity: nil, busy: true).isWorking)
    }

    func testLocalHostStartsWithoutClaimingACloudViewer() {
        let busyLocal = Bot(testComputer: "local", busy: true)
        XCTAssertEqual(ComputerPresentationState(bot: busyLocal), .starting)
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(busyLocal))

        let busyVm = Bot(testComputer: "vm", busy: true)
        XCTAssertEqual(ComputerPresentationState(bot: busyVm), .starting)
        XCTAssertFalse(ComputerPresentationState.supportsCloudViewer(busyVm))

        let frame = ScreenFrame(png: "c2NyZWVu", mime: "image/png")
        XCTAssertEqual(ComputerPresentationState(bot: busyVm, frame: frame), .watching)
    }

    func testLocalVmControlsStayPerBotAndCapabilityGated() {
        let status = LocalVmStatus(
            mode: .perBot,
            maxInstances: 2,
            state: .missing,
            container: "missing",
            daemonUp: true,
            imageReady: true,
            desktopReady: false,
            ready: false,
            createSupported: true,
            busy: false,
            canCreate: true,
            canStop: false,
            canRecreate: false,
            problem: "Create this bot's Local VM."
        )
        let vm = Bot(testComputer: "vm", busy: false)
        XCTAssertTrue(ComputerPresentationState.supportsLocalVmControls(vm, status: status, accessGranted: true))
        XCTAssertFalse(ComputerPresentationState.supportsLocalVmControls(vm, status: status, accessGranted: false))
        XCTAssertEqual(ComputerPresentationState(bot: vm), .starting)
    }

    func testWeekdayRoutineEncodingMatchesProfileCopy() {
        let weekdays = RoutineSchedule.daily(time: "09:00", weekdays: [1, 2, 3, 4, 5])
        XCTAssertEqual(weekdays.weekdays, [1, 2, 3, 4, 5])
        XCTAssertEqual(weekdays.time, "09:00")

        let everyday = RoutineSchedule.daily(time: "19:00", weekdays: [0, 1, 2, 3, 4, 5, 6])
        XCTAssertEqual(everyday.weekdays?.count, 7)
    }
}

private extension Bot {
    init(testColor: String) {
        self = Bot.parity(
            name: "Colour",
            color: testColor,
            activity: nil,
            busy: nil,
            computer: nil
        )
    }

    init(testActivity: String?, busy: Bool?) {
        self = Bot.parity(
            name: "Activity",
            color: "green",
            activity: testActivity,
            busy: busy,
            computer: nil
        )
    }

    init(testComputer: String?, busy: Bool?) {
        self = Bot.parity(
            name: "Computer",
            color: "orange",
            activity: nil,
            busy: busy,
            computer: testComputer
        )
    }

    static func parity(
        name: String,
        color: String,
        activity: String?,
        busy: Bool?,
        computer: String?
    ) -> Bot {
        var bot = Bot(
            id: "bot-\(name.lowercased())",
            threadId: "thread-\(name.lowercased())",
            name: name,
            title: "",
            description: "",
            notifications: true,
            color: color,
            avatarUrl: nil,
            avatarCrop: nil,
            unread: false,
            modelSelection: ModelSelection(instanceId: "preview", model: "preview"),
            createdAt: 1,
            busy: busy,
            pinned: false,
            hidden: false,
            chiefOfStaff: false,
            autoApprove: false,
            alwaysAllow: nil,
            computer: computer,
            cloudBackend: nil,
            speakReplies: false,
            voice: nil,
            mascotExpression: nil,
            tasks: nil,
            messages: nil,
            activeLeafId: nil,
            hasMore: nil
        )
        bot.activity = activity
        return bot
    }
}
