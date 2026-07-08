import XCTest
@testable import Zhixing

/// FavoritesStore 契约：items（列表展示用）与 cardIds（CardDetailView 书签态判定用）由 load()/toggle()
/// 统一维护；toggle 乐观翻转 cardIds，失败按单个 cardId 手术式回滚（不整体快照/恢复两个容器，
/// 避免抹掉并发的另一次 toggle 的写入）；reset 登出清空两容器。
/// 测试缝：init(fetchFavorites:putFavorite:deleteFavorite:) 注入三个假执行闭包，不发真实网络请求。
final class FavoritesStoreTests: XCTestCase {
    private func sample(_ cardId: String = "c1") -> FavoriteItem {
        FavoriteItem(cardId: cardId, title: "银锭观山", category: "ANECDOTE",
                     placeId: "p1", placeName: "什刹海", favoritedAt: Date())
    }

    // MARK: - load()

    @MainActor
    func testLoadPopulatesItemsAndCardIdsPreservingServerOrder() async throws {
        let store = FavoritesStore(
            fetchFavorites: { [self.sample("c1"), self.sample("c2")] },
            putFavorite: { _ in }, deleteFavorite: { _ in })

        try await store.load()

        XCTAssertEqual(store.items.map(\.cardId), ["c1", "c2"]) // 服务端保序，不重排
        XCTAssertEqual(store.cardIds, ["c1", "c2"])
    }

    @MainActor
    func testLoadThrowsAndLeavesContainersUnchanged() async {
        struct Boom: Error {}
        let store = FavoritesStore(
            fetchFavorites: { throw Boom() },
            putFavorite: { _ in }, deleteFavorite: { _ in })

        do {
            try await store.load()
            XCTFail("应抛出错误")
        } catch {
            // 期望路径
        }
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(store.cardIds.isEmpty)
    }

    // MARK: - toggle() 加入方向

    @MainActor
    func testToggleAddIsOptimisticThenRollsBackOnFailure() async {
        struct Boom: Error {}
        var cardIdsSeenDuringRequest: Set<String> = []
        var store: FavoritesStore!
        store = FavoritesStore(
            fetchFavorites: { [] },
            putFavorite: { cardId in
                // PUT 发出的瞬间读一次 store.cardIds：必须已经乐观包含该 id，证明"先翻转、后请求"。
                cardIdsSeenDuringRequest = store.cardIds
                throw Boom()
            },
            deleteFavorite: { _ in })

        await store.toggle(cardId: "c1")

        XCTAssertTrue(cardIdsSeenDuringRequest.contains("c1"), "PUT 发出时应已乐观加入 cardIds")
        XCTAssertFalse(store.cardIds.contains("c1"), "失败后应回滚移除")
        XCTAssertTrue(store.items.isEmpty, "加入方向本就未曾写入 items，回滚不应产生变化")
    }

    @MainActor
    func testToggleAddSucceedsInsertsCardIdAndBackfillsItemsViaReload() async {
        let store = FavoritesStore(
            fetchFavorites: { [self.sample("c1")] },
            putFavorite: { _ in }, // 成功
            deleteFavorite: { _ in })

        await store.toggle(cardId: "c1")

        XCTAssertEqual(store.cardIds, ["c1"])
        // 本地无法合成完整 FavoriteItem（缺标题/分类/地点等服务端字段），PUT 成功后 best-effort 重新
        // load() 补全 items——验证这条自愈路径确实发生。
        XCTAssertEqual(store.items.map(\.cardId), ["c1"])
    }

    // MARK: - toggle() 移除方向

    @MainActor
    func testToggleRemoveIsOptimisticThenRollsBackOnFailure() async throws {
        struct Boom: Error {}
        var cardIdsSeenDuringRequest: Set<String> = ["c1"]
        var store: FavoritesStore!
        store = FavoritesStore(
            fetchFavorites: { [self.sample("c1")] },
            putFavorite: { _ in },
            deleteFavorite: { cardId in
                // DELETE 发出的瞬间读一次：必须已经乐观移除该 id。
                cardIdsSeenDuringRequest = store.cardIds
                throw Boom()
            })
        try await store.load()
        XCTAssertTrue(store.cardIds.contains("c1")) // 前置条件：已收藏

        await store.toggle(cardId: "c1")

        XCTAssertFalse(cardIdsSeenDuringRequest.contains("c1"), "DELETE 发出时应已乐观移除 cardIds")
        XCTAssertTrue(store.cardIds.contains("c1"), "失败后应回滚恢复")
        XCTAssertEqual(store.items.map(\.cardId), ["c1"], "items 应恢复原样")
    }

    /// 回滚是"手术式"单元素操作而非整体快照/恢复：seed 三条，对中间一条 toggle 失败后，
    /// 前后两条必须原封不动（既不因为回滚被重排，也不会被牵连丢失/重复）——锁定这条实现选择，
    /// 防止有人为图省事改回"整体快照再整体覆盖"（那种写法在两个 toggle 并发交错时会互相冲掉）。
    @MainActor
    func testToggleRemoveRollbackOnlyTouchesTargetCardLeavesSiblingsIntact() async throws {
        struct Boom: Error {}
        let store = FavoritesStore(
            fetchFavorites: { [self.sample("c1"), self.sample("c2"), self.sample("c3")] },
            putFavorite: { _ in },
            deleteFavorite: { cardId in if cardId == "c2" { throw Boom() } })
        try await store.load()

        await store.toggle(cardId: "c2")

        XCTAssertEqual(store.cardIds, ["c1", "c2", "c3"])
        XCTAssertEqual(store.items.map(\.cardId), ["c1", "c2", "c3"], "回滚应把 c2 插回原下标，兄弟项顺序不变")
    }

    @MainActor
    func testToggleRemoveSucceedsClearsBothContainers() async throws {
        let store = FavoritesStore(
            fetchFavorites: { [self.sample("c1")] },
            putFavorite: { _ in }, deleteFavorite: { _ in })
        try await store.load()

        await store.toggle(cardId: "c1")

        XCTAssertTrue(store.cardIds.isEmpty)
        XCTAssertTrue(store.items.isEmpty)
    }

    // MARK: - reset()

    @MainActor
    func testResetClearsBothContainers() async throws {
        let store = FavoritesStore(
            fetchFavorites: { [self.sample("c1")] },
            putFavorite: { _ in }, deleteFavorite: { _ in })
        try await store.load()
        XCTAssertFalse(store.items.isEmpty)
        XCTAssertFalse(store.cardIds.isEmpty)

        store.reset()

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(store.cardIds.isEmpty)
    }
}
