import UIKit

/// 全局照片内存缓存:photoId → 降采样位图,一处下载全 App 复用——宫格看过的照片
/// 点开全屏第一帧即图(根治首开黑闪),重复下载消失。photoId 内容不可变(API 只有
/// 新建与 presign 读取,无改写端点),按 id 缓存无需失效钩子。NSCache 自带线程安全、
/// cost 封顶与内存压力清退;纯内存不落盘(私密照片约束,规格书 §5.1),退出即消失。
/// 设计:docs/superpowers/specs/2026-07-17-photo-memory-cache-design.md
// @unchecked Sendable 的依据:唯一状态是 NSCache,其读写线程安全是 Apple 文档承诺。
final class ZXPhotoMemoryCache: @unchecked Sendable {
    static let shared = ZXPhotoMemoryCache()

    private let cache = NSCache<NSString, UIImage>()

    private init() {
        // Catalyst 内存宽裕给 200MB,iPhone 收紧到 120MB;超限与内存压力由 NSCache 自动清退
        #if targetEnvironment(macCatalyst)
        cache.totalCostLimit = 200 * 1024 * 1024
        #else
        cache.totalCostLimit = 120 * 1024 * 1024
        #endif
    }

    func image(for photoId: String) -> UIImage? {
        cache.object(forKey: photoId as NSString)
    }

    func insert(_ image: UIImage, for photoId: String) {
        // cost 按解码位图字节估算:超限时 NSCache 按 cost 淘汰
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        cache.setObject(image, forKey: photoId as NSString, cost: cost)
    }

    func removeAll() {
        cache.removeAllObjects()
    }

    /// 全 App 统一的解码目标尺寸:主屏长边×scale,夹在 [2048, 4096]——一份位图服务
    /// 宫格与看图页;上限防 5K 全屏内存失控,下限保常规窗口清晰。
    @MainActor static func displayMaxPixelSize() -> CGFloat {
        let bounds = UIScreen.main.bounds
        let longest = max(bounds.width, bounds.height) * UIScreen.main.scale
        return min(max(longest, 2048), 4096)
    }
}
