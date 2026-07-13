import SwiftUI

struct SearchSheet: View {
    var prompt = "搜地名，直达那里"
    var onPick: (Pin) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var state: LoadState<[Pin]> = .idle

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .idle:
                    VStack {
                        Spacer()
                        ZXEmptyState(
                            icon: "magnifyingglass",
                            title: "找一个想去的地方",
                            message: "输入省、市、古镇或街区名称，按回车直达地图。")
                        Spacer()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                default:
                LoadStateView(state: state, retry: { Task { await search() } }) { pins in
                    if pins.isEmpty {
                        ZXEmptyState(
                            icon: "map",
                            title: "暂时没有找到「\(query)」",
                            message: "这次搜索已经记下，会成为后续补充地点与风物内容的线索。")
                    } else {
                        List {
                            ForEach(pins) { pin in
                                Button { onPick(pin) } label: {
                                    HStack(spacing: 13) {
                                        Image(systemName: pin.cardCount > 0 ? "mappin.and.ellipse" : "mappin")
                                            .foregroundStyle(pin.cardCount > 0 ? ZXTheme.pine : .secondary)
                                            .frame(width: 28, height: 28)
                                            .background(ZXTheme.jade.opacity(0.09), in: Circle())
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(pin.name).font(.headline)
                                            Text(pin.cardCount > 0 ? "\(pin.cardCount) 张风物卡" : "地点已收录，内容待补")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "arrow.up.left")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                    .padding(.vertical, 5)
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(.primary)
                            }
                        }
                        .listStyle(.insetGrouped)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            }
            .zxCanvasBackground()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: prompt)
            .onChange(of: query) { state = .idle } // 编辑即复位：未提交的新输入不沿用旧搜索的空态/结果
            .onSubmit(of: .search) { Task { await search() } }
            .navigationTitle("去哪里看看？")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
        }
    }

    private func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              let q = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return }
        state = .loading
        do {
            let pins: [Pin] = try await APIClient.shared.get("/search?q=\(q)")
            state = .loaded(pins)
        } catch {
            state = .failed("搜索失败，请重试")
        }
    }
}
