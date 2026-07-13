import SwiftUI

struct MyMapScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store
    @Environment(PinsCache.self) private var pinsCache
    @State private var pinsState: LoadState<[Pin]> = .idle
    @State private var flyTo: Pin?
    @State private var fitPlaceIds: Set<String>?
    @State private var selectedPin: Pin?
    @State private var showImport = false

    var body: some View {
        ZStack {
            LoadStateView(state: pinsState, retry: { Task { await loadPins(force: true) } }) { pins in
                MapView(pins: pins, litPlaceIds: store.litPlaceIds,
                        showHumanities: false, showFootprints: true,
                        flyTo: $flyTo, fitPlaceIds: $fitPlaceIds,
                        onSelect: { selectedPin = $0 })
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityLabel("我的足迹地图")
            }

            if pinsState.value != nil {
                mapOverlays
            }
        }
        // idle 对应 EmptyView，MapView 本身也没有固有尺寸；必须由稳定的满屏容器承接，
        // 否则 Catalyst 的 NavigationSplitView → NavigationStack 目标页会整体坍缩成零尺寸。
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ZXTheme.canvas)
        .navigationTitle("我的足迹地图")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // 先让地图尽快出现，再刷新本人数据。用户可能刚从地图页新增过足迹，
            // FootprintStore 的 stats 仍是上一次快照；进入个人地图时主动收敛到服务端最新状态。
            await loadPins()
            await store.load()
        }
        .onChange(of: store.litPlaceIds) { _, ids in
            guard !ids.isEmpty else { return }
            fitPlaceIds = ids
        }
        .sheet(item: $selectedPin) { pin in
            FootprintPlaceSheet(pin: pin)
                .appStores()
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showImport) {
            AlbumImportScreen().appStores()
        }
    }

    @ViewBuilder
    private var mapOverlays: some View {
        if store.footprints.isEmpty {
            emptyState
        } else {
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    MyMapSummaryCard(stats: store.stats, footprints: store.footprints)
                    Spacer(minLength: 72)
                }
                Spacer()
                HStack(alignment: .bottom) {
                    Label("已点亮 \(store.litPlaceIds.count) 个地方", systemImage: "mappin.and.ellipse")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(ZXTheme.pine)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(.regularMaterial, in: Capsule())
                        .overlay { Capsule().stroke(Color.white.opacity(0.48), lineWidth: 1) }
                    Spacer()
                    Button { fitPlaceIds = store.litPlaceIds } label: {
                        Image(systemName: "scope")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ZXTheme.pine)
                    .background(.regularMaterial, in: Circle())
                    .overlay { Circle().stroke(Color.white.opacity(0.48), lineWidth: 1) }
                    .shadow(color: ZXTheme.ink.opacity(0.14), radius: 12, y: 5)
                    .accessibilityLabel("显示全部足迹")
                    .help("显示全部足迹")
                }
            }
            .padding(16)
            .allowsHitTesting(true)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            ZXEmptyState(
                icon: "map.fill",
                title: "地图还在等你的第一段足迹",
                message: "从相册导入过去的旅行，或回到故事地图留下一段故事。")
            Button { showImport = true } label: {
                Label("从相册点亮过去的旅行", systemImage: "photo.stack.fill")
            }
            .buttonStyle(ZXPrimaryButtonStyle())
            Button("返回我的知行") { dismiss() }
                .buttonStyle(ZXSecondaryButtonStyle())
        }
        .padding(24)
        .frame(maxWidth: 460)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.48), lineWidth: 1)
        }
        .shadow(color: ZXTheme.ink.opacity(0.15), radius: 24, y: 10)
        .padding(24)
    }

    private func loadPins(force: Bool = false) async {
        pinsState = .loading
        do {
            try await pinsCache.load(force: force) // 命中缓存（MapScreen 已经拉过）时不重发网络请求
            pinsState = .loaded(pinsCache.pins)
            if !store.litPlaceIds.isEmpty {
                fitPlaceIds = store.litPlaceIds
            }
        } catch {
            pinsState = .failed("加载地图数据失败，请重试")
        }
    }
}

private struct MyMapSummaryCard: View {
    let stats: Stats?
    let footprints: [Footprint]

    private var placeCount: Int { Set(footprints.map(\.placeId)).count }

    /// 足迹和地点可以由当前列表精确计算；城市/省份依赖服务端层级统计。
    /// 如果 stats 与列表不是同一版本，宁可暂时显示占位，也不展示彼此矛盾的数字。
    private var currentHierarchyStats: Stats? {
        guard stats?.footprints == footprints.count, stats?.places == placeCount else { return nil }
        return stats
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "figure.walk")
                    .foregroundStyle(ZXTheme.cinnabar)
                Text("我的足迹")
                    .font(.system(.headline, design: .serif, weight: .semibold))
            }
            HStack(spacing: 0) {
                stat(footprints.count, "足迹")
                Divider().frame(height: 30)
                stat(placeCount, "地点")
                Divider().frame(height: 30)
                stat(currentHierarchyStats?.cities, "城市")
                Divider().frame(height: 30)
                stat(currentHierarchyStats?.provinces, "省份")
            }
        }
        .padding(16)
        .frame(maxWidth: 430)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.52), lineWidth: 1)
        }
        .shadow(color: ZXTheme.ink.opacity(0.14), radius: 16, y: 7)
        .accessibilityElement(children: .contain)
    }

    private func stat(_ value: Int?, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value.map(String.init) ?? "—")
                .font(.system(.title3, design: .rounded, weight: .bold))
                .foregroundStyle(ZXTheme.pine)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 66, maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value.map(String.init) ?? "尚未加载")")
    }
}

private struct FootprintPlaceSheet: View {
    let pin: Pin
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store
    @State private var editingFootprint: Footprint?

    private var footprints: [Footprint] {
        store.footprints.filter { $0.placeId == pin.id }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "mappin.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(ZXTheme.cinnabar)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(pin.name)
                                .font(.system(.title3, design: .serif, weight: .bold))
                            Text("在这里留下了 \(footprints.count) 段足迹")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .listRowBackground(Color.clear)

                Section("足迹") {
                    ForEach(footprints) { footprint in
                        Button { editingFootprint = footprint } label: {
                            FootprintRow(footprint: footprint)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("编辑这段足迹")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .navigationTitle("地点足迹")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .sheet(item: $editingFootprint) { footprint in
                FootprintEditor(footprint: footprint).appStores()
            }
        }
    }
}
