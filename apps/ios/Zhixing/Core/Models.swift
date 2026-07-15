import Foundation

struct Pin: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let level: String
    let parentId: String?
    let lat: Double
    let lng: Double
    let cardCount: Int
    /// M3:地点状态。旧缓存/旧服务端无此字段 → nil 视同 ACTIVE。
    let status: String?

    var isAwaitingReview: Bool { status == "PENDING" || status == "REJECTED" }

    init(
        id: String, name: String, level: String, parentId: String?,
        lat: Double, lng: Double, cardCount: Int, status: String? = nil
    ) {
        self.id = id
        self.name = name
        self.level = level
        self.parentId = parentId
        self.lat = lat
        self.lng = lng
        self.cardCount = cardCount
        self.status = status
    }
}

struct PlaceAncestor: Codable, Hashable {
    let id: String
    let name: String
    let level: String
}

/// `GET /places/:id` 的地点详情:抽屉头部路径与后续攻略区共用。
struct PlaceDetail: Codable {
    let id: String
    let name: String
    let level: String
    let intro: String?
    let ancestors: [PlaceAncestor]
    /// M3:地点状态;旧服务端缺字段容错。
    let status: String?
    /// 旧服务端/缓存无此字段,可选容错;空数组与 nil 均不渲染攻略区。
    let links: [PlaceLink]?

    /// 从远到近的位置路径:"山东省 · 济南市";链顶(无祖先)为 nil,不渲染。
    var pathText: String? {
        ancestors.isEmpty ? nil : ancestors.map(\.name).joined(separator: " · ")
    }
}

struct PlaceLink: Codable, Identifiable {
    let id: String
    let platform: String
    let title: String
    let url: String

    static let platformLabels = [
        "XIAOHONGSHU": "小红书", "BILIBILI": "B 站", "DOUYIN": "抖音",
        "WEIBO": "微博", "OTHER": "网页",
    ]
    var platformLabel: String { Self.platformLabels[platform] ?? platform }
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
    /// 仅 `GET /cards/:id` 返回;`/places/:id/cards` 列表无此字段——必须可选容错。
    let place: CardPlaceRef?

    static let categoryLabels = [
        "CUSTOMS": "习俗", "FOOD": "吃食", "DIALECT": "方言",
        "ANECDOTE": "掌故", "PLACE_NAME": "地名由来",
    ]
    var categoryLabel: String { Self.categoryLabels[category] ?? category }
    var isAIGenerated: Bool { status == "AI_GENERATED" }

    /// 卡面位置行:"北京市 · 什刹海"。无内嵌 place(列表来源)时为 nil,由调用方注入兜底。
    var locationText: String? {
        guard let place else { return nil }
        return (place.ancestors.map(\.name) + [place.name]).joined(separator: " · ")
    }
}

struct CardPlaceRef: Codable {
    let id: String
    let name: String
    let ancestors: [PlaceAncestor]
}

struct User: Codable { let id: String; let nickname: String }
struct AuthResponse: Codable { let token: String; let user: User }

struct PlaceRef: Codable {
    let id: String
    let name: String
    /// 足迹编辑器据此禁用公开开关;旧响应缺字段容错。
    let status: String?

    init(id: String, name: String, status: String? = nil) {
        self.id = id
        self.name = name
        self.status = status
    }
}
struct FootprintPhotoMeta: Codable, Identifiable { let id: String; let takenAt: Date? }

/// 足迹公开状态徽标：由 visibility/reviewStatus 纯映射得出，不直接来自服务端字段。
enum PublishBadge: String { case pending = "审核中", rejected = "未通过", published = "已公开" }

struct Footprint: Codable, Identifiable {
    let id: String
    let placeId: String
    let text: String?
    let date: Date
    let place: PlaceRef
    let photos: [FootprintPhotoMeta]
    let visibility: String
    let reviewStatus: String
    let likeCount: Int
    let viewCount: Int
    let tripId: String?

    /// PRIVATE→nil；PUBLIC+PENDING→审核中；PUBLIC+REJECTED→未通过；PUBLIC+APPROVED→已公开；未知组合→nil（容错）。
    var publishBadge: PublishBadge? {
        guard visibility == "PUBLIC" else { return nil }
        switch reviewStatus {
        case "PENDING": return .pending
        case "REJECTED": return .rejected
        case "APPROVED": return .published
        default: return nil
        }
    }
}

struct Stats: Codable { let footprints: Int; let places: Int; let cities: Int; let provinces: Int }
struct PhotoURL: Codable { let url: String }

// MARK: - M2：旅人故事 / 旅人镜头 / 旅程 / 收藏 / 远程配置

struct StoryPhoto: Codable, Identifiable {
    let photoId: String
    var id: String { photoId }
}

struct Story: Codable, Identifiable {
    let footprintId: String
    let text: String?
    let date: Date
    let authorNickname: String
    let likeCount: Int
    let viewCount: Int
    let likedByMe: Bool
    let photos: [StoryPhoto]
    var id: String { footprintId }
}

struct StoriesPage: Codable {
    let items: [Story]
    let nextCursor: String?
}

struct WallPhoto: Codable, Identifiable {
    let photoId: String
    let footprintId: String
    var id: String { photoId }
}

struct PhotoWallGroup: Codable, Identifiable {
    let label: String
    let photos: [WallPhoto]
    var id: String { label }
}

struct PhotoWall: Codable {
    let groups: [PhotoWallGroup]
}

struct TripSuggestion: Codable, Identifiable, Hashable {
    let footprintIds: [String]
    let suggestedTitle: String
    let startDate: Date
    let endDate: Date
    var id: String { footprintIds.joined(separator: ",") }
}

struct Trip: Codable, Identifiable {
    let id: String
    let title: String
    let startDate: Date
    let endDate: Date
    let footprintCount: Int
}

struct FavoriteItem: Codable, Identifiable {
    let cardId: String
    let title: String
    let category: String
    let placeId: String
    let placeName: String
    let favoritedAt: Date
    var id: String { cardId }
}

struct RemoteAppConfig: Codable {
    let shareLandingUrl: String
    /// M3 前服务端没有该字段:可选容错,消费端缺省按"开"。
    let placeSubmission: Bool?

    init(shareLandingUrl: String, placeSubmission: Bool? = nil) {
        self.shareLandingUrl = shareLandingUrl
        self.placeSubmission = placeSubmission
    }
}
