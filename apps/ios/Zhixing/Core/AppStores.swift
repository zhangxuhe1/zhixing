import SwiftUI

/// App 级共享 store 的唯一实例来源。
///
/// 为什么存在：Mac Catalyst 下 sheet/fullScreenCover 的宿主控制器不继承 WindowGroup
/// 上注入的环境对象，模态根视图里的 `@Environment(FootprintStore.self)` 会直接
/// "No Observable object" 崩溃（iOS 上继承正常，问题只在 Catalyst 暴露）。
/// 实例收敛到这里后，根视图与所有模态视图统一走 `.appStores()` 注入，
/// 保证拿到的是同一批实例——各注一批新实例只会把崩溃换成更隐蔽的数据不同步。
@MainActor
enum AppStores {
    static let session = SessionStore()
    static let footprints = FootprintStore()
    static let favorites = FavoritesStore()
    static let pinsCache = PinsCache()
}

extension View {
    /// 注入全套应用级 store。WindowGroup 根视图和**每一处** sheet/fullScreenCover/popover
    /// 的内容根视图都必须挂它；新增模态入口漏挂会在 Catalyst 上崩溃退出
    /// （回归守卫见 Tests/ModalEnvironmentTests.swift 的源码扫描断言）。
    func appStores() -> some View {
        environment(AppStores.session)
            .environment(AppStores.footprints)
            .environment(AppStores.favorites)
            .environment(AppStores.pinsCache)
            // Catalyst 会把模态 NavigationStack 的 navigationTitle 提升成窗口标题；
            // 页面里已有完整品牌标识，统一隐藏系统标题，避免在红绿灯旁重复显示。
            .onAppear { CatalystWindowTitle.hide() }
            .onDisappear { CatalystWindowTitle.hide() }
    }
}

@MainActor
private enum CatalystWindowTitle {
    static func hide() {
        #if targetEnvironment(macCatalyst)
        DispatchQueue.main.async {
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                scene.titlebar?.titleVisibility = .hidden
            }
        }
        #endif
    }
}
