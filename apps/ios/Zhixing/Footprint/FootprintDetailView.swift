import PhotosUI
import SwiftUI

/// 私密足迹详情：完整正文 + 全部照片的"读"路径，从「最近足迹」/「地点足迹」行点击推入。
/// 零新增请求——Footprint 模型已带全量字段；渲染优先取 FootprintStore 中同 id 的实时值，
/// 编辑保存后随 store.update 就地替换自动刷新；编辑弹层里删除足迹后等弹层收起再退栈
///（串行接手，同 PhotoWallSection.pendingStoryTarget 惯例——sheet 收起与导航 pop 不同帧竞争）。
/// Catalyst 下编辑器全部表单状态提升到本视图（MapScreen↔Composer 先例）：选图舞步要关闭
/// 编辑器 sheet 再开全窗图库，@State 留在 sheet 内会随视图销毁丢草稿。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
struct FootprintDetailView: View {
    let footprint: Footprint
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    @State private var showEditor = false
    @State private var browseStart: BrowseStart?
    #if targetEnvironment(macCatalyst)
    @State private var editorText = ""
    @State private var editorDate = Date()
    @State private var editorIsPublic = false
    @State private var editorError: String?
    @State private var editorDraft = FootprintPhotoDraft(original: [])
    /// 编辑器保存中标志（提升，Composer 状态提升同款）：舞步装载 Task 可与重开后的保存并发，
    /// 本视图的装载回调要靠它拒收保存期间迟到的 append（错过上传快照即丢图）。
    @State private var editorSaving = false
    @State private var editorPickerItems: [PhotosPickerItem] = []
    @State private var showEditorPhotoPicker = false
    /// 点"+"时刻的 draft.remainingQuota 快照：sheet 关闭期间 draft 不变，快照即权威上限。
    @State private var editorPickerLimit = ZXLimit.footprintPhotos
    @State private var restoreEditorAfterPhotoPicker = false
    #endif

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
                Button("编辑") {
                    #if targetEnvironment(macCatalyst)
                    beginEditorDraft()
                    #endif
                    showEditor = true
                }
            }
        }
        .sheet(isPresented: $showEditor, onDismiss: handleEditorDismissed) {
            editorContent
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
        #if targetEnvironment(macCatalyst)
        // 选择器挂在详情页根层，而不是编辑器的小 sheet 内；PhotosUI 因而能使用完整窗口
        //（MapScreen↔Composer 舞步先例）。
        .photosPicker(
            isPresented: $showEditorPhotoPicker,
            selection: $editorPickerItems,
            maxSelectionCount: editorPickerLimit,
            selectionBehavior: .ordered,
            matching: .images
        )
        .photosPickerStyle(.presentation)
        .onChange(of: showEditorPhotoPicker) { wasPresented, isPresented in
            // 图库收起且 restore flag 立着：重开编辑器 sheet（草稿都在本视图，原样接续）。
            guard wasPresented, !isPresented, restoreEditorAfterPhotoPicker else { return }
            restoreEditorAfterPhotoPicker = false
            showEditor = true
        }
        .onChange(of: editorPickerItems) { _, newItems in
            // 装载逻辑放 detail 侧：编辑器 sheet 关闭期间 picker 返回也能落进草稿，重开即见。
            guard !newItems.isEmpty else { return }
            Task {
                var skipped = 0
                for item in newItems {
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        skipped += 1 // 本地读不出字节：跳过继续，不整队卡死（Composer 先例）
                        continue
                    }
                    // 编辑器 sheet 重开后保存可与本 Task 并发（iCloud 装载迟到数秒）：保存期间
                    // 落 append 会错过上传快照、成功 dismiss 即丢图——与编辑器内联装载同一道闸。
                    guard !editorSaving else {
                        skipped += 1
                        continue
                    }
                    editorDraft.append(LocalPhotoDraft(id: UUID(), data: data))
                }
                editorPickerItems = []
                if skipped > 0 {
                    editorError = "有 \(skipped) 张照片无法读取，已跳过"
                }
            }
        }
        #endif
    }

    /// 编辑器内容：Catalyst 注入提升状态的 Binding（Composer 先例），iOS 保持自持 @State。
    @ViewBuilder
    private var editorContent: some View {
        #if targetEnvironment(macCatalyst)
        FootprintEditor(
            footprint: current,
            text: $editorText,
            date: $editorDate,
            isPublic: $editorIsPublic,
            draft: $editorDraft,
            error: $editorError,
            saving: $editorSaving,
            onChoosePhotos: requestEditorPhotoPicker
        )
        #else
        FootprintEditor(footprint: current)
        #endif
    }

    private func handleEditorDismissed() {
        #if targetEnvironment(macCatalyst)
        if restoreEditorAfterPhotoPicker {
            // PhotosPicker 与普通 sheet 不能同时由同一根视图可靠呈现；等小窗完全收起后再开图库。
            showEditorPhotoPicker = true
        } else {
            // 正常关闭（保存成功/取消）：重置全部提升状态，避免下次打开残留（Composer 先例）。
            resetEditorDraft()
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    /// 点"编辑"时按 store 实时值播种全部提升状态（Composer beginComposerDraft 先例）。
    private func beginEditorDraft() {
        let fp = current
        editorText = fp.text ?? ""
        editorDate = fp.date
        editorIsPublic = fp.visibility == "PUBLIC"
        editorError = nil
        editorDraft = FootprintPhotoDraft(original: fp.photos)
        editorSaving = false
        editorPickerItems = []
        showEditorPhotoPicker = false
        editorPickerLimit = ZXLimit.footprintPhotos
        restoreEditorAfterPhotoPicker = false
    }

    /// 正常关闭后清空提升状态：本地照片字节别驻留内存，下次打开由 beginEditorDraft 重新播种。
    private func resetEditorDraft() {
        editorText = ""
        editorDate = Date()
        editorIsPublic = false
        editorError = nil
        editorDraft = FootprintPhotoDraft(original: [])
        editorSaving = false
        editorPickerItems = []
        showEditorPhotoPicker = false
        editorPickerLimit = ZXLimit.footprintPhotos
        restoreEditorAfterPhotoPicker = false
    }

    /// 编辑器"+"格的回调：记录本次可选上限、立 restore flag、关编辑器 sheet；
    /// 图库的实际呈现放在 handleEditorDismissed（sheet 完全收起后），镜像 MapScreen 舞步。
    private func requestEditorPhotoPicker(limit: Int) {
        guard !showEditorPhotoPicker else { return }
        editorPickerLimit = limit
        restoreEditorAfterPhotoPicker = true
        showEditor = false
    }
    #endif

    /// 全屏浏览起点：下标装箱成 Identifiable 供 .fullScreenCover(item:) 使用（同 PhotoWallSection.BrowseSession）。
    private struct BrowseStart: Identifiable {
        let index: Int
        var id: Int { index }
    }
}
