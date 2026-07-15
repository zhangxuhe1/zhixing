import XCTest
@testable import Zhixing

final class PlacePathTests: XCTestCase {
    func testPathTextJoinsFarToNear() throws {
        let json = """
        {"id":"p3","name":"芙蓉街","level":"DISTRICT","intro":null,
         "ancestors":[{"id":"p1","name":"山东省","level":"PROVINCE"},
                      {"id":"p2","name":"济南市","level":"CITY"}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.pathText, "山东省 · 济南市")
    }

    func testPathTextNilWhenTopLevel() throws {
        let json = """
        {"id":"p1","name":"北京市","level":"PROVINCE","intro":null,"ancestors":[]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.pathText)
    }

    /// `/places/:id/cards` 列表不含 place 字段——Card 解码必须容错,否则风物卡列表整页崩。
    func testCardDecodesWithoutPlace() throws {
        let json = """
        {"id":"c1","title":"银锭观山","category":"ANECDOTE","status":"REVIEWED",
         "sources":[],"blocks":[]}
        """
        let card = try APIClient.decoder.decode(Card.self, from: Data(json.utf8))
        XCTAssertNil(card.place)
    }

    func testCardLocationTextFromEmbeddedPlace() throws {
        let json = """
        {"id":"c1","title":"银锭观山","category":"ANECDOTE","status":"REVIEWED",
         "sources":[],"blocks":[],
         "place":{"id":"p2","name":"什刹海",
                  "ancestors":[{"id":"p1","name":"北京市","level":"PROVINCE"}]}}
        """
        let card = try APIClient.decoder.decode(Card.self, from: Data(json.utf8))
        XCTAssertEqual(card.locationText, "北京市 · 什刹海")
    }
}
