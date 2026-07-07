import SwiftUI

/// 私密照片：先带登录态换 presigned URL，再取图（规格书 §5.1：不落公开可猜 URL）
struct AuthedPhotoView: View {
    let photoId: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Rectangle().fill(.quaternary).overlay(ProgressView().controlSize(.small))
            }
        }
        .task {
            guard image == nil else { return }
            guard let signed: PhotoURL = try? await APIClient.shared.get("/photos/\(photoId)"),
                  let url = URL(string: signed.url),
                  let (data, _) = try? await URLSession.shared.data(from: url) else { return }
            image = UIImage(data: data)
        }
    }
}
