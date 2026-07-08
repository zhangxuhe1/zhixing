import Foundation
import Observation

/// 用户收藏（风物卡）：`items` 供 FavoritesScreen 列表展示，`cardIds` 供 CardDetailView 判定书签态。
/// 两者一律经 load()/toggle()/reset() 维护，调用方不得绕过 store 直接拼装或改写。
@MainActor
@Observable
final class FavoritesStore {
    private(set) var items: [FavoriteItem] = []
    private(set) var cardIds: Set<String> = []

    private let fetchFavorites: () async throws -> [FavoriteItem]
    private let putFavorite: (String) async throws -> Void
    private let deleteFavorite: (String) async throws -> Void

    private struct FavoritesResponse: Decodable { let items: [FavoriteItem] }

    /// 测试缝：注入三个执行闭包（对齐 ViewTracker 的 init(send:) 先例），验证乐观更新/回滚逻辑
    /// 时不发真实网络请求；生产环境走默认闭包，复用既有 APIClient get/put/delete 通道。
    init(
        fetchFavorites: @escaping () async throws -> [FavoriteItem] = {
            let page: FavoritesResponse = try await APIClient.shared.get("/me/favorites")
            return page.items
        },
        putFavorite: @escaping (String) async throws -> Void = { cardId in
            try await APIClient.shared.put("/cards/\(cardId)/favorite")
        },
        deleteFavorite: @escaping (String) async throws -> Void = { cardId in
            try await APIClient.shared.delete("/cards/\(cardId)/favorite")
        }
    ) {
        self.fetchFavorites = fetchFavorites
        self.putFavorite = putFavorite
        self.deleteFavorite = deleteFavorite
    }

    /// 全量拉取收藏列表；服务端按 favoritedAt 倒序返回，本地不重排。
    /// 与 FootprintStore.load() 的静默吞错（M1 遗留、I10 才处理）不同：本 store 是 LoadState 惯例
    /// （I2+）之后新增的 store，须满足全局约束"网络错误必须可见可重试"——FavoritesScreen 用 LoadState
    /// 包裹本方法的调用，由界面层决定失败态怎么展示，因此这里改为 throws（对 brief 字面
    /// `func load() async` 签名的必要技术性修正，详见任务报告）。
    func load() async throws {
        let list = try await fetchFavorites()
        items = list
        cardIds = Set(list.map(\.cardId))
    }

    /// 乐观翻转 cardIds（驱动 CardDetailView 书签图标即时切换），失败回滚并返回 false——调用方
    /// 负责把失败呈现给用户（M2 全局规则：仅浏览打点允许静默，用户主动操作的失败必须可见）。
    /// 返回值语义：收藏/取消这件事本身是否成功；加入方向 PUT 成功后 best-effort 重取 items 的
    /// 失败不影响返回 true（收藏已经成立，不该向用户误报失败）。
    /// 回滚只做"手术式"单元素撤销（Set.insert/remove + 按原下标插回/删除单条 item），不整体快照/
    /// 恢复 items、cardIds 两个容器——两个 CardDetailView 各自 toggle 不同 cardId 时会在 MainActor
    /// 上交替推进（各自的 await 点之间可能穿插对方的写入），若回滚时把整个容器摞回调用前的快照，
    /// 会连带抹掉对方并发写入的、本不该被撤销的变更。单元素操作在这种交错下总是安全的。
    /// 加入方向：本地没有服务端才有的完整字段（标题/分类/地点/收藏时间），无法乐观合成一条完整
    /// FavoriteItem 插进 items；PUT 成功后 best-effort 重新 load() 补全 items（含权威顺序）——
    /// 这次重取即便失败也不影响本次收藏已经成功的事实（cardIds 已经是对的），仅 items 暂缺该行，
    /// 下次成功 load() 会自愈，属一次性、可自愈的短暂不一致（与 I4 故事点赞"详情页点亮不即时回写
    /// 列表行"同族取舍）。
    func toggle(cardId: String) async -> Bool {
        if cardIds.contains(cardId) {
            let removedIndex = items.firstIndex { $0.cardId == cardId }
            let removedItem = removedIndex.map { items[$0] }
            cardIds.remove(cardId)
            if let removedIndex { items.remove(at: removedIndex) }
            do {
                try await deleteFavorite(cardId)
                return true
            } catch {
                cardIds.insert(cardId)
                if let removedItem {
                    // 并发写入可能已改变 items 长度；下标仍在界内就按原位插回（外观上不动），
                    // 否则退化为追加——不会丢失/重复这条数据，顺序在下次 load() 时会被服务端权威序纠正。
                    if let removedIndex, removedIndex <= items.count {
                        items.insert(removedItem, at: removedIndex)
                    } else {
                        items.append(removedItem)
                    }
                }
                return false
            }
        } else {
            cardIds.insert(cardId)
            do {
                try await putFavorite(cardId)
                try? await load()
                return true
            } catch {
                cardIds.remove(cardId)
                return false
            }
        }
    }

    /// 登出清空（对齐 FootprintStore.reset 模式）：防跨账号收藏数据泄露。
    func reset() {
        items = []
        cardIds = []
    }
}
