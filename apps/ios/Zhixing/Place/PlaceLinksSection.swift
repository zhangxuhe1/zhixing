import SafariServices
import SwiftUI

/// 地点抽屉「网友分享」分栏:管理员维护的外部平台链接列表。
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
                            eyebrow: "网友分享",
                            title: "分享还在收集中",
                            message: "我们会陆续为这里挑选值得一看的旅行记录与实用攻略。")
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
                                // 内容标签 chip:jade 淡底 + accent 前景(与 ZXCategoryBadge 同调)——
                                // 有色但仍比 cinnabar 平台徽章安静一级,不做第二处红色强调
                                if let tag = link.tag {
                                    Text(tag)
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 8).padding(.vertical, 3)
                                        .foregroundStyle(ZXTheme.accent)
                                        .background(ZXTheme.jade.opacity(0.13), in: Capsule())
                                        .overlay { Capsule().stroke(ZXTheme.jade.opacity(0.18), lineWidth: 1) }
                                }
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
            state = .failed("网友分享加载失败，请重试")
        }
    }

    private func open(_ link: PlaceLink) {
        // 打开前 trim:容错旧缓存里带首尾空白的存量 URL(服务端已入口 trim + migration 清洗)
        let trimmed = link.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "https" else { return }
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
