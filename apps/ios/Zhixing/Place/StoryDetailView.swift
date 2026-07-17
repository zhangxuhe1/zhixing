import SwiftUI

/// 旅人故事详情：从 StoriesSection 行点击进入时已有完整 Story（init(story:)，不再重新请求一遍）；
/// 旅人镜头照片墙（I5）等只知道 footprintId 的入口用 init(footprintId:) 自取。
struct StoryDetailView: View {
    private let footprintId: String
    @Environment(\.dismiss) private var dismiss
    @State private var state: LoadState<Story>
    @State private var isLiking = false
    @State private var likeError: String?
    @State private var likeErrorToken = 0
    @State private var browseStart: BrowseStart?

    init(story: Story) {
        footprintId = story.footprintId
        _state = State(initialValue: .loaded(story))
    }

    init(footprintId: String) {
        self.footprintId = footprintId
        _state = State(initialValue: .idle)
    }

    var body: some View {
        NavigationStack {
            LoadStateView(state: state, retry: { Task { await load() } }) { story in
                ZStack {
                    ZXTheme.canvas.ignoresSafeArea()
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            Text("旅 人 手 记")
                                .font(.caption.weight(.semibold))
                                .tracking(3)
                                .foregroundStyle(ZXTheme.cinnabar)
                            HStack(spacing: 10) {
                                Image(systemName: "person.crop.circle.fill")
                                    .font(.title2)
                                    .foregroundStyle(ZXTheme.pine)
                                Text(story.authorNickname).font(.headline)
                            Spacer()
                            Text(story.date, format: .dateTime.year().month().day()
                                .locale(Locale(identifier: "zh_Hans_CN")))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if let text = story.text, !text.isEmpty {
                                Text(text)
                                    .font(.system(.body, design: .serif))
                                    .lineSpacing(9)
                                    .textSelection(.enabled)
                        }
                        ZXPhotoGrid(photoIds: story.photos.map(\.photoId)) { browseStart = BrowseStart(index: $0) }
                        Button { Task { await toggleLike(story) } } label: {
                            HStack(spacing: 6) {
                                Image(systemName: story.likedByMe ? "heart.fill" : "heart")
                                        .foregroundStyle(story.likedByMe ? ZXTheme.cinnabar : .secondary)
                                Text("\(story.likeCount)").foregroundStyle(.secondary)
                            }
                                .padding(.horizontal, 13)
                                .padding(.vertical, 9)
                                .background(ZXTheme.surface, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        if let likeError {
                            Text(likeError).font(.footnote).foregroundStyle(.red)
                        }
                    }
                        .frame(maxWidth: 720, alignment: .leading)
                        .padding(.horizontal, 28)
                        .padding(.vertical, 28)
                        .frame(maxWidth: .infinity)
                    }
                }
                .fullScreenCover(item: $browseStart) { start in
                    ZXPhotoBrowser(
                        photoIds: story.photos.map(\.photoId), startIndex: start.index,
                        onClose: { browseStart = nil })
                        .appStores()
                }
            }
            .navigationTitle("旅人故事")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .task {
            // 先打点、再（视情况）自取：自取失败/被取消都不该影响"出现即计浏览"这条独立语义。
            ViewTracker.shared.ping(footprintId: footprintId)
            if state.value == nil { await load() }
        }
    }

    private func load() async {
        state = .loading
        do {
            let story: Story = try await APIClient.shared.get("/stories/\(footprintId)")
            state = .loaded(story)
        } catch {
            state = .failed("故事加载失败，请重试")
        }
    }

    /// 乐观更新 + 失败回滚，语义与 StoriesSection.toggleLike 一致（此处只有单条 Story，无需数组定位）。
    private func toggleLike(_ story: Story) async {
        guard !isLiking else { return }
        isLiking = true
        defer { isLiking = false }

        let optimistic = Story(
            footprintId: story.footprintId, text: story.text, date: story.date,
            authorNickname: story.authorNickname,
            likeCount: story.likeCount + (story.likedByMe ? -1 : 1),
            viewCount: story.viewCount,
            likedByMe: !story.likedByMe,
            photos: story.photos)
        state = .loaded(optimistic)

        do {
            if optimistic.likedByMe {
                try await APIClient.shared.put("/footprints/\(story.footprintId)/like")
            } else {
                try await APIClient.shared.delete("/footprints/\(story.footprintId)/like")
            }
        } catch {
            state = .loaded(story)
            likeError = "操作失败，请重试"
            likeErrorToken += 1
            let token = likeErrorToken
            Task {
                try? await Task.sleep(for: .seconds(2))
                if likeErrorToken == token { likeError = nil }
            }
        }
    }

    /// 全屏浏览起点：下标装箱成 Identifiable 供 .fullScreenCover(item:) 使用
    ///（同 FootprintDetailView.BrowseStart）。
    private struct BrowseStart: Identifiable {
        let index: Int
        var id: Int { index }
    }
}
