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
            .navigationTitle("留下足迹")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
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
            let fp = try await store.create(
                placeId: pin.id, text: text.isEmpty ? nil : text, date: date)
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    try await store.uploadPhoto(footprintId: fp.id, imageData: data)
                }
            }
            await store.load()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
