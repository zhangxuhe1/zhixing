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
            // 登出/会话失效的统一清理点：所有"用户私有数据 store"都必须在这里 reset（§5.1 防跨账号泄露）。
            // PinsCache 不在此列并非遗漏：它缓存的是 `GET /places/pins`——无鉴权、与登录用户无关的
            // 公共地点数据（同一份数据登录前/登录后/换号后都一样），保留跨账号复用没有泄露风险，
            // 清掉反而白白让下一个账号重新拉一遍网络（违背该 store 本身"收敛重复请求"的目的）。
            // 复核一遍其余 store：SessionStore 自身在 signOut() 里清；RemoteConfig 是无鉴权公共配置
            // （同 PinsCache 不涉及用户身份，理由同上）；ViewTracker 只是进程内浏览打点去重 Set，不
            // 持有任何可读内容，换号后至多让一次重复浏览漏打点，不构成隐私泄露。截至 I10 没有新增
            // 遗漏的私有 store。
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
