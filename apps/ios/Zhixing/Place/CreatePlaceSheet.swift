import SwiftUI

/// 用户申请新地点:坐标来自长按点/当前位置,表单只填名称。
/// 成功回传 Pin(status=PENDING),由地图层刷新 pins 并直接进入足迹撰写。
struct CreatePlaceSheet: View {
    let lat: Double
    let lng: Double
    var onCreated: (Pin) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("新地点") {
                    TextField("地点名称（必填）", text: $name)
                    LabeledContent("坐标", value: String(format: "%.4f, %.4f", lat, lng))
                }
                Section {
                    Text("提交后由管理员审核；审核通过前仅自己可见，足迹照记不误。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .disabled(saving)
            .navigationTitle("创建新地点")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("提交") { Task { await submit() } }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
    }

    private struct RequestBody: Encodable {
        let name: String
        let lat: Double
        let lng: Double
    }

    private func submit() async {
        saving = true
        defer { saving = false }
        do {
            let pin: Pin = try await APIClient.shared.post(
                "/places",
                json: RequestBody(
                    name: name.trimmingCharacters(in: .whitespaces),
                    lat: lat,
                    lng: lng))
            onCreated(pin)
            dismiss()
        } catch let APIError.status(code, body) {
            error = Self.errorCopy(code: code, body: body)
        } catch {
            self.error = "提交失败，请重试"
        }
    }

    /// 服务端错误码 → 用户文案(与 apps/api routes/places.ts 的错误码一一对应)
    static func errorCopy(code: Int, body: String) -> String {
        if code == 409, body.contains("place_exists") {
            return "已有同名地点，回到地图搜索它直接留足迹吧"
        }
        if code == 403 { return "新地点申请暂未开放" }
        if code == 429 { return "今天创建的地点有点多了，明天再来吧" }
        return "提交失败，请重试"
    }
}
