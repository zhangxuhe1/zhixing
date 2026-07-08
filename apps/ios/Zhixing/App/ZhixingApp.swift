import SwiftUI

@main
struct ZhixingApp: App {
    @State private var session = SessionStore()
    @State private var footprints = FootprintStore()
    @State private var favorites = FavoritesStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(footprints)
                .environment(favorites)
        }
    }
}
