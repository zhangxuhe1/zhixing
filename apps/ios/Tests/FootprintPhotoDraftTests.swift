import XCTest
@testable import Zhixing

/// FootprintPhotoDraft 纯逻辑矩阵(足迹照片编辑草稿模型):
/// - 差量视图:pendingRemovals(按 original 序)/ pendingAdditions(按 entries 序)/
///   reorderNeeded(entries 的 id 序 ≠「original 剔除 removals + additions 追加」的自然序才为真)。
/// - 进度固化:markRemoved / markUploaded / markSkipped 保证部分失败重试不重复执行。
/// - finalPhotoIds:entries 全为 remote 才产出(PUT body),仍有 local 时为 nil。
final class FootprintPhotoDraftTests: XCTestCase {
    private func meta(_ id: String) -> FootprintPhotoMeta {
        FootprintPhotoMeta(id: id, takenAt: nil)
    }

    private func localDraft() -> LocalPhotoDraft {
        LocalPhotoDraft(id: UUID(), data: Data([0xFF]))
    }

    // 初始状态:无任何变更。
    func testInitialStateHasNoChanges() {
        let draft = FootprintPhotoDraft(original: [meta("a"), meta("b")])
        XCTAssertFalse(draft.hasChanges)
        XCTAssertFalse(draft.reorderNeeded)
        XCTAssertEqual(draft.pendingRemovals, [])
        XCTAssertEqual(draft.pendingAdditions, [])
        XCTAssertEqual(draft.count, 2)
        XCTAssertEqual(draft.finalPhotoIds, ["a", "b"])
    }

    // 删一张:pendingRemovals 正确;删除不打乱剩余顺序,reorderNeeded=false。
    func testRemoveOneProducesPendingRemovalWithoutReorder() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b"), meta("c")])
        draft.remove(id: "b")
        XCTAssertEqual(draft.pendingRemovals, ["b"])
        XCTAssertFalse(draft.reorderNeeded)
        XCTAssertTrue(draft.hasChanges)
        XCTAssertEqual(draft.count, 2)
    }

    // 删到 0:pendingRemovals 按 original 序列出全部(与删除操作顺序无关)。
    func testRemoveAllListsRemovalsInOriginalOrder() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b"), meta("c")])
        draft.remove(id: "c")
        draft.remove(id: "a")
        draft.remove(id: "b")
        XCTAssertEqual(draft.pendingRemovals, ["a", "b", "c"])
        XCTAssertEqual(draft.count, 0)
        XCTAssertFalse(draft.reorderNeeded)
        XCTAssertTrue(draft.hasChanges)
    }

    // append 两张:pendingAdditions 按 entries 序;quota 扣减;追加到尾即自然序,reorderNeeded=false。
    func testAppendTwoLocalsKeepsNaturalOrder() {
        var draft = FootprintPhotoDraft(original: [meta("a")])
        let l1 = localDraft()
        let l2 = localDraft()
        draft.append(l1)
        draft.append(l2)
        XCTAssertEqual(draft.pendingAdditions, [l1, l2])
        XCTAssertEqual(draft.remainingQuota, 6)
        XCTAssertFalse(draft.reorderNeeded)
        XCTAssertTrue(draft.hasChanges)
        XCTAssertNil(draft.finalPhotoIds)
    }

    // 新图拖到中间:偏离自然序,reorderNeeded=true。
    func testMoveNewLocalIntoMiddleNeedsReorder() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b")])
        let l1 = localDraft()
        draft.append(l1)
        draft.move(id: l1.id.uuidString, toIndex: 1)
        XCTAssertTrue(draft.reorderNeeded)
        XCTAssertEqual(draft.pendingAdditions, [l1])
        XCTAssertEqual(draft.pendingRemovals, [])
    }

    // moveToFront(设为封面):非首张移前 reorderNeeded=true;对第一张是 no-op,false。
    func testMoveToFrontSetsReorderOnlyWhenOrderActuallyChanges() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b"), meta("c")])
        draft.moveToFront(id: "c")
        XCTAssertTrue(draft.reorderNeeded)
        XCTAssertEqual(draft.finalPhotoIds, ["c", "a", "b"])

        var noop = FootprintPhotoDraft(original: [meta("a"), meta("b")])
        noop.moveToFront(id: "a")
        XCTAssertFalse(noop.reorderNeeded)
        XCTAssertFalse(noop.hasChanges)
    }

    // 删+增+重排组合:三个差量视图联合断言。
    func testCombinedRemoveAppendReorderDiffViews() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b"), meta("c")])
        let l1 = localDraft()
        let l2 = localDraft()
        draft.remove(id: "b")
        draft.append(l1)
        draft.append(l2)
        draft.moveToFront(id: l1.id.uuidString)
        XCTAssertEqual(draft.pendingRemovals, ["b"])
        XCTAssertEqual(draft.pendingAdditions, [l1, l2])
        XCTAssertTrue(draft.reorderNeeded)
        XCTAssertTrue(draft.hasChanges)
        XCTAssertEqual(draft.count, 4)
        XCTAssertNil(draft.finalPhotoIds)
    }

    // markRemoved:DELETE 成功后固化,重试时 pendingRemovals 不再含它。
    func testMarkRemovedClearsPendingRemoval() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b")])
        draft.remove(id: "b")
        draft.markRemoved(id: "b")
        XCTAssertEqual(draft.pendingRemovals, [])
        XCTAssertFalse(draft.hasChanges)
        XCTAssertFalse(draft.reorderNeeded)
    }

    // markUploaded:local 原位替换成 remote 后可产出 finalPhotoIds,新 id 在用户摆放的位置上。
    func testMarkUploadedProducesFinalPhotoIdsWithNewIdInPlace() {
        var draft = FootprintPhotoDraft(original: [meta("a"), meta("b")])
        let l1 = localDraft()
        draft.append(l1)
        draft.move(id: l1.id.uuidString, toIndex: 1)
        XCTAssertNil(draft.finalPhotoIds)

        draft.markUploaded(draftId: l1.id, meta: meta("n"))
        XCTAssertEqual(draft.finalPhotoIds, ["a", "n", "b"])
        XCTAssertEqual(draft.pendingAdditions, [])
        XCTAssertTrue(draft.reorderNeeded)
    }

    // markSkipped:坏图从 entries 剔除,finalPhotoIds 不含坏图,count 恢复。
    func testMarkSkippedDropsBadPhotoAndRestoresCount() {
        var draft = FootprintPhotoDraft(original: [meta("a")])
        let bad = localDraft()
        draft.append(bad)
        XCTAssertEqual(draft.count, 2)

        draft.markSkipped(draftId: bad.id)
        XCTAssertEqual(draft.finalPhotoIds, ["a"])
        XCTAssertEqual(draft.count, 1)
        XCTAssertEqual(draft.pendingAdditions, [])
        XCTAssertFalse(draft.hasChanges)
    }

    // 9 张满额:remainingQuota=0(下限 0,不为负)。
    func testFullQuotaIsZero() {
        let metas = (1...9).map { meta("p\($0)") }
        var draft = FootprintPhotoDraft(original: metas)
        XCTAssertEqual(draft.remainingQuota, 0)
        draft.append(localDraft())
        XCTAssertEqual(draft.remainingQuota, 0)
    }
}
