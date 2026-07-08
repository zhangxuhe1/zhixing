import SwiftUI

/// 地点抽屉 · 旅人故事 tab：分页展示该地点下公开可见的足迹流。
/// 自己未过审的足迹不会出现在这里——服务端 PUBLICLY_VISIBLE 已过滤，客户端不做特判。
struct StoriesSection: View {
    let placeId: String
    let onComposeFootprint: () -> Void

    @State private var state: LoadState<[Story]> = .idle
    @State private var nextCursor: String?
    @State private var isLoadingMore = false
    @State private var likingIds: Set<String> = []
    @State private var likeError: String?
    @State private var likeErrorToken = 0
    @State private var selectedStory: Story?

    var body: some View {
        LoadStateView(state: state, retry: { Task { await load() } }) { stories in
            Group {
                if stories.isEmpty {
                    emptyState
                } else {
                    List {
                        ForEach(stories) { story in
                            StoryRow(story: story, onToggleLike: { Task { await toggleLike(story) } })
                                .contentShape(Rectangle())
                                .onTapGesture { selectedStory = story }
                                .onAppear {
                                    if story.id == stories.last?.id { Task { await loadMore() } }
                                }
                        }
                    }
                    .listStyle(.plain)
                    .safeAreaInset(edge: .bottom) {
                        if let likeError {
                            Text(likeError)
                                .font(.footnote).foregroundStyle(.white)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .frame(maxWidth: .infinity)
                                .background(.red, in: RoundedRectangle(cornerRadius: 10))
                                .padding([.horizontal, .bottom], 8)
                        }
                    }
                    .animation(.default, value: likeError)
                }
            }
        }
        .sheet(item: $selectedStory) { story in StoryDetailView(story: story) }
        .task { await load() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Text("还没有旅人在此留下公开足迹")
                .foregroundStyle(.secondary)
            Button("留下第一条", action: onComposeFootprint)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    private func load() async {
        state = .loading
        do {
            let page: StoriesPage = try await APIClient.shared.get("/places/\(placeId)/stories")
            state = .loaded(page.items)
            nextCursor = page.nextCursor
        } catch {
            state = .failed("旅人故事加载失败，请重试")
        }
    }

    /// in-flight 保护（isLoadingMore）+ 游标耗尽保护（nextCursor 为 nil 即不再请求）：
    /// 末行 `.onAppear` 在滚动抖动下可能重复触发，两道守卫共同保证同一页不会被并发/重复请求。
    private func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        guard let encodedCursor = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page: StoriesPage = try await APIClient.shared.get(
                "/places/\(placeId)/stories?cursor=\(encodedCursor)")
            guard var stories = state.value else { return }
            stories.append(contentsOf: page.items)
            state = .loaded(stories)
            nextCursor = page.nextCursor
        } catch {
            // 翻页失败：保留已加载内容，静默放弃本次追加；nextCursor 未清空，用户可再次触发重试。
        }
    }

    /// 乐观更新：立即在本地数组里翻转 likedByMe/±1；请求失败则整行回滚到 original 并短暂提示错误条。
    private func toggleLike(_ story: Story) async {
        guard !likingIds.contains(story.id) else { return }
        likingIds.insert(story.id)
        defer { likingIds.remove(story.id) }

        guard var stories = state.value, let index = stories.firstIndex(where: { $0.id == story.id })
        else { return }
        let original = stories[index]
        let optimistic = Story(
            footprintId: original.footprintId, text: original.text, date: original.date,
            authorNickname: original.authorNickname,
            likeCount: original.likeCount + (original.likedByMe ? -1 : 1),
            viewCount: original.viewCount,
            likedByMe: !original.likedByMe,
            photos: original.photos)
        stories[index] = optimistic
        state = .loaded(stories)

        do {
            if optimistic.likedByMe {
                try await APIClient.shared.put("/footprints/\(story.id)/like")
            } else {
                try await APIClient.shared.delete("/footprints/\(story.id)/like")
            }
        } catch {
            if var rollback = state.value, let rollbackIndex = rollback.firstIndex(where: { $0.id == story.id }) {
                rollback[rollbackIndex] = original
                state = .loaded(rollback)
            }
            likeError = "操作失败，请重试"
            // token 防止多条并发失败时，先失败的延时清空任务把后失败的错误条提前抹掉。
            likeErrorToken += 1
            let token = likeErrorToken
            Task {
                try? await Task.sleep(for: .seconds(2))
                if likeErrorToken == token { likeError = nil }
            }
        }
    }
}

private struct StoryRow: View {
    let story: Story
    let onToggleLike: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(story.authorNickname).font(.headline)
                Spacer()
                Text(story.date, format: .dateTime.year().month().day()
                    .locale(Locale(identifier: "zh_Hans_CN")))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let text = story.text, !text.isEmpty {
                Text(text).font(.subheadline).lineLimit(3)
            }
            if !story.photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(story.photos) { photo in
                            AuthedPhotoView(photoId: photo.id)
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Button(action: onToggleLike) {
                    Image(systemName: story.likedByMe ? "heart.fill" : "heart")
                        .foregroundStyle(story.likedByMe ? .red : .secondary)
                }
                .buttonStyle(.plain)
                Text("\(story.likeCount)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
