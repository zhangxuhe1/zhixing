import SwiftUI

/// 地点抽屉 · 旅人镜头 tab：按"年·季节"分组的公开足迹照片墙。
/// 分组与组内顺序均由服务端产出（GET /places/:id/photo-wall，按时间倒序，无热度排序，无空组）——
/// 客户端只管渲染，绝不重排、也不再过滤——护栏，规格书 §4.1。
struct PhotoWallSection: View {
    let placeId: String
    let onComposeFootprint: () -> Void

    @State private var state: LoadState<[PhotoWallGroup]> = .loading
    @State private var browseSession: BrowseSession?
    /// 全屏浏览器里点「查看故事」时先记下目标，等浏览器真正从层级消失（onDisappear）后才转成 sheet——
    /// fullScreenCover 与 sheet 是两层独立 modal，同一时刻关一个开另一个在 SwiftUI 下偶发不弹
    /// （M1 台账在案），交给 onDisappear 串行接手可绕开。
    @State private var pendingStoryTarget: StoryTarget?
    @State private var storyTarget: StoryTarget?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    var body: some View {
        ZStack(alignment: .top) {
            LoadStateView(state: state, retry: { Task { await load() } }) { groups in
                if groups.isEmpty {
                    emptyState
                } else {
                    grid(groups)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .fullScreenCover(item: $browseSession) { session in
            ZXPhotoBrowser(
                photoIds: session.photos.map(\.photoId), startIndex: session.startIndex,
                onClose: { browseSession = nil }
            ) { index in
                Button {
                    guard session.photos.indices.contains(index) else { return }
                    pendingStoryTarget = StoryTarget(footprintId: session.photos[index].footprintId)
                    browseSession = nil // 先关全屏浏览；sheet 交给下面 onDisappear 接手
                } label: {
                    Text("查看故事")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
                .padding(.bottom, 8)
                .background(.ultraThinMaterial)
            }
            .onDisappear {
                if let pending = pendingStoryTarget {
                    pendingStoryTarget = nil
                    storyTarget = pending
                }
            }
            .appStores()
        }
        .sheet(item: $storyTarget) { target in
            StoryDetailView(footprintId: target.footprintId)
                .appStores()
        }
        .background(ZXTheme.canvas)
        .task { await load() }
    }

    private func grid(_ groups: [PhotoWallGroup]) -> some View {
        let flat = groups.flatMap(\.photos)
        let entries = offsetEntries(groups)

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
                ForEach(entries) { entry in
                    Section {
                        LazyVGrid(columns: columns, spacing: 2) {
                            ForEach(Array(entry.group.photos.enumerated()), id: \.element.id) { photoOffset, photo in
                                photoCell(photo, flatIndex: entry.startIndex + photoOffset, flat: flat)
                            }
                        }
                    } header: {
                        sectionHeader(entry.group.label)
                    }
                }
            }
        }
    }

    private func photoCell(_ photo: WallPhoto, flatIndex: Int, flat: [WallPhoto]) -> some View {
        Button {
            browseSession = BrowseSession(photos: flat, startIndex: flatIndex)
        } label: {
            // 方图的尺寸权威必须是外框而非 AuthedPhotoView 自身：其 loaded 分支是 scaledToFill，
            // 对 W×W 提案上报的是覆盖尺寸（如 4:3 图 → 1.33W×W）；直接 .aspectRatio(1,.fit) 只变换
            // 提案、上报的仍是子视图的非方尺寸，.clipped() 在已超大的边界上等于没裁（评审修复）。
            // Color.clear 按格宽上报方形提案，图作 overlay，溢出部分才真正被裁掉。
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay { AuthedPhotoView(photoId: photo.photoId) }
                .clipped()
        }
        .buttonStyle(.plain)
    }

    private func sectionHeader(_ label: String) -> some View {
        Text(label)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            ZXSectionEmptyState(
                icon: "camera.viewfinder",
                eyebrow: "旅人镜头",
                title: "等待第一束旅人目光",
                message: "公开并通过审核的足迹照片，会在这里按季节汇成一面时光墙。")
            Button(action: onComposeFootprint) {
                Label("留下第一张照片", systemImage: "camera")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ZXSecondaryButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    /// 给每张照片算出它在"跨组拍平"数组里的全局下标（供全屏浏览器翻页用）：一次线性遍历累加组内
    /// 照片数即可，O(n)；不依赖 photoId 全局唯一去反查，也不对 groups/photos 做任何排序。
    private func offsetEntries(_ groups: [PhotoWallGroup]) -> [GroupEntry] {
        var entries: [GroupEntry] = []
        var offset = 0
        for group in groups {
            entries.append(GroupEntry(group: group, startIndex: offset))
            offset += group.photos.count
        }
        return entries
    }

    private func load() async {
        state = .loading
        do {
            let wall: PhotoWall = try await APIClient.shared.get("/places/\(placeId)/photo-wall")
            state = .loaded(wall.groups)
        } catch {
            state = .failed("旅人镜头加载失败，请重试")
        }
    }

    private struct GroupEntry: Identifiable {
        let group: PhotoWallGroup
        let startIndex: Int
        var id: String { group.id }
    }

    /// 全屏浏览会话：进场时把"跨组拍平"的完整数组和起点下标一次性打包传给浏览器；
    /// state 在浏览期间不会变，这里只是让浏览器不必反过来依赖外层的可变状态。
    private struct BrowseSession: Identifiable {
        let photos: [WallPhoto]
        let startIndex: Int
        var id: Int { startIndex }
    }

    /// 「查看故事」跳转目标：footprintId 装箱成 Identifiable 供 .sheet(item:) 使用。
    private struct StoryTarget: Identifiable {
        let footprintId: String
        var id: String { footprintId }
    }
}
