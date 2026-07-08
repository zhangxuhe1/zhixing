import SwiftUI

struct CardDetailView: View {
    let card: Card
    @Environment(FavoritesStore.self) private var favorites
    @State private var isTogglingFavorite = false
    @State private var favoriteError: String?
    @State private var favoriteErrorToken = 0
    @State private var showReportSheet = false

    private var isFavorited: Bool { favorites.cardIds.contains(card.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    Text(card.categoryLabel)
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(.teal.opacity(0.15), in: Capsule())
                    if card.isAIGenerated {
                        Label("AI 整理·待复核", systemImage: "sparkles")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                Text(card.title).font(.title2.bold())
                ForEach(card.blocks) { block in
                    if block.type == "TEXT", let text = block.text {
                        Text(text).font(.body).lineSpacing(7)
                    }
                }
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(card.sources, id: \.self) { source in
                            Text("· \(source)").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("参考来源").font(.subheadline)
                }
                Button("内容有误？告诉我们") { showReportSheet = true }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await toggleFavorite() }
                } label: {
                    Image(systemName: isFavorited ? "bookmark.fill" : "bookmark")
                }
                .disabled(isTogglingFavorite)
                .accessibilityLabel(isFavorited ? "取消收藏" : "收藏")
            }
        }
        // 收藏切换失败的短暂错误条（评审修复）：图标乐观回滚之外必须有可见反馈——M2 全局规则
        // 仅允许浏览打点静默。样式/时长/token 防串扰均对齐 StoriesSection 点赞失败的既有先例。
        .safeAreaInset(edge: .bottom) {
            if let favoriteError {
                Text(favoriteError)
                    .font(.footnote).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .background(.red, in: RoundedRectangle(cornerRadius: 10))
                    .padding([.horizontal, .bottom], 8)
            }
        }
        .animation(.default, value: favoriteError)
        .sheet(isPresented: $showReportSheet) {
            ReportSheet(cardId: card.id)
        }
        .task {
            // 冷启动后首次打开任意卡片详情时兜底预热收藏态——FavoritesScreen 未必先被访问过；
            // 已有数据则跳过，避免每次打开卡片都重新拉取（与 AuthedPhotoView"已成功不重拉"同族取舍）。
            if favorites.cardIds.isEmpty {
                try? await favorites.load()
            }
        }
    }

    private func toggleFavorite() async {
        guard !isTogglingFavorite else { return }
        isTogglingFavorite = true
        defer { isTogglingFavorite = false }
        let succeeded = await favorites.toggle(cardId: card.id)
        if !succeeded {
            favoriteError = "操作失败，请重试"
            // token 防串扰：连续多次失败时，先失败的延时清空任务不得提前抹掉后失败的错误条。
            favoriteErrorToken += 1
            let token = favoriteErrorToken
            Task {
                try? await Task.sleep(for: .seconds(2))
                if favoriteErrorToken == token { favoriteError = nil }
            }
        }
    }
}
