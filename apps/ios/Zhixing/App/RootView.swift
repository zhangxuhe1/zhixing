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

// Task 4 / Task 8 会用真实实现替换这两个占位
struct MapScreen: View {
    var body: some View { Text("地图（Task 4）") }
}

struct MeScreen: View {
    var body: some View { Text("我的（Task 8）") }
}
