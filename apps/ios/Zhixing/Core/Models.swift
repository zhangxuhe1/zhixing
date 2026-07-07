import Foundation

struct Pin: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let level: String
    let parentId: String?
    let lat: Double
    let lng: Double
    let cardCount: Int
}

struct CardBlock: Codable, Identifiable {
    let id: String
    let order: Int
    let type: String
    let text: String?
    let mediaUrl: String?
}

struct Card: Codable, Identifiable, Hashable {
    static func == (lhs: Card, rhs: Card) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    let id: String
    let title: String
    let category: String
    let status: String
    let sources: [String]
    let blocks: [CardBlock]

    static let categoryLabels = [
        "CUSTOMS": "习俗", "FOOD": "吃食", "DIALECT": "方言",
        "ANECDOTE": "掌故", "PLACE_NAME": "地名由来",
    ]
    var categoryLabel: String { Self.categoryLabels[category] ?? category }
    var isAIGenerated: Bool { status == "AI_GENERATED" }
}

struct User: Codable { let id: String; let nickname: String }
struct AuthResponse: Codable { let token: String; let user: User }

struct PlaceRef: Codable { let id: String; let name: String }
struct FootprintPhotoMeta: Codable, Identifiable { let id: String; let takenAt: Date? }

struct Footprint: Codable, Identifiable {
    let id: String
    let placeId: String
    let text: String?
    let date: Date
    let place: PlaceRef
    let photos: [FootprintPhotoMeta]
}

struct Stats: Codable { let footprints: Int; let places: Int; let cities: Int; let provinces: Int }
struct PhotoURL: Codable { let url: String }
