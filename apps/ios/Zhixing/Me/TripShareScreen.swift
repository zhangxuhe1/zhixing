import ImageIO
import SwiftUI

/// 旅程小结 · 分享长图：装配（拉取旅程成员足迹 → 城市名/摘录/照片/二维码）与出图
/// （`ImageRenderer` 把 `TripShareCard` 渲成一张 `UIImage`）分两段 `LoadState` 管理。
///
/// 装配段（`dataState`）的失败已经在各子步骤内部兜底——`RemoteConfig` 失败回退占位 URL、
/// 单张照片下载失败直接跳过——按规格设计上不会真正走到 `.failed`；`.failed` 分支仍然保留
/// （配合可重试文案），只是当前实现下是防御性的死路径，不作为需要覆盖的行为契约。
/// 出图段（`renderState`）才是唯一按规格会真正失败的环节（极端长内容下 `ImageRenderer`
/// 可能吐出 nil）：失败时保留已经装配好的数据，只重新触发渲染本身，不必重新走一遍网络。
struct TripShareScreen: View {
    let trip: Trip

    @Environment(FootprintStore.self) private var footprints
    @Environment(\.dismiss) private var dismiss

    @State private var dataState: LoadState<ShareCardData> = .idle
    @State private var renderState: LoadState<UIImage> = .idle

    /// ImageRenderer 内存上界之一（评审重点）：九宫格最多容纳的照片张数。
    private static let maxPhotos = 9
    /// 内存上界之二（评审修复）：单张照片解码后的最大长边像素。仓库上传路径存的是原图（24MP 级
    /// 解码位图近百 MB，9 张原图叠加 ImageRenderer 3x 主线程绘制足以触发 jetsam，进程直接被杀、
    /// 绕过"渲染失败可重试"兜底）。版式最大需求是单张通栏 342pt @3x ≈ 1026px，1200 留出裕量后
    /// 视觉零损失；9 张 1200px 位图约 50MB，安全。
    private static let photoMaxPixelSize: CGFloat = 1200
    private static let excerptCount = 3
    private static let excerptMaxLength = 60

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("分享")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { dismiss() }
                    }
                }
                .task { await assembleIfNeeded() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch dataState {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            statusView(message: message) { Task { await assembleIfNeeded(force: true) } }
        case .loaded:
            switch renderState {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                statusView(message: message, retry: retryRender)
            case let .loaded(image):
                previewView(image)
            }
        }
    }

    private func statusView(message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: 12) {
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("重试", action: retry).buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
    }

    private func previewView(_ image: UIImage) -> some View {
        ScrollView {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
                .padding()
                .shadow(radius: 8)
        }
        .safeAreaInset(edge: .bottom) {
            ShareLink(
                item: Image(uiImage: image),
                preview: SharePreview(trip.title, image: Image(uiImage: image))
            ) {
                Label("分享", systemImage: "square.and.arrow.up")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .padding()
            .background(.ultraThinMaterial)
        }
    }

    // MARK: - 装配

    private func assembleIfNeeded(force: Bool = false) async {
        guard force || dataState.value == nil else { return }
        dataState = .loading
        renderState = .idle

        await RemoteConfig.shared.load()

        let members = footprints.footprints.filter { $0.tripId == trip.id }
        let cityNames = dedupPreservingOrder(members.map(\.place.name))
        let excerpts = firstNonEmptyExcerpts(
            members.map { $0.text ?? "" }, limit: Self.excerptCount, maxLength: Self.excerptMaxLength)
        let photoRefs = topPhotoRefs(members, limit: Self.maxPhotos)
        let images = await downloadAllSkippingFailures(photoRefs.map(\.id), download: downloadPhoto)

        let data = ShareCardData(
            title: trip.title,
            dateRange: tripDateRange(trip.startDate, trip.endDate),
            cityNames: cityNames,
            excerpts: excerpts,
            photos: images,
            qr: qrImage(from: RemoteConfig.shared.shareLandingUrl, side: 200))
        dataState = .loaded(data)
        render(data)
    }

    /// 单张失败直接跳过、不阻塞整体装配：任何一步出错（presign 失败、URL 非法、字节下载失败、
    /// 解码失败）都归一处理成"这张不要了"，调用方看到的只是最终 `images` 数组少一张。
    /// 落地为 UIImage 前必须经 `downsampledImage` 降采样（评审修复）——不走 `UIImage(data:)`，
    /// 那会保留原图分辨率，内存上界见 `photoMaxPixelSize` 注释。
    private func downloadPhoto(_ photoId: String) async -> UIImage? {
        do {
            let signed: PhotoURL = try await APIClient.shared.get("/photos/\(photoId)")
            guard let url = URL(string: signed.url) else { return nil }
            let (bytes, _) = try await APIClient.photoSession.data(from: url)
            return downsampledImage(from: bytes, maxPixelSize: Self.photoMaxPixelSize)
        } catch {
            return nil
        }
    }

    // MARK: - 出图

    private func retryRender() {
        guard case let .loaded(data) = dataState else { return }
        render(data)
    }

    private func render(_ data: ShareCardData) {
        renderState = .loading
        let card = TripShareCard(
            title: data.title, dateRange: data.dateRange, cityNames: data.cityNames,
            excerpts: data.excerpts, photos: data.photos, qr: data.qr)
        let renderer = ImageRenderer(content: card)
        renderer.scale = 3
        guard let image = renderer.uiImage else {
            renderState = .failed("长图生成失败，请重试")
            return
        }
        renderState = .loaded(image)
    }
}

/// 装配阶段产出的中间数据：TripShareCard 的输入 + 已经算好的日期范围文案。私有于本文件，
/// 不是公开模型——它只是"这次分享要渲染什么"的一次性快照，不需要 Codable/持久化。
private struct ShareCardData {
    let title: String
    let dateRange: String
    let cityNames: [String]
    let excerpts: [String]
    let photos: [UIImage]
    let qr: UIImage?
}

// MARK: - 纯函数（可单测，见 TripShareAssemblyTests）

/// 城市名去重保序：同一地点在多段足迹里重复出现只展示一次，保留调用方传入列表里首次出现的顺序。
/// `GET /me/footprints` 按 `date desc` 返回、FootprintStore 保持该顺序不重排，所以这里的
/// "首次出现"实际就是"时间最近的一次"——与 `topPhotoRefs` 的排序目标一致，只是不需要专门再排序。
func dedupPreservingOrder(_ names: [String]) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for name in names where !seen.contains(name) {
        seen.insert(name)
        result.append(name)
    }
    return result
}

/// 摘录：取前 `limit` 条非空文字，各自截断到 `maxLength` 个字符（Swift `Character` 计数——
/// 中文按"字"而非 UTF-8 字节切，避免多字节字符被腰斩）。沿用调用方传入的原始顺序，不额外排序
/// （道理同 `dedupPreservingOrder`：FootprintStore 已经是 date desc）。
func firstNonEmptyExcerpts(_ texts: [String], limit: Int, maxLength: Int) -> [String] {
    var result: [String] = []
    for text in texts {
        guard !text.isEmpty else { continue }
        result.append(String(text.prefix(maxLength)))
        if result.count == limit { break }
    }
    return result
}

/// 分享长图照片选取：按足迹日期倒序（规格原文——与 `dedupPreservingOrder`/`firstNonEmptyExcerpts`
/// 沿用列表原序不同，这里分享图明确要优先展示旅程里最新的画面，因此显式重排，不依赖调用方
/// 传入的顺序），拍平每段足迹自身的照片顺序不变，累计满 `limit` 张立即停止。
/// `limit` 同时是 ImageRenderer 的内存安全上界（评审重点）。
func topPhotoRefs(_ footprints: [Footprint], limit: Int) -> [FootprintPhotoMeta] {
    var result: [FootprintPhotoMeta] = []
    for footprint in footprints.sorted(by: { $0.date > $1.date }) {
        for photo in footprint.photos {
            result.append(photo)
            if result.count == limit { return result }
        }
    }
    return result
}

/// 顺序尝试下载每个 id：单个 `download` 返回 nil（失败）直接跳过、不中断后续，也不整体失败——
/// 返回的图片数组可能比 `ids` 短，长度差即为失败张数，调用方（`TripShareScreen`）不需要另行
/// 感知哪几张失败了。抽成注入 `download` 闭包的独立函数是为了不依赖真实网络就能单测"跳过而不
/// 阻塞、保序"这条行为（对齐 FavoritesStore/ViewTracker 的测试缝写法）。
func downloadAllSkippingFailures(_ ids: [String], download: (String) async -> UIImage?) async -> [UIImage] {
    var images: [UIImage] = []
    for id in ids {
        if let image = await download(id) {
            images.append(image)
        }
    }
    return images
}

/// 字节 → 降采样 UIImage（评审修复：≤9 只封张数，这里封每张的像素）：长边超过 `maxPixelSize`
/// 的图缩到恰好 `maxPixelSize`，不足的保持原尺寸（不放大）；解不出图（损坏/非图字节）返回 nil。
/// 用 ImageIO 的 `CGImageSourceCreateThumbnailAtIndex` 而非 `UIImage(data:)` 后再缩——前者按目标
/// 尺寸直接解码，全程不产生原始分辨率位图（24MP 原图的全尺寸解码近百 MB，正是要规避的东西）；
/// `kCGImageSourceCreateThumbnailWithTransform` 让 EXIF 方向在解码时一并烘进像素，竖拍照片不横躺。
func downsampledImage(from data: Data, maxPixelSize: CGFloat) -> UIImage? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
    let thumbnailOptions = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
    ] as CFDictionary
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else { return nil }
    return UIImage(cgImage: cgImage)
}
