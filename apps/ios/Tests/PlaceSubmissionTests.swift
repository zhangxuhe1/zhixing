import XCTest
@testable import Zhixing

final class PlaceSubmissionTests: XCTestCase {
    /// 旧缓存/旧服务端的 pins 无 status 字段:解码不炸,且视为非待审。
    func testPinDecodesWithoutStatus() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","parentId":null,
         "lat":39.94,"lng":116.38,"cardCount":3}
        """
        let pin = try APIClient.decoder.decode(Pin.self, from: Data(json.utf8))
        XCTAssertNil(pin.status)
        XCTAssertFalse(pin.isAwaitingReview)
    }

    func testPinAwaitingReviewStates() throws {
        for (status, expected) in [("PENDING", true), ("REJECTED", true), ("ACTIVE", false)] {
            let json = """
            {"id":"p1","name":"x","level":"POI","parentId":null,
             "lat":1,"lng":1,"cardCount":0,"status":"\(status)"}
            """
            let pin = try APIClient.decoder.decode(Pin.self, from: Data(json.utf8))
            XCTAssertEqual(pin.isAwaitingReview, expected, status)
        }
    }

    /// M3 前的服务端 /app-config 没有 placeSubmission——缺字段解码为 nil,开关默认开。
    func testRemoteAppConfigToleratesMissingFlag() throws {
        let json = #"{"shareLandingUrl":"https://example.com/share"}"#
        let config = try APIClient.decoder.decode(RemoteAppConfig.self, from: Data(json.utf8))
        XCTAssertNil(config.placeSubmission)
    }

    /// 足迹内嵌地点带 status;旧响应缺字段容错。
    func testPlaceRefStatusOptional() throws {
        let with = #"{"id":"p1","name":"洪家楼","status":"PENDING"}"#
        XCTAssertEqual(
            try APIClient.decoder.decode(PlaceRef.self, from: Data(with.utf8)).status,
            "PENDING")
        let without = #"{"id":"p1","name":"洪家楼"}"#
        XCTAssertNil(try APIClient.decoder.decode(PlaceRef.self, from: Data(without.utf8)).status)
    }
}
