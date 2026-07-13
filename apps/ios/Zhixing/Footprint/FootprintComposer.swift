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
    @State private var skipSummary: String?

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
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
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
        // 有照片被跳过时不静默 dismiss——用户需要先看到点名哪几张失败了，点「好」才关闭撰写器
        // （此时足迹与其余照片其实都已保存成功，跳过的只是坏图本身，不是整体失败）。
        .alert("部分照片未能上传", isPresented: Binding(
            get: { skipSummary != nil },
            set: { if !$0 { skipSummary = nil } }
        ), presenting: skipSummary) { _ in
            Button("好") { dismiss() }
        } message: { message in
            Text(message)
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
            // 序号按原始选择顺序 1-based 累加，不受中途 removeFirst 影响（items.first 严格按序处理）。
            var skippedIndices: [Int] = []
            var index = 0
            while let item = items.first {
                index += 1
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    skippedIndices.append(index) // 本地读不出字节：跳过，继续下一张，不整队卡死
                    items.removeFirst()
                    continue
                }
                do {
                    // sanitized: false——loadTransferable 给的是用户相册原始文件字节，JPEG 原图
                    // 带 GPS/拍摄时间 EXIF，必须经 uploadPhoto 内的重编码剥离后才能上传（评审修复：
                    // 曾因 isJPEG 直通短暂破坏过这层脱敏）。
                    try await store.uploadPhoto(footprintId: fp.id, imageData: data, sanitized: false)
                    items.removeFirst()
                } catch is PhotoTranscodeError {
                    skippedIndices.append(index) // 字节拿到了但解不出图片：同样跳过
                    items.removeFirst()
                }
                // 其余错误（如网络失败）不在此处捕获，上抛到下面的外层 catch——该项留在队列里供重试。
            }
            await store.load()
            if skippedIndices.isEmpty {
                dismiss()
            } else {
                let list = skippedIndices.map(String.init).joined(separator: "、")
                skipSummary = "已跳过 \(skippedIndices.count) 张无法读取的照片（第 \(list) 张），其余内容已保存。"
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
