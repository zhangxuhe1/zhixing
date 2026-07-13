import SwiftUI

/// 卡片报错入口：CardDetailView 来源折叠区下方触发，提交纯文字反馈。
/// 服务端契约（S5）：`POST /cards/:id/report` body `{ text: 1..500 字 }` → 201 `{ id }`。
struct ReportSheet: View {
    let cardId: String
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var submitting = false
    @State private var errorMessage: String?
    @State private var succeeded = false

    private let maxLength = 500

    var body: some View {
        NavigationStack {
            Group {
                if succeeded {
                    successView
                } else {
                    form
                }
            }
            .zxCanvasBackground()
            .navigationTitle("内容有误？告诉我们")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(submitting)
                }
                if !succeeded {
                    ToolbarItem(placement: .confirmationAction) {
                        if submitting {
                            ProgressView()
                        } else {
                            Button("提交") { Task { await submit() } }
                                .disabled(text.isEmpty)
                        }
                    }
                }
            }
        }
        .interactiveDismissDisabled(submitting)
    }

    private var form: some View {
        Form {
            Section {
                TextEditor(text: $text)
                    .frame(minHeight: 160)
                    // 超出上限即截断到 500；恰好 500 不截断——与服务端 z.string().min(1).max(500) 的
                    // 边界语义一致（500 合法，501 起被截）。
                    .onChange(of: text) { _, newValue in
                        if newValue.count > maxLength {
                            text = String(newValue.prefix(maxLength))
                        }
                    }
                HStack {
                    Spacer()
                    Text("\(text.count)/\(maxLength)")
                        .font(.caption)
                        .foregroundStyle(text.count >= maxLength ? .red : .secondary)
                }
            } footer: {
                Text("请描述具体有误的地方，帮助我们改进这张卡片。")
            }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red).font(.footnote)
            }
        }
        .scrollContentBackground(.hidden)
        .background(ZXTheme.canvas)
        .disabled(submitting)
    }

    private var successView: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(ZXTheme.jade)
            Text("已收到，谢谢指正")
                .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ZXTheme.canvas)
    }

    private struct ReportBody: Encodable { let text: String }
    private struct ReportResponse: Decodable { let id: String }

    private func submit() async {
        submitting = true
        errorMessage = nil
        defer { submitting = false }
        do {
            let _: ReportResponse = try await APIClient.shared.post(
                "/cards/\(cardId)/report", json: ReportBody(text: text))
            succeeded = true
            // 停留片刻展示 toast 文案，再自动关闭；失败则留在表单，错误可见、提交钮恢复可用即是重试入口。
            try? await Task.sleep(for: .seconds(1.4))
            dismiss()
        } catch {
            errorMessage = "提交失败，请重试"
        }
    }
}
