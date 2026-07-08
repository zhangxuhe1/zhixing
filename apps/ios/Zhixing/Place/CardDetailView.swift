import SwiftUI

struct CardDetailView: View {
    let card: Card
    @Environment(FavoritesStore.self) private var favorites
    @State private var isTogglingFavorite = false
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
        await favorites.toggle(cardId: card.id)
    }
}
