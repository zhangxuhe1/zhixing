import SwiftUI

/// 私密足迹详情：完整正文 + 全部照片的"读"路径，从「最近足迹」/「地点足迹」行点击推入。
/// 零新增请求——Footprint 模型已带全量字段；渲染优先取 FootprintStore 中同 id 的实时值，
/// 编辑保存后随 store.update 就地替换自动刷新；编辑弹层里删除足迹后等弹层收起再退栈
///（串行接手，同 PhotoWallSection.pendingStoryTarget 惯例——sheet 收起与导航 pop 不同帧竞争）。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
struct FootprintDetailView: View {
    let footprint: Footprint
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    @State private var showEditor = false
    @State private var browseStart: BrowseStart?

    /// store 实时值优先；兜底进场快照——本视图只从 store 驱动的列表行进入，正常不会走到兜底。
    private var current: Footprint {
        store.footprints.first { $0.id == footprint.id } ?? footprint
    }

    private var deleted: Bool {
        !store.footprints.contains { $0.id == footprint.id }
    }

    var body: some View {
        ZStack {
            ZXTheme.canvas.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    Text("这 一 刻")
                        .font(.caption.weight(.semibold))
                        .tracking(3)
                        .foregroundStyle(ZXTheme.cinnabar)
                    HStack(spacing: 10) {
                        Image(systemName: "mappin.circle.fill")
                            .font(.title2)
                            .foregroundStyle(ZXTheme.cinnabar)
                        Text(current.place.name).font(.headline)
                        if let badge = current.publishBadge {
                            PublishBadgeLabel(badge: badge)
                        }
                        Spacer()
                        Text(current.date, format: .dateTime.year().month().day()
                            .locale(Locale(identifier: "zh_Hans_CN")))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let text = current.text, !text.isEmpty {
                        Text(text)
                            .font(.system(.body, design: .serif))
                            .lineSpacing(9)
                            .textSelection(.enabled)
                    }
                    if current.publishBadge == .published {
                        Text("获赞 \(current.likeCount) · 浏览 \(current.viewCount)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ZXPhotoGrid(photoIds: current.photos.map(\.id)) { index in
                        zxInstantPresent { browseStart = BrowseStart(index: index) }
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("足迹详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("编辑") { showEditor = true }
            }
        }
        .sheet(isPresented: $showEditor) {
            FootprintEditor(footprint: current)
                .appStores()
                .onDisappear {
                    // 编辑弹层里删了足迹：等弹层真正收起后再退栈，避免 sheet 收起与导航 pop 同帧竞争。
                    if deleted { dismiss() }
                }
        }
        .fullScreenCover(item: $browseStart) { start in
            ZXPhotoBrowser(
                photoIds: current.photos.map(\.id), startIndex: start.index,
                onClose: { zxInstantPresent { browseStart = nil } })
                .appStores()
        }
    }

    /// 全屏浏览起点：下标装箱成 Identifiable 供 .fullScreenCover(item:) 使用（同 PhotoWallSection.BrowseSession）。
    private struct BrowseStart: Identifiable {
        let index: Int
        var id: Int { index }
    }
}
