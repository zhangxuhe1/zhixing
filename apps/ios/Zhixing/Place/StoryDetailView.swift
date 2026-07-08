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
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack {
                            Text(story.authorNickname).font(.headline)
                            Spacer()
                            Text(story.date, format: .dateTime.year().month().day()
                                .locale(Locale(identifier: "zh_Hans_CN")))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if let text = story.text, !text.isEmpty {
                            Text(text).font(.body).lineSpacing(7)
                        }
                        ForEach(story.photos) { photo in
                            AuthedPhotoView(photoId: photo.id)
                                .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 280)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        Button { Task { await toggleLike(story) } } label: {
                            HStack(spacing: 6) {
                                Image(systemName: story.likedByMe ? "heart.fill" : "heart")
                                    .foregroundStyle(story.likedByMe ? .red : .secondary)
                                Text("\(story.likeCount)").foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        if let likeError {
                            Text(likeError).font(.footnote).foregroundStyle(.red)
                        }
                    }
                    .padding(20)
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
}
