import SwiftUI

@main
struct ZhixingApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 8) {
                Text("知行").font(.system(size: 48, weight: .bold))
                Text(AppConfig.apiBase.absoluteString).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
