import SwiftUI

/// 私密照片：先带登录态换 presigned URL，再取图（规格书 §5.1：不落公开可猜 URL）。
/// 渲染前先查全局内存缓存（ZXPhotoMemoryCache），命中直接出图；未命中走网络，
/// 解码经 downsampledImage 降采样（全分辨率 UIImage(data:) 内存无界，契约测试禁止回潮）,
/// 成功后写回缓存——一处下载全 App 复用,看图页开门即现。
struct AuthedPhotoView: View {
    let photoId: String
    @State private var state: LoadState<UIImage> = .idle

    var body: some View {
        Group {
            if let cached = ZXPhotoMemoryCache.shared.image(for: photoId) {
                Image(uiImage: cached).resizable().scaledToFill()
            } else {
                switch state {
                case .idle, .loading:
                    Rectangle().fill(.quaternary).overlay(ProgressView().controlSize(.small))
                case let .loaded(image):
                    Image(uiImage: image).resizable().scaledToFill()
                case .failed:
                    Button { Task { await load() } } label: {
                        Rectangle().fill(.quaternary)
                            .overlay(Image(systemName: "arrow.clockwise").foregroundStyle(.secondary))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .task {
            guard state.value == nil, ZXPhotoMemoryCache.shared.image(for: photoId) == nil else { return }
            await load()
        }
    }

    private func load() async {
        state = .loading
        do {
            let signed: PhotoURL = try await APIClient.shared.get("/photos/\(photoId)")
            guard let url = URL(string: signed.url) else {
                state = .failed("图片链接无效")
                return
            }
            // presigned URL 短时有效、字节本身是私密照片：走 ephemeral 会话，不落磁盘缓存（同 TripShareScreen）。
            let (data, _) = try await APIClient.photoSession.data(from: url)
            let maxPixelSize = ZXPhotoMemoryCache.displayMaxPixelSize()
            let image = await Task.detached(priority: .userInitiated) {
                downsampledImage(from: data, maxPixelSize: maxPixelSize)
            }.value
            guard let image else {
                state = .failed("图片解析失败")
                return
            }
            ZXPhotoMemoryCache.shared.insert(image, for: photoId)
            state = .loaded(image)
        } catch {
            state = .failed("图片加载失败")
        }
    }
}
