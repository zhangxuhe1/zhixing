import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session

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
