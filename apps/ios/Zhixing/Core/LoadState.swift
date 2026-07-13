import SwiftUI

/// 统一异步加载状态机：idle（未开始）→ loading（进行中）→ loaded(Value) 或 failed(可读错误文案)。
/// Value 需 Sendable——状态要跨 Task 边界写回 @MainActor 隔离的 @State。
enum LoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    /// 仅 loaded 态返回内容；其余（含 failed）一律 nil——调用方不应把"取不到值"误当空数据（失败 ≠ 空态）。
    var value: Value? {
        if case let .loaded(value) = self { return value }
        return nil
    }
}

/// LoadState 到界面的统一映射：loading 转圈；failed 文案+「重试」；loaded 交给业务内容渲染。
/// idle（尚未开始，例如 SearchSheet 编辑中尚未提交搜索）不占位，避免被误读成"正在加载"。
struct LoadStateView<Value: Sendable, Content: View>: View {
    let state: LoadState<Value>
    let retry: () -> Void
    let content: (Value) -> Content

    init(
        state: LoadState<Value>,
        retry: @escaping () -> Void,
        @ViewBuilder content: @escaping (Value) -> Content
    ) {
        self.state = state
        self.retry = retry
        self.content = content
    }

    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case .loading:
            VStack(spacing: 12) {
                ProgressView().tint(ZXTheme.pine)
                Text("正在沿地图寻找…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        case let .failed(message):
            VStack(spacing: 14) {
                ZXEmptyState(
                    icon: "wifi.exclamationmark",
                    title: "这一段路暂时没连上",
                    message: message)
                Button("重试", action: retry)
                    .buttonStyle(ZXSecondaryButtonStyle())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        case let .loaded(value):
            content(value)
        }
    }
}
