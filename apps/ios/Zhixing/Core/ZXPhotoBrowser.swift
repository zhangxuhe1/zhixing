import SwiftUI

/// 全屏照片浏览器：TabView 分页、黑底、右上角关闭。photoIds 顺序由调用方保证，本视图不重排。
/// 由 PhotoWallSection 私有的 PhotoWallBrowser 泛化而来：底部操作区经 bottomBar 注入
///（照片墙注入跳转故事的业务按钮；足迹详情无底栏走 EmptyView 便捷构造——
/// 组件源码不得出现具体业务文案，FootprintDetailTests 有断言）。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
struct ZXPhotoBrowser<BottomBar: View>: View {
    let photoIds: [String]
    let onClose: () -> Void
    @ViewBuilder let bottomBar: (Int) -> BottomBar

    @State private var selection: Int

    init(
        photoIds: [String], startIndex: Int, onClose: @escaping () -> Void,
        @ViewBuilder bottomBar: @escaping (Int) -> BottomBar
    ) {
        self.photoIds = photoIds
        self.onClose = onClose
        self.bottomBar = bottomBar
        _selection = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            TabView(selection: $selection) {
                // 页身份绑照片 id：AuthedPhotoView 的 @State 图片缓存跟随视图身份
                //（同 ZXPhotoThumbRow 的护栏理由）；photoIds 在浏览会话内不变，tag 用下标翻页。
                ForEach(Array(photoIds.enumerated()), id: \.element) { index, photoId in
                    AuthedPhotoView(photoId: photoId)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipped()
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color.black)
            .ignoresSafeArea()

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(.thinMaterial, in: Circle())
            }
            .accessibilityLabel("关闭")
            .padding()
        }
        .safeAreaInset(edge: .bottom) {
            bottomBar(selection)
        }
        .preferredColorScheme(.dark)
    }
}

extension ZXPhotoBrowser where BottomBar == EmptyView {
    /// 无底栏便捷构造（足迹详情用）。
    init(photoIds: [String], startIndex: Int, onClose: @escaping () -> Void) {
        self.init(photoIds: photoIds, startIndex: startIndex, onClose: onClose) { _ in EmptyView() }
    }
}
