import SwiftUI

/// 旅程确认/编辑表单：创建模式（来自 trip-suggestions 建议，成功后 POST /me/trips）与编辑模式
/// （既有 Trip，成功后 PATCH /me/trips/:id 只带增删差集）。
///
/// 成员归属的唯一数据来源是 `FootprintStore.footprints` 的 `tripId` 字段——服务端 TripDTO 本身不下发
/// 成员 id 列表：创建模式的“成员”＝建议自带的 `footprintIds`（此刻这些足迹的 `tripId` 仍是 nil，尚未
/// 落库）；编辑模式的“成员”＝ store 中 `tripId` 等于本 `trip.id` 的那些足迹。
///
/// `removedIds`/`addedIds` 直接记录“本次会话做了什么改动”而非最终成员集合本身——剔除只能作用于
/// baseline 成员、添加只能来自未归属候选池，两者定义域天然不相交，因此“不会 re-add 现成员、不会
/// remove 非成员”是数据结构上的不变量，不需要在保存时额外做“新旧集合相减”来兜底。
struct TripEditScreen: View {
    enum Mode {
        case create(TripSuggestion)
        case edit(Trip)
    }

    let mode: Mode
    /// 保存/删除成功后调用（先于 dismiss）：由父视图 TripsScreen 负责刷新两段列表 + FootprintStore.load()。
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    @State private var title: String
    @State private var removedIds: Set<String> = []
    @State private var addedIds: Set<String> = []
    @State private var addExpanded = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var showDeleteConfirm = false

    init(mode: Mode, onSaved: @escaping () async -> Void) {
        self.mode = mode
        self.onSaved = onSaved
        switch mode {
        case let .create(suggestion):
            _title = State(initialValue: suggestion.suggestedTitle)
        case let .edit(trip):
            _title = State(initialValue: trip.title)
        }
    }

    private var navigationTitleText: String {
        switch mode {
        case .create: "确认旅程"
        case .edit: "编辑旅程"
        }
    }

    /// 创建模式：建议自带的 footprintIds（此刻它们的 tripId 仍是 nil，尚未落库）。
    /// 编辑模式：FootprintStore 中 tripId 等于本 trip 的那些足迹 id。
    private var baselineMemberIds: Set<String> {
        switch mode {
        case let .create(suggestion): Set(suggestion.footprintIds)
        case let .edit(trip): Set(store.footprints.filter { $0.tripId == trip.id }.map(\.id))
        }
    }

    private var memberFootprints: [Footprint] {
        store.footprints.filter { baselineMemberIds.contains($0.id) }.sorted { $0.date < $1.date }
    }

    /// 可添加候选池：未归属（tripId == nil）且不在当前成员列表里——创建模式下建议自带的成员此刻
    /// tripId 也是 nil，必须显式排除，否则同一条足迹会在“成员”和“候选池”里重复出现。
    private var addablePool: [Footprint] {
        store.footprints
            .filter { $0.tripId == nil && !baselineMemberIds.contains($0.id) }
            .sorted { $0.date < $1.date }
    }

    private var effectiveMemberIds: Set<String> {
        baselineMemberIds.subtracting(removedIds).union(addedIds)
    }

    private var titleValid: Bool { (1 ... 60).contains(title.count) }

    /// 创建模式：哪怕原样接受建议（标题、成员都没改）也该能保存——这是最常见的操作路径。
    /// 编辑模式：必须真的发生了改动，否则不该允许一次空操作的 PATCH。
    private var hasChanges: Bool {
        guard case let .edit(trip) = mode else { return true }
        return title != trip.title || !addedIds.isEmpty || !removedIds.isEmpty
    }

    private var canSave: Bool {
        titleValid && !effectiveMemberIds.isEmpty && hasChanges
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("标题") {
                    TextField("旅程标题", text: $title)
                    if !titleValid {
                        Text("标题需 1–60 字").font(.footnote).foregroundStyle(.red)
                    }
                }
                Section("成员足迹") {
                    ForEach(memberFootprints) { fp in
                        Toggle(isOn: memberBinding(for: fp.id)) {
                            memberRowLabel(fp)
                        }
                    }
                    if effectiveMemberIds.isEmpty {
                        Text("至少保留一条足迹").font(.footnote).foregroundStyle(.red)
                    }
                }
                if !addablePool.isEmpty {
                    Section {
                        DisclosureGroup("添加其他足迹", isExpanded: $addExpanded) {
                            ForEach(addablePool) { fp in
                                Toggle(isOn: addBinding(for: fp.id)) {
                                    memberRowLabel(fp)
                                }
                            }
                        }
                    }
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red).font(.footnote)
                }
                if case .edit = mode {
                    Section {
                        Button("删除旅程", role: .destructive) { showDeleteConfirm = true }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .disabled(saving)
            .navigationTitle(navigationTitleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("保存") { Task { await performSave() } }
                            .disabled(!canSave)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .alert("删除这段旅程？", isPresented: $showDeleteConfirm) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await performDelete() } }
        } message: {
            Text("足迹本身不会被删除，只是解除与这段旅程的关联，之后仍能被重新整理成新的旅程。")
        }
    }

    private func memberRowLabel(_ fp: Footprint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(fp.place.name)
            Text(fp.date, format: .dateTime.year().month().day())
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// 成员行勾选态：勾上＝保留，取消＝剔除（拆）。只操作 removedIds，绝不触碰 addedIds——
    /// 即便用户在同一次会话里反复剔除又勾回同一条 baseline 成员，也只是在 removedIds 里增删，
    /// 不会被误判成“新增”。
    private func memberBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { !removedIds.contains(id) },
            set: { included in
                if included { removedIds.remove(id) } else { removedIds.insert(id) }
            })
    }

    /// 候选池行勾选态：勾上＝加入（并），取消＝撤回加入。只操作 addedIds，绝不触碰 removedIds。
    private func addBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { addedIds.contains(id) },
            set: { included in
                if included { addedIds.insert(id) } else { addedIds.remove(id) }
            })
    }

    private struct CreateBody: Encodable {
        let title: String
        let footprintIds: [String]
    }

    private struct PatchBody: Encodable {
        let title: String?
        let addFootprintIds: [String]?
        let removeFootprintIds: [String]?
    }

    private func performSave() async {
        guard canSave else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            switch mode {
            case .create:
                let ids = Array(effectiveMemberIds)
                let _: Trip = try await APIClient.shared.post(
                    "/me/trips", json: CreateBody(title: title, footprintIds: ids))
            case let .edit(trip):
                // 只发实际变化：标题没动就不带该键（避免无意义写入），add/remove 为空同理传 nil。
                let newTitle = title == trip.title ? nil : title
                let adds = addedIds.isEmpty ? nil : Array(addedIds)
                let removes = removedIds.isEmpty ? nil : Array(removedIds)
                let _: Trip = try await APIClient.shared.patch(
                    "/me/trips/\(trip.id)",
                    json: PatchBody(title: newTitle, addFootprintIds: adds, removeFootprintIds: removes))
            }
            await onSaved()
            dismiss()
        } catch {
            errorMessage = "保存失败，请重试"
        }
    }

    private func performDelete() async {
        guard case let .edit(trip) = mode else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            try await APIClient.shared.delete("/me/trips/\(trip.id)")
            await onSaved()
            dismiss()
        } catch {
            errorMessage = "删除失败，请重试"
        }
    }
}
