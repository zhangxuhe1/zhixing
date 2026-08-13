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

    func testPlaceDetailDecodesLinksAndPlatformLabel() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"XIAOHONGSHU","title":"citywalk 路线",
                   "url":"https://example.com/a","sortOrder":1}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.links?.first?.platformLabel, "小红书")
    }

    /// links 字段缺失(旧服务端/缓存)不应让整个详情解码失败。
    func testPlaceDetailToleratesMissingLinks() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","intro":null,"ancestors":[]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.links)
    }

    func testPlaceLinkDecodesTag() throws {
        let json = """
        {"id":"p1","name":"香港","level":"CITY","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"BILIBILI","title":"200 元穷游香港",
                   "url":"https://example.com/hk","sortOrder":0,"tag":"实用攻略"}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.links?.first?.tag, "实用攻略")
    }

    /// 老服务端/旧缓存无 tag 字段:解码不崩,chip 数据为 nil(未打标同形)。
    func testPlaceLinkToleratesMissingTag() throws {
        let json = """
        {"id":"p1","name":"香港","level":"CITY","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"DOUYIN","title":"香港旅行记录",
                   "url":"https://example.com/a","sortOrder":0}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.links?.first?.tag)
    }
}
