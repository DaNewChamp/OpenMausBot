import XCTest
@testable import CompanionCore

final class LocalVmStatusTests: XCTestCase {
    func testDecodesOnlyThePhoneSafeProjection() throws {
        let status = try JSONDecoder().decode(
            LocalVmStatus.self,
            from: Data("""
            {
              "mode":"per-bot",
              "max_instances":3,
              "state":"ready",
              "container":"running",
              "daemon_up":true,
              "image_ready":true,
              "desktop_ready":true,
              "ready":true,
              "create_supported":true,
              "busy":false,
              "can_create":false,
              "can_stop":true,
              "can_recreate":true,
              "problem":null,
              "workspace_path":"/Users/private/.openmausbot",
              "image_id":"sha256:private",
              "viewer_url":"http://127.0.0.1:6080/vnc.html"
            }
            """.utf8)
        )

        XCTAssertEqual(status.mode, .perBot)
        XCTAssertEqual(status.maxInstances, 3)
        XCTAssertEqual(status.state, .ready)
        XCTAssertTrue(status.ready)
        XCTAssertTrue(status.canStop)
        XCTAssertTrue(status.canRecreate)
        XCTAssertNil(status.problem)

        let encoded = try JSONEncoder().encode(status)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertFalse(object.keys.contains("workspace_path"))
        XCTAssertFalse(object.keys.contains("image_id"))
        XCTAssertFalse(object.keys.contains("viewer_url"))
    }

    func testUnknownValuesDegradeWithoutDroppingTheStatus() throws {
        let status = try JSONDecoder().decode(
            LocalVmStatus.self,
            from: Data("""
            {"mode":"future","state":"booting","container":"future","max_instances":0,
             "daemon_up":false,"problem":null}
            """.utf8)
        )
        XCTAssertEqual(status.mode, .unknown)
        XCTAssertEqual(status.state, .unknown)
        XCTAssertEqual(status.container, "future")
        XCTAssertEqual(status.maxInstances, 0)
        XCTAssertFalse(status.daemonUp)
        XCTAssertNil(status.problem)
    }
}
