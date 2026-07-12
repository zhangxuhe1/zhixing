import SwiftUI
#if targetEnvironment(macCatalyst)
import UIKit
#endif

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
                #if targetEnvironment(macCatalyst)
                .onAppear { Self.applyWindowSizeRestrictions() }
                #endif
        }
    }

    #if targetEnvironment(macCatalyst)
    /// 最小 1000×700：防止 Mac 窗口被拖成手机条状导致地图不可用（最小桌面适配，见
    /// docs/superpowers/specs/2026-07-12-mac-catalyst-dmg-design.md 第二节）
    private static func applyWindowSizeRestrictions() {
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.sizeRestrictions?.minimumSize =
                CGSize(width: 1000, height: 700)
        }
    }
    #endif
}
