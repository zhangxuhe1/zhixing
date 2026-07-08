import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(FootprintStore.self) private var footprints
    @Environment(FavoritesStore.self) private var favorites

    var body: some View {
        Group {
            if session.restoring {
                ProgressView()
            } else if session.isSignedIn {
                MainTabView()
            } else {
                SignInScreen()
            }
        }
        .task { await session.restore() }
        .onChange(of: session.isSignedIn) { _, signedIn in
            // 登出/会话失效的统一清理点：所有"用户私有数据 store"都必须在这里 reset（§5.1 防跨账号泄露）
            if !signedIn {
                footprints.reset()
                favorites.reset()
            }
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            MapScreen().tabItem { Label("地图", systemImage: "map.fill") }
            MeScreen().tabItem { Label("我的", systemImage: "person.fill") }
        }
    }
}
