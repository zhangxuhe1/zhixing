import PhotosUI
import SwiftUI

/// 公开确认弹层文案：撰写器首次公开、编辑器由私密转公开共用同一套措辞（对齐 §5.1 隐私提醒基调）。
enum PublicityConfirmationCopy {
    static let title = "公开这条足迹？"
    static let message = "公开后其他旅人可见。请留意照片中的人脸、车牌、门牌等隐私信息。"
}

/// 从 MeScreen 行点击进入：编辑文字/日期/公开开关。
/// PATCH 请求体只携带真正发生变更的字段——尤其 visibility：开关没动就绝不回传（服务端行为地雷，见 FootprintStore.update）。
struct FootprintEditor: View {
    let footprint: Footprint
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    @State private var text: String
    @State private var date: Date
    @State private var isPublic: Bool
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var pendingConfirmation: PendingConfirmation?
    /// 照片分区的事务式草稿：编辑期间所有增删排只落草稿，保存时按差量分段提交（spec §4）。
    @State private var draft: FootprintPhotoDraft
    @State private var pickerItems: [PhotosPickerItem] = []
    /// 保存后有坏图被跳过时的点名文案（镜像 Composer：非 nil 弹「部分照片未能上传」，点「好」才 dismiss）。
    @State private var skipSummary: String?

    init(footprint: Footprint) {
        self.footprint = footprint
        _text = State(initialValue: footprint.text ?? "")
        _date = State(initialValue: footprint.date)
        _isPublic = State(initialValue: footprint.visibility == "PUBLIC")
        _draft = State(initialValue: FootprintPhotoDraft(original: footprint.photos))
    }

    private enum PendingConfirmation: Identifiable, Equatable {
        case makePublic
        case reReview
        case delete

        var id: Self { self }
        var title: String {
            switch self {
            case .makePublic: PublicityConfirmationCopy.title
            case .reReview: "修改后将重新审核"
            case .delete: "删除这条足迹？"
            }
        }

        var message: String {
            switch self {
            case .makePublic: PublicityConfirmationCopy.message
            case .reReview: "这条足迹已公开展示；保存改动后将重新进入审核，通过前其他旅人暂时看不到它。"
            case .delete: "删除后无法恢复，足迹中的照片也会一并删除。"
            }
        }
    }

    /// 本次保存相对原始足迹的差异：三个字段各自独立判断"是否变更"，未变更一律不进入请求体。
    private struct Diff {
        let text: String??
        let date: Date?
        let visibility: String?
        let turningPublic: Bool
        let needsReReviewWarning: Bool
        var hasChanges: Bool { text != nil || date != nil || visibility != nil }
    }

    private var diff: Diff {
        let originalText = footprint.text ?? ""
        let newText: String?? = text == originalText ? nil : (text.isEmpty ? .some(nil) : .some(text))
        let newDate: Date? = date == footprint.date ? nil : date

        let originalIsPublic = footprint.visibility == "PUBLIC"
        let newVisibility: String? = isPublic == originalIsPublic ? nil : (isPublic ? "PUBLIC" : "PRIVATE")

        let turningPublic = newVisibility == "PUBLIC"
        // 重审宽松策略（spec §3/§4）：照片侧只有「新增」引入了未经审核的新内容才算内容变更；
        // 删图是既有已审内容的收缩、排序只是重排，服务端都不会因此重排队审核——不得误报重审提示。
        let contentChanged = newText != nil || newDate != nil || !draft.pendingAdditions.isEmpty
        // 服务端只在"未显式转私密"时才会因内容变更重排队已公开(APPROVED)的足迹；
        // 若同时转 PRIVATE，服务端只改 visibility、不动 reviewStatus——此时不应误报重审提示。
        let needsReReviewWarning = footprint.publishBadge == .published && contentChanged && newVisibility != "PRIVATE"

        return Diff(text: newText, date: newDate, visibility: newVisibility,
                    turningPublic: turningPublic, needsReReviewWarning: needsReReviewWarning)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("地点") { Text(footprint.place.name) }
                Section("照片") { photoSection }
                Section("这一刻") {
                    TextField("写点什么（可选）", text: $text, axis: .vertical)
                        .lineLimit(4 ... 8)
                    DatePicker("日期", selection: $date, displayedComponents: .date)
                }
                Section("公开") {
                    Toggle("公开这条足迹", isOn: $isPublic)
                    if let badge = footprint.publishBadge {
                        HStack {
                            Text("当前状态")
                            Spacer()
                            PublishBadgeLabel(badge: badge)
                        }
                    }
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red).font(.footnote)
                }
                Section {
                    Button("删除足迹", role: .destructive) {
                        pendingConfirmation = .delete
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            // 保存链路多个 await 悬挂点期间草稿不得被篡改：③ 迭代的是快照、④ 实时读取
            // reorderNeeded/finalPhotoIds,中途增删排会与服务端集合脱节——整个 Form 锁死。
            .disabled(saving)
            .navigationTitle("编辑足迹")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("保存") { attemptSave() }
                            .disabled(!hasAnyChanges)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .alert(
            pendingConfirmation?.title ?? "",
            isPresented: Binding(
                get: { pendingConfirmation != nil },
                set: { if !$0 { pendingConfirmation = nil } }
            )
        ) {
            Button("再想想", role: .cancel) {}
            if pendingConfirmation == .delete {
                Button("删除足迹", role: .destructive) { Task { await performDelete() } }
            } else {
                Button("确认") { Task { await performSave() } }
            }
        } message: {
            Text(pendingConfirmation?.message ?? "")
        }
        // 有照片被跳过时不静默 dismiss——用户需要先看到点名哪几张失败了，点「好」才关闭编辑器
        // （此时字段与其余照片改动其实都已保存成功，跳过的只是坏图本身，不是整体失败；镜像 Composer）。
        .alert("部分照片未能上传", isPresented: Binding(
            get: { skipSummary != nil },
            set: { if !$0 { skipSummary = nil } }
        ), presenting: skipSummary) { _ in
            Button("好") { dismiss() }
        } message: { message in
            Text(message)
        }
        .onChange(of: pickerItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            Task {
                var skipped = 0
                for item in newItems {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        draft.append(LocalPhotoDraft(id: UUID(), data: data))
                    } else {
                        skipped += 1 // 本地读不出字节：跳过继续，不整队卡死（Composer 先例）
                    }
                }
                pickerItems = []
                if skipped > 0 {
                    errorMessage = "有 \(skipped) 张照片无法读取，已跳过"
                }
            }
        }
    }

    /// 保存按钮启用条件：字段 diff 或照片草稿任一有变更。
    private var hasAnyChanges: Bool { diff.hasChanges || draft.hasChanges }

    private func attemptSave() {
        let d = diff
        guard hasAnyChanges else { return }
        if d.turningPublic {
            pendingConfirmation = .makePublic
        } else if d.needsReReviewWarning {
            pendingConfirmation = .reReview
        } else {
            Task { await performSave() }
        }
    }

    /// 保存序列（spec §4）：哪步 throw 就停在哪步——errorMessage 展示、编辑器留在原地；
    /// 草稿的进度固化（markRemoved / markUploaded / markSkipped）保证重试不重复已成步骤。
    private func performSave() async {
        let d = diff
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            // ① 字段 diff 非空才 PATCH（该步无草稿固化，但重试时重传同一 diff 幂等无害）。
            if d.hasChanges {
                _ = try await store.update(id: footprint.id, text: d.text, date: d.date, visibility: d.visibility)
            }
            // ② 删除必须先于 ③ 上传：满 9 张时「删旧补新」要靠先删才能过服务端的 9 张上限。
            for id in draft.pendingRemovals {
                try await store.deletePhoto(id: id)
                draft.markRemoved(id: id) // 进度固化：失败重试不再重复 DELETE
            }
            // ③ 逐张上传；坏图（解不出图片）跳过并记 1-based 序号（镜像 Composer 的跳过语义），
            //    其他错误（如网络失败）不捕获，上抛停链——该张仍留在草稿里供重试。
            var skippedIndices: [Int] = []
            for (index, local) in draft.pendingAdditions.enumerated() {
                do {
                    let meta = try await store.uploadPhoto(
                        footprintId: footprint.id, imageData: local.data, sanitized: false)
                    draft.markUploaded(draftId: local.id, meta: meta)
                } catch is PhotoTranscodeError {
                    draft.markSkipped(draftId: local.id)
                    skippedIndices.append(index + 1)
                }
            }
            // ④ 顺序偏离「删/增后的自然序」才发 PUT；entries 仍有 local 时 finalPhotoIds 为 nil，禁发。
            if draft.reorderNeeded, let photoIds = draft.finalPhotoIds {
                try await store.reorderPhotos(footprintId: footprint.id, photoIds: photoIds)
            }
            // ⑤ 网络原语都不动本地 footprints 数组——末尾统一刷新（Composer 先例）。
            await store.load()
            if skippedIndices.isEmpty {
                dismiss()
            } else {
                let list = skippedIndices.map(String.init).joined(separator: "、")
                skipSummary = "已跳过 \(skippedIndices.count) 张无法处理的照片（第 \(list) 张），其余改动已保存。"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performDelete() async {
        saving = true
        defer { saving = false }
        do {
            try await store.delete(footprint)
            dismiss()
        } catch {
            errorMessage = "删除失败：\(error.localizedDescription)"
        }
    }

    // MARK: - 照片分区（3 列宫格：删除 / 设为封面 / 拖拽排序 / 补传）

    private static let gridColumns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 3)

    private var photoSection: some View {
        LazyVGrid(columns: Self.gridColumns, spacing: 4) {
            // 身份绑 entry.id（拖拽重排后 offset 身份会错乱复用视图，严禁绑 offset）；
            // index 只作 dropDestination 的落点下标用。
            ForEach(Array(draft.entries.enumerated()), id: \.element.id) { index, entry in
                photoCell(entry: entry, index: index)
            }
            if draft.remainingQuota > 0 {
                addCell
            }
        }
        .padding(.vertical, 4)
    }

    private func photoCell(entry: PhotoDraftEntry, index: Int) -> some View {
        // 方图的尺寸权威必须是外框而非图本身：scaledToFill 的图对 W×W 提案上报覆盖尺寸，
        // 直接 .aspectRatio(1, .fit) 只变换提案、clipped 在超大边界上等于没裁——
        // Color.clear 按格宽上报方形提案、图作 overlay、溢出才真正被裁（PhotoWallSection 踩坑约定）。
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { cellPhoto(entry) }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .bottomTrailing) {
                if case .local = entry { pendingUploadBadge }
            }
            .overlay(alignment: .topTrailing) { removeBadge(id: entry.id) }
            .contextMenu {
                Button("设为封面") { draft.moveToFront(id: entry.id) }
                Button("删除", role: .destructive) { draft.remove(id: entry.id) }
            }
            .draggable(entry.id)
            // 拖拽落点坐标约定：draft.move 是「先摘除再插入」，toIndex 取的是摘除后坐标系的下标。
            // 直接传本格现序下标 index 时：从后往前拖（from > index）摘除不影响 index；
            // 从前往后拖（from < index）目标格摘除后左移一位，插到 index 恰好占据目标格原来的
            // 视觉槽位——两个方向都等价于「被拖照片落到目标格的槽位」。
            // 这与 SwiftUI onMove 的 pre-removal toOffset 约定不同，勿混用。
            .dropDestination(for: String.self) { ids, _ in
                // 保存期间显式拒收落点：.disabled 对拖放手势的拦截不可依赖,补一道硬闸。
                guard !saving, let id = ids.first, id != entry.id else { return false }
                draft.move(id: id, toIndex: index)
                return true
            }
    }

    @ViewBuilder
    private func cellPhoto(_ entry: PhotoDraftEntry) -> some View {
        switch entry {
        case .remote(let meta):
            AuthedPhotoView(photoId: meta.id)
        case .local(let local):
            if let image = UIImage(data: local.data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Rectangle().fill(.quaternary)
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
            }
        }
    }

    /// 本地草稿的「待上传」角标：保存前用户能一眼分清哪些还没在服务器上。
    private var pendingUploadBadge: some View {
        Text("待上传")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(.white)
            .background(.black.opacity(0.45), in: Capsule())
            .padding(4)
    }

    /// 右上 ✕ 删除角标：本任务两端常显；Catalyst 悬停显隐在 Task 8 收窄。
    private func removeBadge(id: String) -> some View {
        Button {
            draft.remove(id: id)
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 18))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.55))
                .padding(4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("删除照片")
    }

    @ViewBuilder
    private var addCell: some View {
        #if !targetEnvironment(macCatalyst)
        PhotosPicker(
            selection: $pickerItems,
            maxSelectionCount: draft.remainingQuota,
            // 有序模式在相册缩略图右上角显示数字徽标，顺带说明追加顺序（Composer 先例）。
            selectionBehavior: .ordered,
            matching: .images
        ) {
            PhotoAddCellLabel()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("添加照片")
        #else
        // Catalyst 的系统图库必须从窗口根层呈现（Composer 先例），Task 8 接 onChoosePhotos；
        // 本任务先渲染不可点的占位，避免 Catalyst 上出现按了没反应的死按钮假象。
        PhotoAddCellLabel().opacity(0.4)
        #endif
    }
}

/// "+"格标签：虚线圆角框加号。独立 View 而非行内闭包——PhotosPicker 的 label 闭包
/// 被推断为 @Sendable，行内引用 @State 会触发 Swift 6 隔离告警（Composer 同款绕法）。
private struct PhotoAddCellLabel: View {
    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5]))
                    .foregroundStyle(.tertiary)
            }
            .overlay {
                Image(systemName: "plus")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
    }
}

/// 足迹公开状态徽标：胶囊样式，颜色按 PublishBadge 三态区分。MeScreen 行内与本编辑器共用。
struct PublishBadgeLabel: View {
    let badge: PublishBadge

    var body: some View {
        Text(badge.rawValue)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .foregroundStyle(.white)
            .background(tint, in: Capsule())
    }

    private var tint: Color {
        switch badge {
        case .pending: ZXTheme.oldGold
        case .rejected: ZXTheme.cinnabar
        case .published: ZXTheme.jade
        }
    }
}
