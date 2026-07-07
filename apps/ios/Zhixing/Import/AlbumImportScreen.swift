import SwiftUI

struct AlbumImportScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store
    @State private var model = AlbumImportModel()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("相册导入")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { dismiss() }.disabled(isImporting)
                    }
                }
        }
        .interactiveDismissDisabled(isImporting)
        .task {
            let pins: [Pin] = (try? await APIClient.shared.get("/places/pins")) ?? []
            await model.scan(pins: pins)
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .scanning:
            ProgressView("正在按地点整理你的照片…")
        case .denied:
            ContentUnavailableView(
                "需要相册权限", systemImage: "photo.badge.exclamationmark",
                description: Text("去 设置 > 知行 里允许访问照片，即可一键点亮历年足迹"))
        case .review:
            reviewList
        case let .importing(done, total):
            VStack(spacing: 16) {
                ProgressView(value: Double(done), total: Double(max(total, 1)))
                    .padding(.horizontal, 40)
                Text("正在点亮 \(done + 1)/\(total)…")
            }
        case let .finished(created, photos):
            VStack(spacing: 14) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 52)).foregroundStyle(.green)
                Text("点亮了 \(created) 段足迹、\(photos) 张照片").font(.headline)
                Text("去「我的足迹地图」看看这些年走过的地方").foregroundStyle(.secondary)
                Button("完成") { dismiss() }.buttonStyle(.borderedProminent)
            }
        }
    }

    private var reviewList: some View {
        List {
            Section {
                Text("按地点聚好了 \(model.groups.count) 组旅程，勾选后一键入库（默认仅自己可见）"
                     + (model.unmatchedCount > 0 ? "；另有 \(model.unmatchedCount) 张照片不在已收录地点附近，先跳过" : ""))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach($model.groups) { $group in
                Toggle(isOn: $group.include) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.pin.name).font(.headline)
                        Text("\(group.assets.count) 张照片 · \(group.start.formatted(date: .abbreviated, time: .omitted))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Button {
                    Task { await model.runImport(store: store) }
                } label: {
                    Text("导入所选").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.groups.allSatisfy { !$0.include })
            }
        }
    }

    private var isImporting: Bool {
        if case .importing = model.phase { return true }
        return false
    }
}
