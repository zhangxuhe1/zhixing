import SwiftUI

@main
struct ZhixingApp: App {
    @State private var session = SessionStore()
    @State private var footprints = FootprintStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(footprints)
        }
    }
}
