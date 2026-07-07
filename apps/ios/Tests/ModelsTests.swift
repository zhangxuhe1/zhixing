import XCTest
@testable import Zhixing

final class ModelsTests: XCTestCase {
    func testDecodeCardWithBlocks() throws {
        let json = """
        {"id":"c1","title":"银锭观山","category":"ANECDOTE","status":"AI_GENERATED",
         "sources":["《燕都游览志》"],
         "blocks":[{"id":"b1","order":0,"type":"TEXT","text":"第一段","mediaUrl":null}]}
        """.data(using: .utf8)!
        let card = try APIClient.decoder.decode(Card.self, from: json)
        XCTAssertEqual(card.categoryLabel, "掌故")
        XCTAssertTrue(card.isAIGenerated)
        XCTAssertEqual(card.blocks[0].text, "第一段")
    }

    func testDecodeFootprintWithFractionalDate() throws {
        let json = """
        {"id":"f1","placeId":"p1","text":null,"date":"2026-05-01T10:00:00.000Z",
         "place":{"id":"p1","name":"什刹海"},
         "photos":[{"id":"ph1","takenAt":"2026-05-01T09:30:00.000Z"}]}
        """.data(using: .utf8)!
        let fp = try APIClient.decoder.decode(Footprint.self, from: json)
        XCTAssertEqual(fp.place.name, "什刹海")
        XCTAssertNotNil(fp.photos[0].takenAt)
    }

    func testDecodePinAndStats() throws {
        let pin = try APIClient.decoder.decode(Pin.self, from: """
        {"id":"p1","name":"什刹海","level":"DISTRICT","parentId":"c1","lat":39.94,"lng":116.38,"cardCount":3}
        """.data(using: .utf8)!)
        XCTAssertEqual(pin.cardCount, 3)
        let stats = try APIClient.decoder.decode(Stats.self, from: """
        {"footprints":3,"places":3,"cities":2,"provinces":0}
        """.data(using: .utf8)!)
        XCTAssertEqual(stats.cities, 2)
    }
}
