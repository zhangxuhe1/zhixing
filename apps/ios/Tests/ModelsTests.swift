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
         "photos":[{"id":"ph1","takenAt":"2026-05-01T09:30:00.000Z"}],
         "visibility":"PUBLIC","reviewStatus":"APPROVED","likeCount":2,"viewCount":9,"tripId":"t1"}
        """.data(using: .utf8)!
        let fp = try APIClient.decoder.decode(Footprint.self, from: json)
        XCTAssertEqual(fp.place.name, "什刹海")
        XCTAssertNotNil(fp.photos[0].takenAt)
        XCTAssertEqual(fp.visibility, "PUBLIC")
        XCTAssertEqual(fp.reviewStatus, "APPROVED")
        XCTAssertEqual(fp.likeCount, 2)
        XCTAssertEqual(fp.viewCount, 9)
        XCTAssertEqual(fp.tripId, "t1")
        XCTAssertEqual(fp.publishBadge, .published)
    }

    func testDecodeFootprintPrivateDefaultHasNoBadge() throws {
        let json = """
        {"id":"f2","placeId":"p1","text":"随手记","date":"2026-05-02T00:00:00Z",
         "place":{"id":"p1","name":"什刹海"},"photos":[],
         "visibility":"PRIVATE","reviewStatus":"PENDING","likeCount":0,"viewCount":0,"tripId":null}
        """.data(using: .utf8)!
        let fp = try APIClient.decoder.decode(Footprint.self, from: json)
        XCTAssertNil(fp.tripId)
        XCTAssertNil(fp.publishBadge)
    }

    func testPublishBadgeMapping() {
        func footprint(visibility: String, reviewStatus: String) -> Footprint {
            Footprint(id: "f", placeId: "p", text: nil, date: Date(),
                      place: PlaceRef(id: "p", name: "地"), photos: [],
                      visibility: visibility, reviewStatus: reviewStatus,
                      likeCount: 0, viewCount: 0, tripId: nil)
        }
        XCTAssertNil(footprint(visibility: "PRIVATE", reviewStatus: "PENDING").publishBadge)
        XCTAssertEqual(footprint(visibility: "PUBLIC", reviewStatus: "PENDING").publishBadge, .pending)
        XCTAssertEqual(footprint(visibility: "PUBLIC", reviewStatus: "REJECTED").publishBadge, .rejected)
        XCTAssertEqual(footprint(visibility: "PUBLIC", reviewStatus: "APPROVED").publishBadge, .published)
        XCTAssertNil(footprint(visibility: "PUBLIC", reviewStatus: "UNKNOWN").publishBadge)
        XCTAssertNil(footprint(visibility: "UNKNOWN", reviewStatus: "APPROVED").publishBadge)
    }

    func testDecodeStoriesPage() throws {
        let json = """
        {"items":[
          {"footprintId":"f1","text":"第一次来这里","date":"2026-05-01T10:00:00.000Z",
           "authorNickname":"阿泽","likeCount":3,"viewCount":10,"likedByMe":true,
           "photos":[{"photoId":"ph1"},{"photoId":"ph2"}]},
          {"footprintId":"f2","text":null,"date":"2026-04-01T08:00:00Z",
           "authorNickname":"小明","likeCount":0,"viewCount":1,"likedByMe":false,"photos":[]}
        ],"nextCursor":null}
        """.data(using: .utf8)!
        let page = try APIClient.decoder.decode(StoriesPage.self, from: json)
        XCTAssertEqual(page.items.count, 2)
        XCTAssertNil(page.nextCursor)
        let first = page.items[0]
        XCTAssertEqual(first.id, "f1") // Story.id ≡ footprintId
        XCTAssertEqual(first.authorNickname, "阿泽")
        XCTAssertTrue(first.likedByMe)
        XCTAssertEqual(first.photos.map(\.id), ["ph1", "ph2"]) // StoryPhoto.id ≡ photoId
        XCTAssertNil(page.items[1].text)
    }

    func testDecodePhotoWall() throws {
        let json = """
        {"groups":[
          {"label":"2024·春","photos":[{"photoId":"ph1","footprintId":"f1"},{"photoId":"ph2","footprintId":"f1"}]},
          {"label":"2024·冬","photos":[{"photoId":"ph3","footprintId":"f2"}]}
        ]}
        """.data(using: .utf8)!
        let wall = try APIClient.decoder.decode(PhotoWall.self, from: json)
        XCTAssertEqual(wall.groups.map(\.id), ["2024·春", "2024·冬"]) // PhotoWallGroup.id ≡ label
        XCTAssertEqual(wall.groups[0].photos.map(\.photoId), ["ph1", "ph2"])
        XCTAssertEqual(wall.groups[0].photos.map(\.id), ["ph1", "ph2"]) // WallPhoto.id ≡ photoId
        XCTAssertEqual(wall.groups[0].photos[0].footprintId, "f1")
    }

    func testDecodeTrip() throws {
        let json = """
        {"id":"t1","title":"三月西湖行","startDate":"2026-03-01T00:00:00Z","endDate":"2026-03-04T00:00:00Z","footprintCount":4}
        """.data(using: .utf8)!
        let trip = try APIClient.decoder.decode(Trip.self, from: json)
        XCTAssertEqual(trip.id, "t1")
        XCTAssertEqual(trip.footprintCount, 4)
    }

    func testDecodeTripSuggestionPreservesFootprintIdOrder() throws {
        let json = """
        {"footprintIds":["f3","f1","f2"],"suggestedTitle":"五一西安行",
         "startDate":"2026-05-01T00:00:00Z","endDate":"2026-05-03T00:00:00Z"}
        """.data(using: .utf8)!
        let suggestion = try APIClient.decoder.decode(TripSuggestion.self, from: json)
        XCTAssertEqual(suggestion.footprintIds, ["f3", "f1", "f2"])
        XCTAssertEqual(suggestion.suggestedTitle, "五一西安行")
    }

    func testDecodeFavoriteItem() throws {
        let json = """
        {"cardId":"c1","title":"银锭观山","category":"ANECDOTE","placeId":"p1","placeName":"什刹海",
         "favoritedAt":"2026-06-01T00:00:00.000Z"}
        """.data(using: .utf8)!
        let item = try APIClient.decoder.decode(FavoriteItem.self, from: json)
        XCTAssertEqual(item.id, "c1") // FavoriteItem.id ≡ cardId
        XCTAssertEqual(item.placeName, "什刹海")
    }

    func testDecodeRemoteAppConfig() throws {
        let json = """
        {"shareLandingUrl":"http://localhost:8787/beta"}
        """.data(using: .utf8)!
        let config = try APIClient.decoder.decode(RemoteAppConfig.self, from: json)
        XCTAssertEqual(config.shareLandingUrl, "http://localhost:8787/beta")
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
