import SafariServices
import SwiftUI

/// 地点抽屉「网友攻略」区块:管理员维护的外部平台链接列表。
/// iOS 用 SFSafariViewController 应用内打开;Catalyst 交给系统默认浏览器。
struct PlaceLinksSection: View {
    let links: [PlaceLink]
    @State private var safariURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("网友攻略", systemImage: "link")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ZXTheme.pine)
            ForEach(links) { link in
                Button {
                    open(link)
                } label: {
                    HStack(spacing: 12) {
                        Text(link.platformLabel)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .foregroundStyle(.white)
                            .background(ZXTheme.cinnabar, in: Capsule())
                        Text(link.title)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .zxSurface(radius: 14, padding: 13)
                }
                .buttonStyle(.plain)
                .accessibilityHint("在浏览器中打开")
            }
        }
        #if !targetEnvironment(macCatalyst)
        .sheet(item: Binding(
            get: { safariURL.map(SafariItem.init) },
            set: { if $0 == nil { safariURL = nil } }
        )) { item in
            SafariView(url: item.url).ignoresSafeArea().appStores()
        }
        #endif
    }

    private func open(_ link: PlaceLink) {
        guard let url = URL(string: link.url), url.scheme == "https" else { return }
        #if targetEnvironment(macCatalyst)
        UIApplication.shared.open(url) // Catalyst → 系统默认浏览器
        #else
        safariURL = url
        #endif
    }
}

#if !targetEnvironment(macCatalyst)
private struct SafariItem: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
#endif
