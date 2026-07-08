import Foundation
import Observation

/// 分享长图二维码的落地页地址：来自 `GET /app-config`（S7，无鉴权）。以"一次 App 运行"为一个会话——
/// 本次运行内只真正请求一次，结果（无论成功还是失败回退）在会话剩余时间里保持不变，避免用户反复
/// 打开分享页时重复发起请求；下次冷启动会重新请求一次。这是对规格"会话内缓存"字面语义的选择：
/// 以"请求过一次"为界，而非"成功过一次"为界——后者会在服务端持续故障时让每次打开分享页都
/// 多打一次必然失败的请求，前者则退化成"这次运行认命用占位值"，更省心也更可预期。
@MainActor
@Observable
final class RemoteConfig {
    static let shared = RemoteConfig()

    /// `GET /app-config` 不可达时的内置兜底：保证二维码永远指向一个语法合法的地址，不会因为
    /// 配置接口故障就让分享长图的二维码位置整块留白或在生成阶段崩溃。
    static let placeholderShareLandingUrl = "https://zhixing.app/share"

    private(set) var shareLandingUrl: String = RemoteConfig.placeholderShareLandingUrl
    private var hasAttemptedLoad = false

    private let fetchConfig: () async throws -> RemoteAppConfig

    /// 测试缝：注入假 fetchConfig 闭包，验证成功写入 / 失败回退 / 会话内不重复请求三条路径时
    /// 不发真实网络请求（对齐 FavoritesStore/ViewTracker 的既有测试缝写法）。
    init(fetchConfig: @escaping () async throws -> RemoteAppConfig = {
        try await APIClient.shared.get("/app-config")
    }) {
        self.fetchConfig = fetchConfig
    }

    /// 幂等：同一实例内第二次起调用直接返回，不重复请求（无论首次是成功写入还是失败回退）。
    func load() async {
        guard !hasAttemptedLoad else { return }
        hasAttemptedLoad = true
        if let config = try? await fetchConfig() {
            shareLandingUrl = config.shareLandingUrl
        }
    }
}
