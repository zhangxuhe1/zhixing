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
        ZStack {
            ZXTheme.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("一 方 风 物")
                        .font(.caption.weight(.semibold))
                        .tracking(3)
                        .foregroundStyle(ZXTheme.cinnabar)

                    HStack(spacing: 8) {
                        ZXCategoryBadge(text: card.categoryLabel)
                    if card.isAIGenerated {
                        Label("AI 整理·待复核", systemImage: "sparkles")
                                .font(.caption).foregroundStyle(ZXTheme.oldGold)
                        }
                    }

                    Text(card.title)
                        .font(.system(size: 34, weight: .bold, design: .serif))
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 10) {
                        Rectangle().fill(ZXTheme.oldGold.opacity(0.50)).frame(height: 1)
                        Circle().fill(ZXTheme.cinnabar).frame(width: 6, height: 6)
                        Rectangle().fill(ZXTheme.oldGold.opacity(0.50)).frame(height: 1)
                    }

                    ForEach(card.blocks) { block in
                        if block.type == "TEXT", let text = block.text {
                            Text(text)
                                .font(.system(.body, design: .serif))
                                .lineSpacing(9)
                                .foregroundStyle(.primary.opacity(0.90))
                                .textSelection(.enabled)
                        } else if block.type == "IMAGE", let value = block.mediaUrl,
                                  let url = URL(string: value) {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case let .success(image):
                                    image.resizable().scaledToFill()
                                case .failure:
                                    ZStack {
                                        ZXTheme.jade.opacity(0.08)
                                        Image(systemName: "photo")
                                            .font(.title2)
                                            .foregroundStyle(.secondary)
                                    }
                                default:
                                    ZStack {
                                        ZXTheme.jade.opacity(0.08)
                                        ProgressView().tint(ZXTheme.pine)
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 360)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .accessibilityLabel("风物卡配图")
                        }
                    }

                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 9) {
                            ForEach(card.sources, id: \.self) { source in
                                Label(source, systemImage: "book.closed")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 10)
                    } label: {
                        Label("参考来源", systemImage: "books.vertical")
                            .font(.subheadline.weight(.semibold))
                    }
                    .zxSurface(radius: 16, padding: 16)

                    Button { showReportSheet = true } label: {
                        Label("内容有误？告诉我们", systemImage: "exclamationmark.bubble")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 720, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 30)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await toggleFavorite() }
                } label: {
                    Image(systemName: isFavorited ? "bookmark.fill" : "bookmark")
                        .foregroundStyle(isFavorited ? ZXTheme.cinnabar : ZXTheme.pine)
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
                .appStores()
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
