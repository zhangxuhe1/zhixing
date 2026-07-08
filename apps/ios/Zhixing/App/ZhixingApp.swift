import SwiftUI

@main
struct ZhixingApp: App {
    @State private var session = SessionStore()
    @State private var footprints = FootprintStore()
    @State private var favorites = FavoritesStore()
    @State private var pinsCache = PinsCache()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(footprints)
                .environment(favorites)
                .environment(pinsCache)
        }
    }
}
