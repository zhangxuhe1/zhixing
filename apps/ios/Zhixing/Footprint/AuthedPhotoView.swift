import SwiftUI

/// 私密照片：先带登录态换 presigned URL，再取图（规格书 §5.1：不落公开可猜 URL）
struct AuthedPhotoView: View {
    let photoId: String
    @State private var state: LoadState<UIImage> = .idle

    var body: some View {
        Group {
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
        .task {
            guard state.value == nil else { return } // 已成功缓存的图片不重复拉取
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
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let image = UIImage(data: data) else {
                state = .failed("图片解析失败")
                return
            }
            state = .loaded(image)
        } catch {
            state = .failed("图片加载失败")
        }
    }
}
