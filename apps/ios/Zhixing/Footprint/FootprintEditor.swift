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

    init(footprint: Footprint) {
        self.footprint = footprint
        _text = State(initialValue: footprint.text ?? "")
        _date = State(initialValue: footprint.date)
        _isPublic = State(initialValue: footprint.visibility == "PUBLIC")
    }

    private enum PendingConfirmation: Identifiable {
        case makePublic
        case reReview

        var id: Self { self }
        var title: String {
            switch self {
            case .makePublic: PublicityConfirmationCopy.title
            case .reReview: "修改后将重新审核"
            }
        }

        var message: String {
            switch self {
            case .makePublic: PublicityConfirmationCopy.message
            case .reReview: "这条足迹已公开展示；保存改动后将重新进入审核，通过前其他旅人暂时看不到它。"
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
        let contentChanged = newText != nil || newDate != nil
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
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
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
                            .disabled(!diff.hasChanges)
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
            Button("确认") { Task { await performSave() } }
        } message: {
            Text(pendingConfirmation?.message ?? "")
        }
    }

    private func attemptSave() {
        let d = diff
        guard d.hasChanges else { return }
        if d.turningPublic {
            pendingConfirmation = .makePublic
        } else if d.needsReReviewWarning {
            pendingConfirmation = .reReview
        } else {
            Task { await performSave() }
        }
    }

    private func performSave() async {
        let d = diff
        saving = true
        defer { saving = false }
        do {
            _ = try await store.update(id: footprint.id, text: d.text, date: d.date, visibility: d.visibility)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
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
