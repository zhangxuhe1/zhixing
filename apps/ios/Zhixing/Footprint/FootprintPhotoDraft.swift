import Foundation

/// 编辑器照片分区的「事务式草稿」核心(纯值类型,不碰网络/UI;设计依据 spec §4)。
///
/// 编辑期间所有增删排都只落在草稿上;保存链路按三段消费差量视图:
/// pendingRemovals(逐张 DELETE)→ pendingAdditions(逐张上传)→ reorderNeeded(需要才 PUT 排序)。
/// 每段成功后调用对应的进度固化方法(markRemoved / markUploaded / markSkipped),
/// 使部分失败后的重试不会重复执行已成功的步骤。
/// entries 全部变为 remote 后,finalPhotoIds 才产出 PUT 的 body;仍有 local 时禁止发 PUT。

/// 本地暂存的待上传照片(已完成脱敏/压缩的 JPEG 数据)。
struct LocalPhotoDraft: Identifiable, Equatable {
    let id: UUID
    let data: Data
}

/// 草稿条目:已在服务器上的照片(remote)或本地暂存照片(local)。
enum PhotoDraftEntry: Identifiable, Equatable {
    case remote(FootprintPhotoMeta)
    case local(LocalPhotoDraft)

    var id: String {
        switch self {
        case .remote(let meta): return meta.id
        case .local(let draft): return draft.id.uuidString
        }
    }
}

struct FootprintPhotoDraft: Equatable {
    /// 服务器当前实际持有的照片(进度固化时同步更新:markRemoved 摘除、markUploaded 追加)。
    private(set) var original: [FootprintPhotoMeta]
    /// 用户编辑后的目标排列(UI 按此渲染九宫格)。
    private(set) var entries: [PhotoDraftEntry]

    init(original: [FootprintPhotoMeta]) {
        self.original = original
        self.entries = original.map { .remote($0) }
    }

    // MARK: - 编辑操作

    mutating func append(_ local: LocalPhotoDraft) {
        entries.append(.local(local))
    }

    mutating func remove(id: String) {
        entries.removeAll { $0.id == id }
    }

    /// 拖拽落点:把条目移到目标下标(先摘除再插入,越界钳制)。
    mutating func move(id: String, toIndex: Int) {
        guard let from = entries.firstIndex(where: { $0.id == id }) else { return }
        let entry = entries.remove(at: from)
        entries.insert(entry, at: min(max(toIndex, 0), entries.count))
    }

    /// 设为封面:移到首位。
    mutating func moveToFront(id: String) {
        move(id: id, toIndex: 0)
    }

    // MARK: - 差量视图(保存链路三段消费)

    /// original 有而 entries 无的 remote id,按 original 序(保存第一段:逐张 DELETE)。
    var pendingRemovals: [String] {
        let keptRemoteIds = Set(entries.compactMap { entry -> String? in
            if case .remote(let meta) = entry { return meta.id }
            return nil
        })
        return original.map(\.id).filter { !keptRemoteIds.contains($0) }
    }

    /// entries 中的 local 草稿,按 entries 序(保存第二段:逐张上传)。
    var pendingAdditions: [LocalPhotoDraft] {
        entries.compactMap { entry -> LocalPhotoDraft? in
            if case .local(let draft) = entry { return draft }
            return nil
        }
    }

    /// entries 的 id 序是否偏离「自然序」=original 剔除 removals + additions 按 entries 序追加,
    /// 即服务器执行完删/增后自动形成的顺序;不等才需要发 PUT(保存第三段)。
    var reorderNeeded: Bool {
        let entryIds = entries.map(\.id)
        let keptIds = Set(entryIds)
        let naturalOrder = original.map(\.id).filter { keptIds.contains($0) }
            + pendingAdditions.map(\.id.uuidString)
        return entryIds != naturalOrder
    }

    var hasChanges: Bool {
        !pendingRemovals.isEmpty || !pendingAdditions.isEmpty || reorderNeeded
    }

    var count: Int { entries.count }

    /// 剩余可加张数(上限 9,下限 0)。
    var remainingQuota: Int { max(0, 9 - count) }

    // MARK: - 进度固化(部分失败重试的正确性)

    /// DELETE 成功后调用:从 original 摘除,重试不再重复 DELETE。
    mutating func markRemoved(id: String) {
        original.removeAll { $0.id == id }
    }

    /// 上传成功后调用:entries 内 local 原位替换成 remote,original 末尾追加(服务器实际是追加)。
    mutating func markUploaded(draftId: UUID, meta: FootprintPhotoMeta) {
        guard let index = entries.firstIndex(where: { entry in
            if case .local(let draft) = entry { return draft.id == draftId }
            return false
        }) else { return }
        entries[index] = .remote(meta)
        original.append(meta)
    }

    /// 坏图(上传被拒/数据损坏)跳过:从 entries 剔除。
    mutating func markSkipped(draftId: UUID) {
        entries.removeAll { entry in
            if case .local(let draft) = entry { return draft.id == draftId }
            return false
        }
    }

    /// entries 全为 remote 时返回 id 排列(PUT 排序的 body);仍有 local 时返回 nil,不许发 PUT。
    var finalPhotoIds: [String]? {
        var ids: [String] = []
        for entry in entries {
            guard case .remote(let meta) = entry else { return nil }
            ids.append(meta.id)
        }
        return ids
    }
}
