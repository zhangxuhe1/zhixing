import SwiftUI

/// 我的 · 收藏列表：展示 FavoritesStore.items（服务端按收藏时间倒序返回，客户端不重排）。
/// 行点击先取完整卡片（GET /cards/:id），成功后再推入 CardDetailView。
struct FavoritesScreen: View {
    @Environment(FavoritesStore.self) private var store
    @State private var state: LoadState<[FavoriteItem]> = .idle
    @State private var openingCardId: String?
    @State private var openError: String?
    @State private var openErrorToken = 0
    @State private var selectedCard: Card?

    var body: some View {
        // content 闭包故意忽略传入的快照参数、改读 store.items：toggle() 乐观更新后 items 会实时变化，
        // 列表要跟着增减，而不是停在 load() 那一刻的静态快照（与 MyMapScreen 读 store.litPlaceIds 同构）。
        LoadStateView(state: state, retry: { Task { await load() } }) { _ in
            if store.items.isEmpty {
                emptyState
            } else {
                List(store.items) { item in
                    Button {
                        Task { await openCard(item) }
                    } label: {
                        FavoriteRow(item: item, isOpening: openingCardId == item.cardId)
                    }
                    .buttonStyle(.plain)
                    .disabled(openingCardId != nil)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(ZXTheme.canvas)
                .safeAreaInset(edge: .bottom) {
                    if let openError {
                        Text(openError)
                            .font(.footnote).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity)
                            .background(.red, in: RoundedRectangle(cornerRadius: 10))
                            .padding([.horizontal, .bottom], 8)
                    }
                }
                .animation(.default, value: openError)
            }
        }
        .navigationTitle("收藏")
        .zxCanvasBackground()
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selectedCard) { CardDetailView(card: $0) }
        .task { await load() }
    }

    private var emptyState: some View {
        ZXEmptyState(
            icon: "bookmark",
            title: "还没有收藏风物",
            message: "行前收藏几张卡，这里就会成为这趟旅行的文化功课清单。")
        .frame(maxWidth: .infinity)
    }

    private func load() async {
        state = .loading
        do {
            try await store.load()
            state = .loaded(store.items)
        } catch {
            state = .failed("收藏加载失败，请重试")
        }
    }

    /// 行点击自取完整卡片；失败态复用 StoriesSection 的"短暂错误条+token 防串扰"模式，
    /// 不额外加专门的重试按钮——再次点该行本身就是重试路径。
    private func openCard(_ item: FavoriteItem) async {
        guard openingCardId == nil else { return }
        openingCardId = item.cardId
        openError = nil
        defer { openingCardId = nil }
        do {
            selectedCard = try await APIClient.shared.get("/cards/\(item.cardId)")
        } catch {
            openError = "打开失败，请重试"
            openErrorToken += 1
            let token = openErrorToken
            Task {
                try? await Task.sleep(for: .seconds(2))
                if openErrorToken == token { openError = nil }
            }
        }
    }
}

private struct FavoriteRow: View {
    let item: FavoriteItem
    let isOpening: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ZXCategoryBadge(text: categoryLabel)
                    Spacer()
                    Text(item.favoritedAt, format: .dateTime.year().month().day())
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(item.title).font(.headline)
                Text(item.placeName).font(.subheadline).foregroundStyle(.secondary)
            }
            if isOpening {
                Spacer(minLength: 8)
                ProgressView().controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private var categoryLabel: String { Card.categoryLabels[item.category] ?? item.category }
}
