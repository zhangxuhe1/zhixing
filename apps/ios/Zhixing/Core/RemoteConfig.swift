import Foundation
import Observation

/// 分享长图二维码的落地页地址：来自 `GET /app-config`（S7，无鉴权）。"会话内缓存"只缓存**成功**：
/// 首次成功取到服务端值后，本次 App 运行内不再重复请求；失败（含 sheet 秒关触发的取消——`try?`
/// 连 CancellationError 一并吞掉）不置位，下次打开分享页自然重试。不能以"请求过一次"为界——
/// 二维码会被烙进用户保存/转发的长图里，内容寿命远超本次会话，一次瞬时网络故障不该把占位 URL
/// 焊死到之后每一张分享图上（评审修复）。
@MainActor
@Observable
final class RemoteConfig {
    static let shared = RemoteConfig()

    /// `GET /app-config` 不可达时的内置兜底：保证二维码永远指向一个语法合法的地址，不会因为
    /// 配置接口故障就让分享长图的二维码位置整块留白或在生成阶段崩溃。
    static let placeholderShareLandingUrl = "https://zhixing.app/share"

    private(set) var shareLandingUrl: String = RemoteConfig.placeholderShareLandingUrl
    private var hasLoaded = false

    private let fetchConfig: () async throws -> RemoteAppConfig

    /// 测试缝：注入假 fetchConfig 闭包，验证成功写入 / 失败回退且下次重试 / 成功后不重复请求
    /// 三条路径时不发真实网络请求（对齐 FavoritesStore/ViewTracker 的既有测试缝写法）。
    init(fetchConfig: @escaping () async throws -> RemoteAppConfig = {
        try await APIClient.shared.get("/app-config")
    }) {
        self.fetchConfig = fetchConfig
    }

    /// 成功一次后幂等；失败保持"未加载"，下次调用重试。守卫在 await 之前、置位在成功分支——
    /// 两次并发 load() 理论上可能都通过守卫、各发一次请求（MainActor 上 await 点可交错），
    /// 最坏结果只是一次冗余 GET 且两次写入同一服务端值，不为此再加 in-flight 去重。
    func load() async {
        guard !hasLoaded else { return }
        if let config = try? await fetchConfig() {
            shareLandingUrl = config.shareLandingUrl
            hasLoaded = true
        }
    }
}
