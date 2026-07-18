import PhotosUI
import SwiftUI

/// 公开确认弹层文案：撰写器首次公开、编辑器由私密转公开共用同一套措辞（对齐 §5.1 隐私提醒基调）。
enum PublicityConfirmationCopy {
    static let title = "公开这条足迹？"
    static let message = "公开后其他旅人可见。请留意照片中的人脸、车牌、门牌等隐私信息。"
}

/// 从 MeScreen 行点击进入：编辑文字/日期/公开开关。
/// PATCH 请求体只携带真正发生变更的字段——尤其 visibility：开关没动就绝不回传（服务端行为地雷，见 FootprintStore.update）。
/// Catalyst 下全部表单状态提升为 Binding（Composer 先例）：选图舞步会关闭本 sheet，
/// @State 留在 sheet 内就会随视图销毁丢草稿——状态由 FootprintDetailView 持有并注入。
struct FootprintEditor: View {
    let footprint: Footprint
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    #if targetEnvironment(macCatalyst)
    @Binding private var text: String
    @Binding private var date: Date
    @Binding private var isPublic: Bool
    @Binding private var errorMessage: String?
    /// 照片分区的事务式草稿：编辑期间所有增删排只落草稿，保存时按差量分段提交（spec §4）。
    @Binding private var draft: FootprintPhotoDraft
    /// 点"+"发起选图舞步（detail 侧关 sheet→开全窗图库→收起重开）；Int 为当前剩余可加张数。
    private let onChoosePhotos: (Int) -> Void
    /// 保存中标志同样提升到 detail 侧：舞步先于保存发起时，装载 Task 可与重开后的保存并发，
    /// detail 侧要靠它拒收保存期间迟到的 append（否则错过 ③ 的上传快照、成功 dismiss 即丢图）。
    @Binding private var saving: Bool
    /// 悬停中的照片格 id：✕ 删除角标仅悬停显现（Mac 原生惯例）。
    @State private var hoveredPhotoId: String?
    #else
    @State private var text: String
    @State private var date: Date
    @State private var isPublic: Bool
    @State private var errorMessage: String?
    /// 照片分区的事务式草稿：编辑期间所有增删排只落草稿，保存时按差量分段提交（spec §4）。
    @State private var draft: FootprintPhotoDraft
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var saving = false
    #endif
    @State private var pendingConfirmation: PendingConfirmation?
    /// 保存后有坏图被跳过时的点名文案（镜像 Composer：非 nil 弹「部分照片未能上传」，点「好」才 dismiss）。
    @State private var skipSummary: String?
    /// 自绘拖拽重排的瞬时手势状态：sheet 关闭即弃，两端都无需提升为 Binding（Catalyst 亦同）。
    @State private var draggingPhotoId: String?
    @State private var dragStartIndex: Int?
    @State private var dragTranslation: CGSize = .zero
    /// LazyVGrid 实测出的方格边长（几何换算的输入；0 = 尚未量到，手势直接拒活）。
    @State private var gridCellSide: CGFloat = 0

    #if targetEnvironment(macCatalyst)
    init(
        footprint: Footprint,
        text: Binding<String>,
        date: Binding<Date>,
        isPublic: Binding<Bool>,
        draft: Binding<FootprintPhotoDraft>,
        error: Binding<String?>,
        saving: Binding<Bool>,
        onChoosePhotos: @escaping (Int) -> Void
    ) {
        self.footprint = footprint
        _text = text
        _date = date
        _isPublic = isPublic
        _draft = draft
        _errorMessage = error
        _saving = saving
        self.onChoosePhotos = onChoosePhotos
    }
    #else
    init(footprint: Footprint) {
        self.footprint = footprint
        _text = State(initialValue: footprint.text ?? "")
        _date = State(initialValue: footprint.date)
        _isPublic = State(initialValue: footprint.visibility == "PUBLIC")
        _draft = State(initialValue: FootprintPhotoDraft(original: footprint.photos))
    }
    #endif

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
        // Catalyst 下选图结果的装载在 FootprintDetailView 侧（sheet 关闭期间 picker 返回也要能装上）。
        #if !targetEnvironment(macCatalyst)
        .onChange(of: pickerItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            Task {
                var skipped = 0
                for item in newItems {
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        skipped += 1 // 本地读不出字节：跳过继续，不整队卡死（Composer 先例）
                        continue
                    }
                    // iCloud 卸载图的装载可迟到数秒，append 落在保存链路 ③ 快照之后会错过上传、
                    // 成功 dismiss 即静默丢图——保存期间装载完成的一律不入草稿，计入跳过明示用户
                    //（取简：不做暂存重放；performSave 里另有 pendingAdditions 兜底双保险）。
                    guard !saving else {
                        skipped += 1
                        continue
                    }
                    draft.append(LocalPhotoDraft(id: UUID(), data: data))
                }
                pickerItems = []
                if skipped > 0 {
                    errorMessage = "有 \(skipped) 张照片无法读取，已跳过"
                }
            }
        }
        #endif
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
            // ② 删除必须先于 ③ 上传：满额时「删旧补新」要靠先删才能过服务端的照片上限。
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
            // ③.5 结构性兜底：若迟到装载还是绕过闸门落进了草稿（append 晚于 ③ 的快照），
            // 这些照片本轮没有上传，静默 dismiss 就是丢图——报错留守编辑器，由用户再次保存补传。
            // 此时 finalPhotoIds 必为 nil（entries 含 local），④ 的 nil 闸同样不会误发 PUT。
            guard draft.pendingAdditions.isEmpty else {
                errorMessage = "有新选的照片尚未上传，请再次保存"
                await store.load() // 已成功的删/传仍要反映到本地列表，不因留守而搁置刷新
                return
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

    /// 宫格几何单源：列数与间距同时喂给 LazyVGrid 和 PhotoGridReorderMath，两处不同源会让落槽换算漂移。
    private static let gridColumnCount = 3
    private static let gridSpacing: CGFloat = 4
    private static let gridColumns = Array(
        repeating: GridItem(.flexible(), spacing: gridSpacing), count: gridColumnCount)

    @ViewBuilder
    private var photoSection: some View {
        LazyVGrid(columns: Self.gridColumns, spacing: Self.gridSpacing) {
            // 身份绑 entry.id（拖拽重排后 offset 身份会错乱复用视图，严禁绑 offset）。
            ForEach(draft.entries) { entry in
                photoCell(entry)
            }
            if draft.remainingQuota > 0 {
                addCell
            }
        }
        .padding(.vertical, 4)
        // 量出方格边长喂给拖拽几何换算：3 列等宽，总宽扣除列间距后均分。
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { updateGridCellSide(width: geo.size.width) }
                    .onChange(of: geo.size.width) { _, width in updateGridCellSide(width: width) }
            }
        )
        // 满额时"+"格不再渲染，必须留一行解释，否则消失会被误读为 bug（走查反馈①）。
        if draft.remainingQuota == 0 {
            Text("照片最多 \(ZXLimit.footprintPhotos) 张，删除后可继续添加")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func photoCell(_ entry: PhotoDraftEntry) -> some View {
        // 方图的尺寸权威必须是外框而非图本身：scaledToFill 的图对 W×W 提案上报覆盖尺寸，
        // 直接 .aspectRatio(1, .fit) 只变换提案、clipped 在超大边界上等于没裁——
        // Color.clear 按格宽上报方形提案、图作 overlay、溢出才真正被裁（PhotoWallSection 踩坑约定）。
        let isDragging = draggingPhotoId == entry.id
        return Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { cellPhoto(entry) }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .bottomTrailing) {
                if case .local = entry { pendingUploadBadge }
            }
            .overlay(alignment: .topTrailing) {
                // Catalyst：✕ 角标悬停显现（Mac 原生惯例，右键 contextMenu 兜底）；iOS 常显。
                #if targetEnvironment(macCatalyst)
                if hoveredPhotoId == entry.id { removeBadge(id: entry.id) }
                #else
                removeBadge(id: entry.id)
                #endif
            }
            #if targetEnvironment(macCatalyst)
            .onHover { hovering in
                if hovering {
                    hoveredPhotoId = entry.id
                } else if hoveredPhotoId == entry.id {
                    hoveredPhotoId = nil
                }
            }
            // 右键菜单仅 Catalyst 保留：iOS 触屏的长按已让位于起拖手势（与长按菜单竞争识别
            // 必然抖动），触屏侧删除靠常显 ✕、设为封面 = 拖到首格。
            .contextMenu {
                Button("设为封面") { draft.moveToFront(id: entry.id) }
                Button("删除", role: .destructive) { draft.remove(id: entry.id) }
            }
            #endif
            // 被拖格的拾起反馈：轻微放大 + 阴影 + 压过邻格；offset 直接取值（不参与 withAnimation），
            // 位移分量即时跟手、槽位补偿分量随重排动画过渡，两相抵消恰好钉在手指下。
            .scaleEffect(isDragging ? 1.05 : 1)
            .shadow(color: .black.opacity(isDragging ? 0.25 : 0), radius: isDragging ? 5 : 0, y: isDragging ? 2 : 0)
            .offset(liftOffset(for: entry))
            .zIndex(isDragging ? 1 : 0)
            .gesture(reorderGesture(for: entry))
    }

    // MARK: - 自绘拖拽重排（几何换算见 PhotoGridReorderMath）

    // 为什么自绘：Transferable 拖放（.draggable/.dropDestination）在 Form(=List) 行内不受
    // SwiftUI 支持——lift 会快照整个 cell、行内落点永不回调（Apple 论坛 730367），只能绕开
    // 系统拖放会话。target 基于手势起点的绝对几何换算，直接就是 draft.move 的最终落位
    // （先摘除再插入，两个拖动方向都落在钳制后的 toIndex）。
    // 已知限制：拖拽中不自动滚动（≤12 张最多 4 行，编辑器窗口通常整宫格可见）。

    #if targetEnvironment(macCatalyst)
    /// Catalyst：按住即拖（Mac 原生惯例；点击拖动不会触发滚动，右键菜单是独立识别器互不干扰）。
    /// minimumDistance 4pt 兜住 ✕ 按钮的点击微位移。
    private func reorderGesture(for entry: PhotoDraftEntry) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { handleDragChanged(entry: entry, translation: $0.translation) }
            .onEnded { _ in endDrag() }
    }
    #else
    /// iOS 触屏：长按 0.25s 起拖（主屏幕重排惯例），快速滑动仍走 Form 滚动。
    private func reorderGesture(for entry: PhotoDraftEntry) -> some Gesture {
        LongPressGesture(minimumDuration: 0.25)
            .sequenced(before: DragGesture(coordinateSpace: .global))
            .onChanged { value in
                guard case .second(true, let drag?) = value else { return }
                handleDragChanged(entry: entry, translation: drag.translation)
            }
            .onEnded { _ in endDrag() }
    }
    #endif

    /// 拖动换算与实时重排。保存期硬闸沿用 Task 7 教训：.disabled 拦不住已在途的手势，
    /// 必须在手势路径里显式拒，否则保存链路 ③/④ 的快照会与草稿脱节。
    private func handleDragChanged(entry: PhotoDraftEntry, translation: CGSize) {
        guard !saving, gridCellSide > 0 else { return }
        if draggingPhotoId != entry.id {
            draggingPhotoId = entry.id
            dragStartIndex = draft.entries.firstIndex { $0.id == entry.id }
        }
        dragTranslation = translation
        guard let startIndex = dragStartIndex,
              let currentIndex = draft.entries.firstIndex(where: { $0.id == entry.id })
        else { return }
        let target = reorderMath.targetIndex(
            startIndex: startIndex, translation: translation, count: draft.entries.count)
        if target != currentIndex {
            withAnimation(.snappy(duration: 0.25)) {
                draft.move(id: entry.id, toIndex: target)
            }
        }
    }

    /// 手势结束统一清场（长按完成但未位移即结束的分支同样走这里）。
    /// 顺序在拖动中已实时落进草稿，无需提交步；带动画清场让被拖格滑回槽位、缩放阴影同步退场。
    private func endDrag() {
        withAnimation(.snappy(duration: 0.25)) {
            draggingPhotoId = nil
            dragStartIndex = nil
            dragTranslation = .zero
        }
    }

    /// 被拖格的实时显示偏移（其余格子恒为 .zero）。
    private func liftOffset(for entry: PhotoDraftEntry) -> CGSize {
        guard draggingPhotoId == entry.id,
              let startIndex = dragStartIndex,
              let currentIndex = draft.entries.firstIndex(where: { $0.id == entry.id })
        else { return .zero }
        return reorderMath.liftOffset(
            startIndex: startIndex, currentIndex: currentIndex, translation: dragTranslation)
    }

    private var reorderMath: PhotoGridReorderMath {
        PhotoGridReorderMath(
            cellSide: gridCellSide, spacing: Self.gridSpacing, columns: Self.gridColumnCount)
    }

    /// 3 列等宽：总宽扣除 (列数−1) 道列间距后均分，量得的边长供几何换算使用。
    private func updateGridCellSide(width: CGFloat) {
        gridCellSide = (width - CGFloat(Self.gridColumnCount - 1) * Self.gridSpacing)
            / CGFloat(Self.gridColumnCount)
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

    /// 右上 ✕ 删除角标：iOS 常显；Catalyst 由 photoCell 的 .onHover 控制显隐。
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
        // Catalyst 的系统图库必须从窗口根层呈现（Composer 先例）：点"+"只回调 onChoosePhotos，
        // 由 FootprintDetailView 记录 limit、关本 sheet、开全窗图库、收起后重开编辑器。
        Button {
            onChoosePhotos(draft.remainingQuota)
        } label: {
            PhotoAddCellLabel()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("添加照片")
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
