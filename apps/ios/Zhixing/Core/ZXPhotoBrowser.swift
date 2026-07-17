import SwiftUI

/// 全屏照片浏览器：TabView 分页、黑底。photoIds 顺序由调用方保证，本视图不重排。
/// 由 PhotoWallSection 私有的 PhotoWallBrowser 泛化而来：底部操作区经 bottomBar 注入
///（照片墙注入跳转故事的业务按钮；足迹详情无底栏走 EmptyView 便捷构造——
/// 组件源码不得出现具体业务文案，FootprintDetailTests 有断言）。
/// 操控件（关闭 + 左右切换）统一黑底白图标圆钮；Catalyst 上由两侧/右上热区悬停显隐
///（对标原生 Mac 应用惯例，开场短暂亮相保证可发现性），触屏端常显、不挡滑动手势。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
///（操控件追记：docs/superpowers/specs/2026-07-17-photo-grid-design.md）
struct ZXPhotoBrowser<BottomBar: View>: View {
    let photoIds: [String]
    let onClose: () -> Void
    @ViewBuilder let bottomBar: (Int) -> BottomBar

    @State private var selection: Int
    // Mac 悬停显隐三热区各自的状态；chromeIntro 是开场亮相期（先亮相再淡出，教会用户按钮在哪）。
    @State private var chromeIntro = true
    @State private var hoverPrev = false
    @State private var hoverNext = false
    @State private var hoverClose = false

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
        pager
            .preferredColorScheme(.dark)
            .task {
                // 开场亮相 1.5s 后交给悬停驱动；触屏端 chromeOpacity 恒为 1，无需计时。
                guard Self.hoverDriven else { return }
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation(.easeOut(duration: 0.4)) { chromeIntro = false }
            }
    }

    /// BottomBar 为 EmptyView（足迹/故事详情的无底栏便捷构造）时绝不能装 safeAreaInset：
    /// 内容解析为空视图的 safeAreaInset 会给主内容提案 0 高并顶对齐（iOS 与 Catalyst 皆然，
    /// 几何探针实证），操控件全被压成顶部一条——照片仍满屏纯靠 TabView 宿主视图溢出绘制。
    @ViewBuilder private var pager: some View {
        if BottomBar.self == EmptyView.self {
            core
        } else {
            core.safeAreaInset(edge: .bottom) { bottomBar(selection) }
        }
    }

    private var core: some View {
        ZStack {
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

            navChrome
        }
        .overlay(alignment: .topTrailing) { closeChrome }
    }

    /// 悬停显隐仅在有指针的 Catalyst 端启用；触屏没有 hover，常显是唯一正解。
    nonisolated static var hoverDriven: Bool {
        #if targetEnvironment(macCatalyst)
        true
        #else
        false
        #endif
    }

    private func chromeOpacity(hovered: Bool) -> Double {
        guard Self.hoverDriven else { return 1 }
        return (chromeIntro || hovered) ? 1 : 0
    }

    /// 左右切换：首页藏左钮、末页藏右钮（顺带当边界提示），单张两钮都不出现。
    @ViewBuilder private var navChrome: some View {
        #if targetEnvironment(macCatalyst)
        HStack(spacing: 0) {
            // 热区是叠在 TabView 上的透明命中层，会吃掉区内的拖拽翻页——鼠标场景可接受
            //（按钮点按与中部拖拽仍在）；触屏分支不渲染热区，不挡边缘滑动。
            hoverBand(hovered: $hoverPrev, alignment: .leading) {
                if selection > 0 { prevButton.opacity(chromeOpacity(hovered: hoverPrev)) }
            }
            Spacer(minLength: 0)
            hoverBand(hovered: $hoverNext, alignment: .trailing) {
                if selection < photoIds.count - 1 { nextButton.opacity(chromeOpacity(hovered: hoverNext)) }
            }
        }
        #else
        HStack {
            if selection > 0 { prevButton }
            Spacer(minLength: 0)
            if selection < photoIds.count - 1 { nextButton }
        }
        .padding(.horizontal, 12)
        #endif
    }

    @ViewBuilder private var closeChrome: some View {
        #if targetEnvironment(macCatalyst)
        Color.clear
            .frame(width: 120, height: 100)
            .overlay(alignment: .topTrailing) {
                closeButton.opacity(chromeOpacity(hovered: hoverClose)).padding()
            }
            .contentShape(Rectangle())
            .onHover { hoverClose = $0 }
            .animation(.easeInOut(duration: 0.15), value: hoverClose)
        #else
        closeButton.padding()
        #endif
    }

    private var prevButton: some View {
        chromeButton(icon: "chevron.left", label: "上一张") {
            withAnimation(.easeInOut(duration: 0.2)) { selection -= 1 }
        }
    }

    private var nextButton: some View {
        chromeButton(icon: "chevron.right", label: "下一张") {
            withAnimation(.easeInOut(duration: 0.2)) { selection += 1 }
        }
    }

    private var closeButton: some View {
        chromeButton(icon: "xmark", label: "关闭", action: onClose)
    }

    /// 三枚操控件统一语言：黑色半透明圆底 + 白色图标 + 细白描边——黑底照片上对比稳定
    ///（旧 thinMaterial 圆钮会融进照片，用户走查反馈弃用）。
    private func chromeButton(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(.black.opacity(0.45)))
                .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    #if targetEnvironment(macCatalyst)
    /// 120pt 宽全高热区：悬停出钮、移开即隐。
    private func hoverBand<Z: View>(
        hovered: Binding<Bool>, alignment: Alignment, @ViewBuilder content: () -> Z
    ) -> some View {
        Color.clear
            .frame(width: 120)
            .overlay(alignment: alignment) { content().padding(.horizontal, 12) }
            .contentShape(Rectangle())
            .onHover { hovered.wrappedValue = $0 }
            .animation(.easeInOut(duration: 0.15), value: hovered.wrappedValue)
    }
    #endif
}

extension ZXPhotoBrowser where BottomBar == EmptyView {
    /// 无底栏便捷构造（足迹详情用）。
    init(photoIds: [String], startIndex: Int, onClose: @escaping () -> Void) {
        self.init(photoIds: photoIds, startIndex: startIndex, onClose: onClose) { _ in EmptyView() }
    }
}
