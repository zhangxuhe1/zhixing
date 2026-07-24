import SwiftUI

/// 地点抽屉 · 旅人故事 tab：分页展示该地点下公开可见的足迹流。
/// 自己未过审的足迹不会出现在这里——服务端 PUBLICLY_VISIBLE 已过滤，客户端不做特判。
struct StoriesSection: View {
    let placeId: String
    let onComposeFootprint: () -> Void

    @State private var state: LoadState<[Story]> = .loading
    @State private var nextCursor: String?
    @State private var isLoadingMore = false
    @State private var loadMoreFailed = false
    @State private var likingIds: Set<String> = []
    @State private var likeError: String?
    @State private var likeErrorToken = 0
    @State private var selectedStory: Story?

    var body: some View {
        ZStack(alignment: .top) {
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
                            }
                            // 分页 footer：nextCursor 非空时常驻末尾。`.id(nextCursor)` 让每成功翻一页
                            // 都重建 footer——若它仍停留在屏内，onAppear 会再次触发、继续加载下一页
                            //（末行 .onAppear 方案在"行没离开过屏幕"时不会重发，这里用身份重建绕开）。
                            if nextCursor != nil {
                                loadMoreFooter.id(nextCursor)
                            }
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                        .background(ZXTheme.canvas)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .sheet(item: $selectedStory) { story in StoryDetailView(story: story).appStores() }
        .task { await load() }
    }

    /// 正常态：小转圈，出现即触发下一页；失败态：可点重试的文案——第 2 页起的加载失败
    /// 不再静默（浏览打点是全项目唯一允许静默的失败面）。重试点按后 loadMoreFailed 复位，
    /// footer 换回转圈分支；其 onAppear 的重复触发由 loadMore 的 in-flight 守卫吸收。
    private var loadMoreFooter: some View {
        Group {
            if loadMoreFailed {
                Button { Task { await loadMore() } } label: {
                    Text("加载更多失败 · 点按重试")
                        .font(.footnote).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
            } else {
                HStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                    .onAppear { Task { await loadMore() } }
            }
        }
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            ZXSectionEmptyState(
                icon: "quote.bubble",
                eyebrow: "旅人故事",
                title: "等待第一位讲述者",
                message: "这里还没有公开的旅人故事。你可以把一次抵达、一段记忆，留给后来的人。")
            Button(action: onComposeFootprint) {
                Label("留下第一段故事", systemImage: "square.and.pencil")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ZXSecondaryButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    private func load() async {
        state = .loading
        loadMoreFailed = false
        do {
            let page: StoriesPage = try await APIClient.shared.get("/places/\(placeId)/stories")
            state = .loaded(page.items)
            nextCursor = page.nextCursor
        } catch {
            state = .failed("旅人故事加载失败，请重试")
        }
    }

    /// in-flight 保护（isLoadingMore）+ 游标耗尽保护（nextCursor 为 nil 即不再请求）：
    /// footer 的 onAppear 在滚动抖动/分支切换下可能重复触发，两道守卫共同保证同一页不会被并发/重复请求。
    private func loadMore() async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        guard let encodedCursor = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return }
        isLoadingMore = true
        loadMoreFailed = false
        defer { isLoadingMore = false }
        do {
            let page: StoriesPage = try await APIClient.shared.get(
                "/places/\(placeId)/stories?cursor=\(encodedCursor)")
            guard var stories = state.value else { return }
            // 服务端对失效游标不回 404 而是反探测地回退返回第一页（public.ts 设计如此），
            // 此时整页都是已有内容——按已有 id 去重后再追加，防 ForEach 撞重复 id。
            let existing = Set(stories.map(\.id))
            stories.append(contentsOf: page.items.filter { !existing.contains($0.id) })
            state = .loaded(stories)
            nextCursor = page.nextCursor
        } catch {
            // 翻页失败可见可重试：footer 换成「加载更多失败 · 点按重试」；已加载内容保留，nextCursor 不动。
            loadMoreFailed = true
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
                Label(story.authorNickname, systemImage: "person.crop.circle.fill")
                    .font(.headline)
                    .foregroundStyle(ZXTheme.accent)
                Spacer()
                Text(story.date, format: .dateTime.year().month().day()
                    .locale(Locale(identifier: "zh_Hans_CN")))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let text = story.text, !text.isEmpty {
                Text(text).font(.subheadline).lineLimit(3)
            }
            if !story.photos.isEmpty {
                ZXPhotoThumbRow(photoIds: story.photos.map(\.id))
            }
            HStack(spacing: 4) {
                Button(action: onToggleLike) {
                    Image(systemName: story.likedByMe ? "heart.fill" : "heart")
                        .foregroundStyle(story.likedByMe ? ZXTheme.cinnabar : .secondary)
                }
                .buttonStyle(.plain)
                Text("\(story.likeCount)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
