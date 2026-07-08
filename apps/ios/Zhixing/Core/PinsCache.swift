import Foundation
import Observation

/// 地点 pin 列表的进程内共享缓存：MapScreen/MyMapScreen/AlbumImportScreen 三处此前各自独立
/// `GET /places/pins`，同一次前台会话里对同一份（近乎静态的）数据重复拉三遍。收敛成单例通过
/// `.environment()` 注入，`load()` 命中缓存就直接返回，避免重复网络往返。
///
/// 失败态刻意不在这里存（不是 `LoadState<[Pin]>`）：`load()` throws，由三个调用方各自的界面惯例
/// 决定失败怎么展示（MyMapScreen/AlbumImportScreen 走 LoadStateView；MapScreen 走既有的
/// `loadError` 文案条）——本缓存只负责"要不要真的发网络请求"，不越权决定失败 UI。
@MainActor
@Observable
final class PinsCache {
    private(set) var pins: [Pin] = []
    private var hasLoaded = false

    /// force=false 且已有数据：直接返回，不发请求。force=true（或从未成功过）：真的去拉一次。
    /// 失败时不清空既有 `pins`（保留上一次的成功结果），只是不翻转 `hasLoaded`，方便下次重试。
    /// 两个调用方几乎同时首次 load()（如冷启动瞬间 tab 预取）理论上都可能在守卫处通过、各发一次
    /// 请求——MainActor 序列化写入，最坏结果只是一次冗余 GET，不是数据错误，不为此再加 in-flight
    /// 去重（同 RemoteConfig.load 的既有取舍）。
    func load(force: Bool = false) async throws {
        if !force, hasLoaded { return }
        let fetched: [Pin] = try await APIClient.shared.get("/places/pins")
        pins = fetched
        hasLoaded = true
    }
}
