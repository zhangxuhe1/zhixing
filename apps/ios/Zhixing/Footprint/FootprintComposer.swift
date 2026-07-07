import PhotosUI
import SwiftUI

struct FootprintComposer: View {
    let pin: Pin
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store
    @State private var text = ""
    @State private var date = Date()
    @State private var items: [PhotosPickerItem] = []
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
                        Button("保存") { Task { await save() } }
                            .disabled(text.isEmpty && items.isEmpty)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
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
                    placeId: pin.id, text: text.isEmpty ? nil : text, date: date)
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
