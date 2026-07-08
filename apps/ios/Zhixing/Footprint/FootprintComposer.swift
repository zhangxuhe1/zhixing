import PhotosUI
import SwiftUI

struct FootprintComposer: View {
    let pin: Pin
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store
    @State private var text = ""
    @State private var date = Date()
    @State private var items: [PhotosPickerItem] = []
    @State private var isPublic = false // 默认私密铁律：公开开关默认关
    @State private var showPublicConfirm = false
    @State private var saving = false
    @State private var error: String?
    @State private var createdFootprint: Footprint?

    var body: some View {
        NavigationStack {
            Form {
                Section("地点") { Text(pin.name) }
                Section("照片") {
                    // items.isEmpty/count 先取到局部变量再闭包捕获：PhotosPicker 的 label
                    // 闭包被推断为 @Sendable，直接引用 @State 会触发 Swift 6 隔离告警
                    let itemsEmpty = items.isEmpty
                    let itemsCount = items.count
                    PhotosPicker(selection: $items, maxSelectionCount: 9, matching: .images) {
                        Label(itemsEmpty ? "选择照片（可选）" : "已选 \(itemsCount) 张",
                              systemImage: "photo.on.rectangle")
                    }
                }
                Section("这一刻") {
                    TextField("写点什么（可选）", text: $text, axis: .vertical)
                        .lineLimit(4 ... 8)
                    DatePicker("日期", selection: $date, displayedComponents: .date)
                }
                Section("公开") {
                    // 足迹已创建（照片重试阶段）后锁定开关：此时「保存」只重试上传、不会再改可见性，
                    // 放任可改会静默吞掉用户意图；创建后的公开状态变更走 FootprintEditor。
                    Toggle("公开这条足迹", isOn: $isPublic)
                        .disabled(createdFootprint != nil)
                    if isPublic {
                        Text("提交前会再次确认；审核通过前，其他旅人暂时还看不到它。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }
            .disabled(saving)
            .navigationTitle("留下足迹")
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
                        Button("保存") { handleSaveTap() }
                            .disabled(text.isEmpty && items.isEmpty)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .alert(PublicityConfirmationCopy.title, isPresented: $showPublicConfirm) {
            Button("再想想", role: .cancel) {}
            Button("确认") { Task { await save() } }
        } message: {
            Text(PublicityConfirmationCopy.message)
        }
    }

    /// 足迹一旦创建（createdFootprint 非 nil），后续「保存」只是重试照片上传——不再重复弹隐私确认。
    private func handleSaveTap() {
        if createdFootprint == nil, isPublic {
            showPublicConfirm = true
        } else {
            Task { await save() }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let fp: Footprint
            if let existing = createdFootprint {
                fp = existing
            } else {
                fp = try await store.create(
                    placeId: pin.id, text: text.isEmpty ? nil : text, date: date,
                    visibility: isPublic ? "PUBLIC" : "PRIVATE")
                createdFootprint = fp
            }
            while let item = items.first {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    try await store.uploadPhoto(footprintId: fp.id, imageData: data)
                }
                if !items.isEmpty { items.removeFirst() } // 上传成功或该项不可读才走到这；失败会 throw，项留在队列里供重试
            }
            await store.load()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
