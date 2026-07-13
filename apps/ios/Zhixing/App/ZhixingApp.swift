import SwiftUI
#if targetEnvironment(macCatalyst)
import UIKit
#endif

@main
struct ZhixingApp: App {
    // store 实例统一收敛在 AppStores（Catalyst 模态环境断链问题，见其文件头注释），
    // 这里不再用 @State 持有——static 常量同样保证生命周期，@Observable 观察不受影响。
    var body: some Scene {
        WindowGroup {
            RootView()
                .appStores()
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
