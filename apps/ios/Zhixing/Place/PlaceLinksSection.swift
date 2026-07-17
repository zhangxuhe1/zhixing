import SafariServices
import SwiftUI

/// 地点抽屉「网友攻略」分栏:管理员维护的外部平台链接列表。
/// 自足式 tab(与 StoriesSection/PhotoWallSection 同构):自己请求 /places/{id} 取 links,
/// LoadState 保证失败可见可重试——失败 ≠ 空态,无链接才进空态。
/// iOS 用 SFSafariViewController 应用内打开;Catalyst 交给系统默认浏览器。
struct PlaceLinksSection: View {
    let placeId: String

    @State private var state: LoadState<[PlaceLink]> = .loading
    @State private var safariURL: URL?

    var body: some View {
        LoadStateView(state: state, retry: { Task { await load() } }) { links in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if links.isEmpty {
                        ZXSectionEmptyState(
                            icon: "link",
                            eyebrow: "网友攻略",
                            title: "攻略还在收集中",
                            message: "我们会陆续为这里挑选值得一看的网友攻略与带玩视频。")
                    }
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
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task { await load() }
        #if !targetEnvironment(macCatalyst)
        .sheet(item: Binding(
            get: { safariURL.map(SafariItem.init) },
            set: { if $0 == nil { safariURL = nil } }
        )) { item in
            SafariView(url: item.url).ignoresSafeArea().appStores()
        }
        #endif
    }

    private func load() async {
        state = .loading
        do {
            // 复用地点详情接口:links 字段可选容错,旧服务端/缓存缺字段时按空处理
            let detail: PlaceDetail = try await APIClient.shared.get("/places/\(placeId)")
            state = .loaded(detail.links ?? [])
        } catch {
            state = .failed("网友攻略加载失败，请重试")
        }
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
