import SwiftUI
import UIKit

/// 看图页会话级照片加载器:邻页预载 + 内存内降采样缓存,让翻页永远"图换图"瞬切
///(对标 Preview/Photos 的预解码机制)。窗口 [i, i±1, i±2]、缓存上限即窗口大小,
/// 窗口外淘汰、在途取消;仅内存、不落盘(私密照片约束,规格书 §5.1),随看图页
/// @State 释放。取数闭包注入,逻辑可无网络单测(BrowserPhotoLoaderTests)。
/// 设计:docs/superpowers/specs/2026-07-17-photo-browser-preload-design.md
@MainActor @Observable
final class ZXBrowserPhotoLoader {
    private(set) var images: [String: UIImage] = [:]
    private(set) var failed: Set<String> = []
    private var inflight: [String: Task<Void, Never>] = [:]

    private let photoIds: [String]
    private let fetch: @Sendable (String) async throws -> Data
    /// 0 = 首次加载时按主屏推导(nonisolated init 里够不到 UIScreen)。
    private let maxPixelSizeOverride: CGFloat

    nonisolated init(
        photoIds: [String],
        fetch: @escaping @Sendable (String) async throws -> Data = ZXBrowserPhotoLoader.defaultFetch,
        maxPixelSize: CGFloat = 0
    ) {
        self.photoIds = photoIds
        self.fetch = fetch
        self.maxPixelSizeOverride = maxPixelSize
    }

    /// 预载优先级序:[i, i+1, i-1, i+2, i-2] 截断越界(先夹 index 再展开);纯函数可单测。
    nonisolated static func prefetchWindow(around index: Int, count: Int) -> [Int] {
        guard count > 0 else { return [] }
        let clamped = min(max(index, 0), count - 1)
        return [clamped, clamped + 1, clamped - 1, clamped + 2, clamped - 2]
            .filter { (0..<count).contains($0) }
    }

    /// 翻到第 index 页:补齐窗口内缺失项;窗口外缓存淘汰、在途取消(缓存上限=窗口)。
    func focus(_ index: Int) {
        let window = Self.prefetchWindow(around: index, count: photoIds.count)
        let wanted = Set(window.map { photoIds[$0] })
        for id in images.keys where !wanted.contains(id) { images[id] = nil }
        for (id, task) in inflight where !wanted.contains(id) {
            task.cancel()
            inflight[id] = nil
        }
        for i in window { load(photoIds[i]) }
    }

    /// 失败页重试入口(页内重试按钮调用)。
    func retry(_ photoId: String) {
        failed.remove(photoId)
        load(photoId)
    }

    private func load(_ photoId: String) {
        guard images[photoId] == nil, inflight[photoId] == nil, !failed.contains(photoId) else { return }
        let fetch = self.fetch
        let maxPixelSize = maxPixelSizeOverride > 0 ? maxPixelSizeOverride : Self.screenMaxPixelSize()
        inflight[photoId] = Task {
            var image: UIImage?
            do {
                let data = try await fetch(photoId)
                // 降采样解码丢后台:全程不产生原始分辨率位图,也不在主线程扎堆
                image = await Task.detached(priority: .userInitiated) {
                    downsampledImage(from: data, maxPixelSize: maxPixelSize)
                }.value
            } catch {
                image = nil
            }
            inflight[photoId] = nil
            // 滑窗取消的任务不得把人家误记失败
            guard !Task.isCancelled else { return }
            if let image {
                images[photoId] = image
            } else {
                failed.insert(photoId)
            }
        }
    }

    /// 默认取数:presign 换短时 URL 再取字节,与私密照片视图同链路,不落磁盘缓存。
    nonisolated static func defaultFetch(_ photoId: String) async throws -> Data {
        let signed: PhotoURL = try await APIClient.shared.get("/photos/\(photoId)")
        guard let url = URL(string: signed.url) else { throw URLError(.badURL) }
        let (data, _) = try await APIClient.photoSession.data(from: url)
        return data
    }

    /// 解码目标:主屏长边×scale,夹在 [2048, 4096]——上限防 5K 全屏内存失控,下限保常规窗口清晰。
    private static func screenMaxPixelSize() -> CGFloat {
        let bounds = UIScreen.main.bounds
        let longest = max(bounds.width, bounds.height) * UIScreen.main.scale
        return min(max(longest, 2048), 4096)
    }
}
