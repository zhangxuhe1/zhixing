import Foundation

/// 浏览打点会话去重器：同一 app 会话（进程存活期，纯内存、不跨启动持久化）内，
/// 同一 footprintId 至多触发一次 `POST /footprints/:id/view`。
/// 打点失败静默——这是 M2 计划里唯一明确允许静默吞错的路径（不打扰用户，不重试，不提示）。
@MainActor
final class ViewTracker {
    static let shared = ViewTracker(send: { id in
        try? await APIClient.shared.post("/footprints/\(id)/view")
    })

    private let send: (String) async -> Void
    private var pingedFootprintIds: Set<String> = []

    /// 测试缝：注入 send 闭包，验证去重逻辑时不发真实网络请求。
    init(send: @escaping (String) async -> Void) {
        self.send = send
    }

    /// 去重判定同步完成，保证同一 id 的重复/连续调用里只有第一次会真正触发发送；
    /// 实际发送异步执行、不阻塞调用方，也不回传结果——调用方不需要、也不应该关心是否成功。
    func ping(footprintId: String) {
        guard !pingedFootprintIds.contains(footprintId) else { return }
        pingedFootprintIds.insert(footprintId)
        Task { await send(footprintId) }
    }
}
